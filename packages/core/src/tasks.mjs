// Task queue of the bridge. Every "Send" from the overlay becomes a task in .benda/tasks.json; the bridge hands the
// tasks to their agents one at a time, because all agents edit the same working tree.
//   queued      – waiting for its turn
//   waiting     – handed to the Claude terminal session (selection.json "pending"), not picked up yet – needs the watch
//                 mode or a prompt
//   in-progress – the agent works on it
//   done | failed | cancelled
// Tasks for the terminal session travel through selection.json, so the hooks and `benda wait` need no queue of their
// own; headless tasks (session "task" or "shared") go to the runner (run.json). Only the bridge writes tasks.json.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancelRun, listAgents, readRun, startRun } from './agents.mjs';
import { resolveTags, resolveTemplate } from './prompt.mjs';
import { resolveSkills } from './skills.mjs';
import { STATE_DIR, readActivity, readSelection, setStatus, writeSelection } from './lib.mjs';

export const TASKS_FILE = join(STATE_DIR, 'tasks.json');

const KEEP_FINISHED = 30;
const OPEN = new Set(['queued', 'waiting', 'in-progress']);
const ACTIVE = new Set(['waiting', 'in-progress']);

let deferredSelection = null; // a plain selection made while a Claude task owns selection.json

export function readTasks() {
  try {
    const tasks = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}

function writeTasks(tasks) {
  // the oldest finished tasks go first; open ones are never dropped
  let excess = tasks.filter((task) => !OPEN.has(task.status)).length - KEEP_FINISHED;
  const kept = tasks.filter((task) => OPEN.has(task.status) || excess-- <= 0);
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${TASKS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(kept, null, 2));
  renameSync(tmp, TASKS_FILE);
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const now = () => new Date().toISOString();
const claudeOwnsSelection = (tasks) => tasks.some((task) => task.agent === 'claude' && ACTIVE.has(task.status));

function finish(task, status, { summary = task.summary, error = null } = {}) {
  Object.assign(task, { status, summary, error, finishedAt: now() });
}

/** Hands a queued task to its agent. */
function start(task) {
  task.startedAt = now();
  if (task.agent === 'claude') {
    const at = now();
    writeSelection({ id: task.id, status: 'pending', instruction: task.instruction, template: task.template, tags: task.tags, skills: task.skills, subject: task.subject, create: task.create, checks: task.checks, page: task.page, items: task.items, createdAt: at, updatedAt: at });
    task.status = 'waiting';
    return;
  }
  try {
    startRun(task, { id: task.agent, label: task.agentLabel, model: task.model });
    task.status = 'in-progress';
  } catch (err) {
    finish(task, 'failed', { error: err.message });
  }
}

/** Takes over what the agent reported for the active task; true when the task changed. */
function follow(task) {
  const before = JSON.stringify(task);
  if (task.agent === 'claude') {
    const selection = readSelection();
    if (selection?.id !== task.id) finish(task, 'cancelled', { error: 'Replaced in .benda/selection.json' });
    else if (selection.status === 'in-progress') task.status = 'in-progress';
    else if (selection.status === 'done') finish(task, 'done', { summary: selection.summary ?? '' });
    else if (selection.status === 'cleared') finish(task, 'cancelled');
  } else {
    const run = readRun();
    if (run?.id !== task.id) finish(task, 'failed', { error: 'The run was lost' });
    else {
      // the run names the model that really ran, e.g. "Claude Code · Sonnet 5.5" for the alias "sonnet"
      if (run.label) task.agentLabel = run.label;
      if (run.status !== 'in-progress') finish(task, run.status, { summary: run.summary, error: run.error });
    }
  }
  return JSON.stringify(task) !== before;
}

/**
 * Brings tasks.json up to date with the agents and starts the next task when none is active. Called on every change
 * of selection.json or run.json, so it also notices hooks and `benda wait` from other processes.
 */
export function syncTasks() {
  const tasks = readTasks();
  let changed = false;
  for (const task of tasks.filter((t) => ACTIVE.has(t.status))) changed = follow(task) || changed;
  while (!tasks.some((task) => ACTIVE.has(task.status))) {
    const next = tasks.find((task) => task.status === 'queued');
    if (!next) break;
    start(next);
    changed = true;
  }
  if (changed) writeTasks(tasks);
  if (deferredSelection && !claudeOwnsSelection(tasks)) {
    writeSelection(deferredSelection);
    deferredSelection = null;
  }
  return tasks;
}

/** Stores a plain selection (no task) – later, if a Claude task owns selection.json right now. */
export function storeSelection(selection) {
  if (claudeOwnsSelection(readTasks())) deferredSelection = selection;
  else writeSelection(selection);
}

/**
 * `inventory` resolves what the Inventory sends (null without the adapter capability): `subject(id)` the item a
 * task is about, `create(spec)` a building block to create.
 */
export async function addTask(body, enrichItem, inventory = null) {
  const agent = (await listAgents()).find((a) => a.id === body.agent);
  if (!agent) throw new Error(`Unknown agent "${body.agent}"`);
  // no element is fine – the page URL then tells the agent where the task applies
  const items = Array.isArray(body.items) ? body.items.slice(0, 20).map(enrichItem) : [];
  const instruction = String(body.instruction ?? '').trim().slice(0, 4000);
  const template = resolveTemplate(body.template);
  if ((body.subject || body.create) && !inventory) throw new Error('The adapter has no inventory, so a task cannot have a subject');
  // resolved now, so the task keeps what the item looked like when it was sent
  const subject = body.subject ? inventory.subject(String(body.subject.id ?? body.subject)) : null;
  const create = body.create ? inventory.create(body.create) : null;
  // findings of `benda check` to fix, as the Inventory sends them
  const checks = (Array.isArray(body.checks) ? body.checks.slice(0, 50) : []).map((f) => ({
    level: ['error', 'warning', 'info'].includes(f?.level) ? f.level : 'info',
    rule: String(f?.rule ?? ''),
    file: String(f?.file ?? ''),
    line: Number.isInteger(f?.line) ? f.line : null,
    message: String(f?.message ?? ''),
    fix: f?.fix ? String(f.fix) : null,
  }));
  if (!items.length && !instruction && !template && !create && !checks.length) throw new Error('Nothing to do – select an element or describe the change');
  const session = body.session ?? agent.sessions[0];
  if (!agent.sessions.includes(session)) throw new Error(`${agent.label} cannot run in session "${session}"`);
  const tasks = readTasks();
  const task = {
    id: newId(),
    agent: agent.id,
    agentLabel: agent.label,
    model: agent.model,
    session,
    instruction,
    template,
    subject,
    create,
    checks,
    tags: resolveTags(body.tags),
    skills: resolveSkills(body.skills, agent),
    page: body.page ?? {},
    items,
    status: 'queued',
    createdAt: now(),
  };
  const ahead = tasks.filter((t) => OPEN.has(t.status)).length;
  writeTasks([...tasks, task]);
  syncTasks();
  return { task, ahead };
}

function update(id, change) {
  const tasks = readTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`Unknown task "${id}"`);
  change(task, tasks);
  writeTasks(tasks);
  syncTasks();
}

export function cancelTask(id) {
  update(id, (task) => {
    if (task.status === 'queued') finish(task, 'cancelled');
    // Benda cannot stop Claude; it only stops waiting for it, so the queue moves on
    else if (task.agent === 'claude' && ACTIVE.has(task.status)) {
      setStatus('cleared', ['pending', 'in-progress']);
      finish(task, 'cancelled');
    } else if (task.status === 'in-progress') cancelRun('Cancelled');
  });
}

/** Queues a finished task again, as a new task at the end. */
export function retryTask(id) {
  update(id, (task, tasks) => {
    if (OPEN.has(task.status)) throw new Error('The task is still open');
    const { id: _, status, startedAt, finishedAt, summary, error, ...copy } = task;
    tasks.push({ ...copy, id: newId(), status: 'queued', createdAt: now() });
  });
}

export function clearFinished() {
  writeTasks(readTasks().filter((task) => OPEN.has(task.status)));
}

/** What the overlay shows of a task – without the element data. */
export function taskSummary(task) {
  let activity = null;
  if (task.status === 'in-progress') {
    if (task.agent === 'claude') {
      const latest = readActivity();
      activity = latest && latest.at >= task.startedAt ? latest.text : null;
    } else {
      const run = readRun();
      activity = run?.id === task.id ? run.activity : null;
    }
  }
  return {
    id: task.id,
    agent: task.agent,
    agentLabel: task.agentLabel,
    session: task.session ?? (task.agent === 'claude' ? 'terminal' : 'task'),
    instruction: task.instruction,
    template: task.template?.label ?? null,
    tags: (task.tags ?? []).map((tag) => tag.label),
    skills: task.skills ?? [],
    elements: task.items.map((item) => item.element?.tag).filter(Boolean),
    subject: task.subject
      ? { kind: task.subject.kind, name: task.subject.name }
      : task.create
        ? { kind: task.create.kind, name: task.create.name, create: task.create.mode }
        : task.checks?.length
          ? { kind: 'check', name: `${task.checks.length} finding${task.checks.length === 1 ? '' : 's'}` }
          : null,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    summary: task.summary ?? '',
    error: task.error ?? null,
    activity,
  };
}
