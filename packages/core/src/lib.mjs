// Shared helpers for the Benda bridge, CLI and hooks. Zero dependencies.
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_NAME = 'benda.config.json';
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OVERLAY_DIR = join(PACKAGE_DIR, 'overlay');
export const BIN = join(PACKAGE_DIR, 'bin', 'benda.mjs');

/**
 * The package lives in node_modules, so the project cannot be derived from this file's location. Hooks, `wait` and
 * the bridge may start in a subdirectory: the nearest benda.config.json wins, else the current directory.
 */
function findWorkspace() {
  if (process.env.BENDA_WORKSPACE) return resolve(process.env.BENDA_WORKSPACE);
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_NAME))) return dir;
    if (dirname(dir) === dir) return process.cwd();
  }
}

export const WORKSPACE = findWorkspace();
export const STATE_DIR = join(WORKSPACE, '.benda');
export const SELECTION_FILE = join(STATE_DIR, 'selection.json');
export const HISTORY_FILE = join(STATE_DIR, 'history.jsonl');
export const WATCHER_FILE = join(STATE_DIR, 'watcher.json');
export const ACTIVITY_FILE = join(STATE_DIR, 'activity.json');
export const PROPOSAL_FILE = join(STATE_DIR, 'proposal.json');
export const COMPONENTS_FILE = join(STATE_DIR, 'components.json');
export const CLAUDE_FILE = join(STATE_DIR, 'claude.json');
export const SESSIONS_FILE = join(STATE_DIR, 'sessions.json');

/**
 * Selection lifecycle:
 *   selected    – user picked elements in the browser, the agent has not seen them yet
 *   pending     – the bridge's task queue handed a task (selection + instruction) to Claude
 *   in-progress – the agent received it (prompt hook or `benda wait`)
 *   done        – the agent finished its turn (stop hook)
 *   cleared     – user emptied the selection, or cancelled the task
 * While a Claude task is pending or in progress, the bridge holds back new plain selections (tasks.mjs).
 */
export const DELIVERABLE = new Set(['selected', 'pending']);

export const DEFAULT_PORT = 4399;

/** Read on every use, so edits to benda.config.json apply without restarting the bridge. */
export function readConfig(workspace = WORKSPACE) {
  const defaults = { port: DEFAULT_PORT };
  try {
    return { ...defaults, ...JSON.parse(readFileSync(join(workspace, CONFIG_NAME), 'utf8')) };
  } catch {
    return defaults;
  }
}

/**
 * Identifies the project to the overlay loader: `loadBenda({ name })` must match, so an app never attaches to the
 * bridge of another project that happens to hold the same port.
 */
export function projectName() {
  const { name } = readConfig();
  if (typeof name === 'string' && name) return name;
  try {
    return JSON.parse(readFileSync(join(WORKSPACE, 'package.json'), 'utf8')).name || basename(WORKSPACE);
  } catch {
    return basename(WORKSPACE);
  }
}

/**
 * Every workspace that has started a bridge on this machine, so installers can pick a port no other project uses.
 * Only the paths are kept; the ports are read from each project's benda.config.json, which stays the source of truth.
 * Installers read this file too (the Angular schematic cannot import the core): keep it a plain JSON array of paths.
 */
export const WORKSPACES_FILE = join(homedir(), '.benda', 'workspaces.json');

export function knownWorkspaces() {
  try {
    const list = JSON.parse(readFileSync(WORKSPACES_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((dir) => typeof dir === 'string' && existsSync(join(dir, CONFIG_NAME))) : [];
  } catch {
    return [];
  }
}

/** Records this workspace; returns the other projects configured for `port`. Best effort – a read-only home is fine. */
export function registerWorkspace(port) {
  const others = knownWorkspaces().filter((dir) => resolve(dir) !== WORKSPACE);
  try {
    mkdirSync(dirname(WORKSPACES_FILE), { recursive: true });
    writeFileSync(WORKSPACES_FILE, JSON.stringify([...others, WORKSPACE].sort(), null, 2) + '\n');
  } catch {}
  return others.filter((dir) => Number(readConfig(dir).port) === Number(port));
}

/**
 * Who holds a local port: null when it is free, else `{ workspace }` for a Benda bridge (from its /health) or `{}`
 * for any other process.
 */
export async function portOwner(port) {
  const free = await new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
  if (free) return null;
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).json();
    return typeof health.workspace === 'string' ? { workspace: health.workspace, name: health.name } : {};
  } catch {
    return {};
  }
}

export function describePortOwner(port, owner) {
  if (owner.workspace === WORKSPACE) return `The bridge of this project already runs on port ${port}.`;
  const holder = owner.workspace ? `the Benda bridge of ${owner.workspace}` : 'another process';
  return `Port ${port} is used by ${holder}. Give this project its own port: "port" in ${CONFIG_NAME} and loadBenda({ port }).`;
}

