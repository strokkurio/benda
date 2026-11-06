// The task queue as the overlay and the Inventory show it: one card per task with status, agent, summary or error,
// cancel and run again. Works on the host's `state.tasks`, which the bridge's SSE stream keeps current.
// Served by the bridge next to overlay.js.
import { elapsed } from './ui.js';

export const OPEN_TASK = new Set(['queued', 'waiting', 'in-progress']);
const TASK_STATE = { queued: 'Queued', waiting: 'Waiting for Claude', 'in-progress': 'Working', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const SESSION_NAME = { terminal: 'terminal', task: 'new session', shared: 'shared' };

/** `emptyText` is what the list says before the first task – each UI explains its own way of making one. */
export function createTasksView({ state, el, request, showToast, agentLabel, harnessOf, emptyText }) {
  const openTasks = () => state.tasks.filter((task) => OPEN_TASK.has(task.status));
  /** The task the agent has: handed to Claude ("waiting") or being worked on. At most one. */
  const activeTask = () => state.tasks.find((task) => task.status === 'waiting' || task.status === 'in-progress');
  const taskAgent = (task) => harnessOf(task.agent);

  async function taskAction(action, id) {
    try {
      await request(`/tasks/${action}`, { id });
    } catch (err) {
      showToast(`${action[0].toUpperCase()}${action.slice(1)} failed: ${err.message}`);
    }
  }

  function taskCard(task, position) {
    const open = OPEN_TASK.has(task.status);
    const title = [task.template, task.instruction.split('\n')[0]].filter(Boolean).join(' · ') || 'Task';
    const count = task.elements.length;
    const when = task.status === 'in-progress' && task.startedAt
      ? `running ${elapsed(task.startedAt)}`
      : new Date(task.finishedAt ?? task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const detail = task.status === 'in-progress' ? task.activity : task.status === 'done' ? task.summary : task.error;
    return el('div', { class: 'item' }, [
      el('div', { class: 'head' }, [
        el('span', { class: 'num', text: position ? String(position) : '✓' }),
        el('b', { class: 'title', text: title, title }),
        el('span', { class: `pill ${task.status}`, text: TASK_STATE[task.status] ?? task.status }),
        el('div', { class: 'actions' }, [
          open
            ? el('button', {
                class: 'icon',
                text: 'Cancel',
                title: task.agent === 'claude' && task.status === 'in-progress'
                  ? 'Stop waiting for Claude and go on with the queue – stop Claude itself in Claude Code (Esc)'
                  : 'Cancel this task',
                onclick: () => taskAction('cancel', task.id),
              })
            : el('button', { class: 'icon', text: '↻', title: 'Run again (queues a copy)', onclick: () => taskAction('retry', task.id) }),
        ]),
      ]),
      ...(task.template && task.instruction ? [el('div', { class: 'body text', text: task.instruction })] : []),
      el('div', { class: 'meta' }, [
        `${(task.agentLabel ?? agentLabel(task.agent)).replace(' (this session)', '')} · ${SESSION_NAME[task.session] ?? ''} · `,
        count ? `${count} element${count === 1 ? '' : 's'} (${task.elements.map((tag) => `<${tag}>`).join(' ')})` : task.subject ? `${task.subject.kind} ${task.subject.name}` : 'page only',
        ...[...(task.skills ?? []).map((name) => `/${name}`), ...(task.tags ?? []).map((label) => `#${label}`)].map((text) => ` · ${text}`),
        ` · ${when}`,
      ]),
      // the card shows three lines; the whole text (an error's details) is in the tooltip
      ...(detail ? [el('div', { class: 'body text', text: detail, title: detail })] : []),
    ]);
  }

  /** The queue in the order the bridge works through it, then the finished tasks, newest first. */
  function tasksPanel() {
    const open = openTasks();
    const finished = state.tasks.filter((task) => !OPEN_TASK.has(task.status)).reverse();
    if (!open.length && !finished.length) return el('div', { class: 'empty', text: emptyText });
    return el('div', { class: 'list' }, [
      el('div', { class: 'row tasks-bar hint' }, [
        el('span', { text: 'Tasks run one after another, in this order.' }),
        ...(finished.length ? [el('button', { class: 'icon', text: 'Clear finished', onclick: () => taskAction('clear') })] : []),
      ]),
      ...open.map((task, i) => taskCard(task, i + 1)),
      ...finished.map((task) => taskCard(task, 0)),
    ]);
  }

  return { openTasks, activeTask, taskAgent, taskAction, taskCard, tasksPanel };
}