/** `"claude": false` makes a project local-only: no Claude Code entry in the panel, and the hooks do nothing. */
export function claudeEnabled() {
  return readConfig().claude !== false;
}

export function readSelection() {
  try {
    return JSON.parse(readFileSync(SELECTION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSelection(selection) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${SELECTION_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(selection, null, 2));
  renameSync(tmp, SELECTION_FILE);
  appendFileSync(
    HISTORY_FILE,
    JSON.stringify({ at: new Date().toISOString(), id: selection.id, status: selection.status, instruction: selection.instruction || undefined }) + '\n',
  );
}

/**
 * Short label for an agent's tool call as shown in the overlay, e.g. "Editing kpi-card.ts".
 * Covers Claude Code (Read, Edit, …) and OpenCode (read, edit, …) tool names.
 */
export function describeStep(tool = '', input = {}) {
  const file = basename(input.file_path ?? input.filePath ?? input.notebook_path ?? input.path ?? '');
  const short = (text, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  switch (tool.toLowerCase()) {
    case 'read':
      return `Reading ${file}`;
    case 'edit':
    case 'multiedit':
    case 'patch':
    case 'notebookedit':
      return `Editing ${file}`;
    case 'write':
      return `Writing ${file}`;
    case 'bash':
      return short(input.description ?? `Terminal: ${input.command ?? ''}`);
    case 'grep':
    case 'glob':
    case 'list':
      return short(`Searching ${input.pattern ?? file}`);
    case 'webfetch':
    case 'websearch':
      return 'Researching on the web';
    case 'todowrite':
      return 'Planning next steps';
    case 'agent':
    case 'task':
      return 'Delegating to a sub-agent';
    default:
      return null;
  }
}

/** Last step the agent took on the current task – shown live in the overlay. */
export function writeActivity(text) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ACTIVITY_FILE, JSON.stringify({ text, at: new Date().toISOString() }));
}

export function readActivity() {
  try {
    return JSON.parse(readFileSync(ACTIVITY_FILE, 'utf8'));
  } catch {
    return null;
  }
}

const TRANSCRIPT_TAIL = 256 * 1024;

/**
 * Remembers the model of the Claude Code session for "Run with": hooks get no model field, so it comes from the newest
 * main-thread assistant message in the transcript (sub-agents may use another model). Only a hint – errors keep the
 * last known value.
 */
export function noteClaudeModel(transcriptPath) {
  if (!transcriptPath) return;
  try {
    const fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, TRANSCRIPT_TAIL));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    closeSync(fd);
    for (const line of tail.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"assistant"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // the first line of the tail is usually cut
      }
      const model = entry.type === 'assistant' && !entry.isSidechain ? entry.message?.model : null;
      // "<synthetic>" marks messages Claude Code writes itself
      if (!model || model.startsWith('<')) continue;
      if (model !== readClaudeModel()) {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(CLAUDE_FILE, JSON.stringify({ model, at: new Date().toISOString() }));
      }
      return;
    }
  } catch {
    /* no transcript yet */
  }
}

/** Ids of the shared headless sessions, one per harness: { claude, opencode }. */
export function readSessions() {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** null removes the harness's session – its next shared run starts a new one. */
export function writeSession(harness, id) {
  const sessions = { ...readSessions(), [harness]: id ?? undefined };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

export function readClaudeModel() {
  try {
    return JSON.parse(readFileSync(CLAUDE_FILE, 'utf8')).model ?? null;
  } catch {
    return null;
  }
}

/** Mapping proposal an agent submitted for the overlay's Data tab (see `benda proposal`). */
export function readProposal() {
  try {
    return JSON.parse(readFileSync(PROPOSAL_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writeProposal(proposal) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PROPOSAL_FILE, JSON.stringify(proposal, null, 2));
}

/** Component catalog an agent read from the design system's MCP server (see `benda components`). */
export function readComponents() {
  try {
    return JSON.parse(readFileSync(COMPONENTS_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writeComponents(catalog) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(COMPONENTS_FILE, JSON.stringify(catalog, null, 2));
}

/** Registers the current process as watcher (`benda wait`) until it exits. */
export function registerWatcher() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(WATCHER_FILE, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  process.on('exit', () => {
    try {
      if (JSON.parse(readFileSync(WATCHER_FILE, 'utf8')).pid === process.pid) unlinkSync(WATCHER_FILE);
    } catch {
      /* already gone */
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));
}

/** True while a `benda wait` process is alive, i.e. Claude picks up browser tasks immediately. */
export function isWatching() {
  try {
    process.kill(JSON.parse(readFileSync(WATCHER_FILE, 'utf8')).pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `fields` (e.g. the agent's summary) are written together with the status, in one atomic write. */
export function setStatus(status, from, fields = {}) {
  const selection = readSelection();
  if (!selection || (from && !from.includes(selection.status))) return null;
  Object.assign(selection, fields);
  selection.status = status;
  selection.updatedAt = new Date().toISOString();
  writeSelection(selection);
  return selection;
}

export async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}
