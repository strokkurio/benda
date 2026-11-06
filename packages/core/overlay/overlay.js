// Benda overlay – in-browser element picker.
// Served by the bridge and loaded only in dev mode by the framework integration, so it is never part of the app
// bundle. Everything framework-specific (components, noise in the DOM) comes from the adapter, also via the bridge.
//   Alt+Shift+C (⌥⇧C) toggle picking       Click  select element     Shift+Click  add to selection
//   hold ⌥ (macOS)    pick while held
//   ↑ / ↓        parent / back to child while picking             Esc          stop picking / close panel
// The composer, the task list and the shared controls live in their own modules, which the Inventory uses too.
import { createComposer, harnessOf, SESSION_HINT } from './composer.js';
import { createTasksView, OPEN_TASK } from './tasks-view.js';
import { IS_MAC, KEY, UI_STYLES, combo, createRequest, cut, el, elapsed, kbdCombo } from './ui.js';

const BRIDGE = new URL(import.meta.url).origin;
const request = createRequest(BRIDGE);
const { default: adapter } = await import(new URL('./adapter.js', import.meta.url).href);
// Installed before anything else waits on the network: requests the app sends from now on are captured.
const network = await import(new URL('./overlay-network.js', import.meta.url).href)
  .then(({ createNetwork }) => createNetwork({ bridge: BRIDGE, request }))
  .catch((err) => (console.warn('[benda] Network capture unavailable:', err), null));
// Tabs depend on what the adapter supports, e.g. Data needs lineage – known before the first render.
const capabilities = await fetch(`${BRIDGE}/health`).then((res) => res.json()).then((health) => health.capabilities ?? {}, () => ({}));
const STORAGE_KEY = 'benda';
const MAX_ITEMS = 8;

const PICK_SHORTCUT = combo(KEY.alt, KEY.shift, 'C');
const SEND_SHORTCUT = `${combo(KEY.mod, KEY.enter)} / ${combo(KEY.alt, KEY.enter)}`;
// ⌥ alone picks while it is held; another key within this time means the user types ⌥L = @ and the like
const HOLD_MS = 250;
const hold = { timer: null, active: false };
let lastPointer = null; // where the pointer was, so picking by holding ⌥ highlights at once

const state = {
  picking: false,
  hovered: null,
  hoverStack: [],
  items: [], // { el, path, info, source }
  instruction: '',
  job: null, // { id, status } of the plain selection (no task) – Claude may pick it up with the next prompt
  dock: 'right',
  connected: false,
  watching: false, // a `benda wait` process is alive → Claude picks up sent tasks immediately
  since: null, // ISO time the current status was reached (drives the elapsed timer)
  activity: null, // Claude's latest step, e.g. "Editing kpi-card.ts"
  doneAt: 0,
  lastPrompt: '',
  agents: [], // [{ id, label, kind }] from GET /agents – "claude" or "opencode:<model>"
  agent: null, // agent used by "Send"
  session: null, // 'terminal' (the Claude Code session in the user's terminal) | 'task' (new per task) | 'shared'
  modelOf: {}, // harness → headless agent id last chosen for it, so switching back restores the model
  sessionOf: {}, // harness → session last chosen for it
  templates: [], // [{ id, label, text }] from GET /prompt – prompt templates from benda.config.json
  template: null, // template id used by the composer's "Send", none until picked; data-tab tasks never use one
  tagList: [], // [{ id, label, text }] from GET /prompt – offered under "#"
  tags: [], // tag ids picked for the next task
  skillList: [], // [{ name, description, scope }] from GET /skills – what the chosen agent's harness can load, offered under "/"
  skills: [], // skill names picked for the next task
  menu: null, // the open "/" or "#" menu: { kind, start, end, options, index }
  rules: [], // project rules from GET /prompt, shown in the Prompt tab
  note: '', // closing note of every context block, from GET /prompt
  tasks: [], // task queue from the bridge (SSE): { id, agent, agentLabel, instruction, template, elements, status, … }
  view: 'selection', // panel tab: 'selection' | 'tasks' | 'prompt' | 'data' | 'api' | 'components'
};

let apiView = null; // created on first use from overlay-api.js
let dataView = null; // created on first use from overlay-data.js
let componentsView = null; // created on first use from overlay-components.js
let restoreTimer = null; // pending restore of a persisted selection after a reload


// ---------------------------------------------------------------- DOM description

const IGNORED_ATTRS = /^(class|style)$/;
const isHidden = (pattern, name) => Boolean(pattern?.test(name));
const STYLE_KEYS = ['display', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'padding', 'margin', 'gap', 'borderRadius'];

function classesOf(el) {
  return (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c && !isHidden(adapter.hiddenClasses, c));
}

function ownText(el) {
  return [...el.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent.trim())
    .join(' ')
    .trim();
}

function htmlPreview(el) {
  const clone = el.cloneNode(true);
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attr of [...node.attributes]) if (isHidden(adapter.hiddenAttributes, attr.name)) node.removeAttribute(attr.name);
  }
  const html = clone.outerHTML.replace(/<!--[\s\S]*?-->/g, '').replace(/\s{2,}/g, ' ');
  return html.length > 600 ? `${cut(html, 597)}…` : html;
}

function cssPath(el) {
  const parts = [];
  for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id && !/\d{3,}/.test(node.id)) {
      parts.unshift(`${part}#${CSS.escape(node.id)}`);
      break;
    }
    const siblings = [...(node.parentElement?.children ?? [])].filter((s) => s.tagName === node.tagName);
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part);
  }
  return parts.join(' > ');
}

function describe(el) {
  const rect = el.getBoundingClientRect();
  const computed = getComputedStyle(el);
  const attributes = {};
  for (const attr of el.attributes) if (!IGNORED_ATTRS.test(attr.name) && !isHidden(adapter.hiddenAttributes, attr.name)) attributes[attr.name] = cut(attr.value, 120);
  const text = (el.innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return {
    element: {
      tag: el.tagName.toLowerCase(),
      classes: classesOf(el),
      attributes,
      ownText: cut(ownText(el), 120),
      text: text.length > 160 ? `${cut(text, 157)}…` : text,
      html: htmlPreview(el),
      path: cssPath(el),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      styles: Object.fromEntries(STYLE_KEYS.map((k) => [k, computed[k]])),
    },
    component: adapter.component(el),
    owner: adapter.owner(el),
    componentChain: adapter.componentChain(el),
    field: adapter.field?.(el) ?? null,
  };
}

function shortTag(el) {
  const classes = classesOf(el);
  const cls = classes.slice(0, 2).map((c) => `.${c}`).join('');
  return `${el.tagName.toLowerCase()}${cls}${classes.length > 2 ? '…' : ''}`;
}

// ---------------------------------------------------------------- UI

let host, root, hoverBox, hoverLabel, selLayer, toolbar, panel, toast;

const STYLES = `${UI_STYLES}
  /* one stacking context above the app: the z-indexes below only order the overlay's own layers, while the app's
     headers, menus and toasts (often 1000 and more) would otherwise cover them */
  :host { all: initial; position: relative; z-index: 2147483647; }
  * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
  .box { position: fixed; pointer-events: none; z-index: 1; border-radius: 3px; }
  .hover { border: 2px solid #6366f1; background: rgb(99 102 241 / 0.12); transition: all 60ms ease-out; }
  .sel { border: 2px dashed #f59e0b; background: rgb(245 158 11 / 0.08); }
  .sel b { position: absolute; top: -10px; left: -10px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
    background: #f59e0b; color: #1c1917; font: 700 11px/20px ui-sans-serif, system-ui; text-align: center; }
  .label { position: fixed; z-index: 2; pointer-events: none; max-width: 520px; padding: 4px 8px; border-radius: 6px;
    background: #1e1b4b; color: #e0e7ff; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; box-shadow: 0 4px 12px rgb(0 0 0 / 0.25); }
  .label em { color: #a5b4fc; font-style: normal; }
  .label i { color: #94a3b8; font-style: normal; }
  .toolbar { position: fixed; bottom: 16px; z-index: 3; display: flex; align-items: center; gap: 6px; padding: 6px;
    border-radius: 999px; background: #18181b; color: #fafafa; box-shadow: 0 8px 24px rgb(0 0 0 / 0.3); font-size: 13px; }
  .toolbar button { border: 0; border-radius: 999px; padding: 7px 12px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .toolbar button:hover { background: #3f3f46; }
  .toolbar button.on { background: #6366f1; }
  .dot { width: 8px; height: 8px; margin: 0 4px 0 8px; border-radius: 50%; background: #ef4444; }
  .dot.ok { background: #22c55e; }
  .count { display: inline-block; min-width: 20px; margin-left: 6px; padding: 0 6px; border-radius: 10px; background: #f59e0b; color: #1c1917; font-weight: 700; text-align: center; }
  .panel { position: fixed; bottom: 68px; z-index: 3; width: min(600px, calc(100vw - 32px)); height: min(80vh, 760px); display: flex; flex-direction: column;
    border-radius: 14px; background: #fff; color: #18181b; box-shadow: 0 16px 48px rgb(0 0 0 / 0.25); border: 1px solid #e4e4e7; overflow: hidden; font-size: 13px; }
  .panel header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #f4f4f5; font-weight: 600; }
  .panel header div { display: flex; gap: 4px; }
  .chip.failed { color: #fca5a5; }
  .chip.cancelled { color: #a1a1aa; }
  .watch { padding: 0 6px 0 0; color: #a1a1aa; font-size: 12px; white-space: nowrap; }
  .watch.on { color: #86efac; }
  .chip { display: flex; align-items: center; gap: 7px; max-width: 320px; padding: 0 6px 0 2px; font-size: 12px; color: #e4e4e7; white-space: nowrap; }
  .chip span:last-child { overflow: hidden; text-overflow: ellipsis; color: #a1a1aa; }
  .chip.done { color: #86efac; }
  .chip.waiting { color: #fcd34d; }
  .spin { flex: none; width: 10px; height: 10px; border: 2px solid #52525b; border-top-color: #a5b4fc; border-radius: 50%; animation: spin .8s linear infinite; }
  .sel.working { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 50% { background: rgb(245 158 11 / 0.22); border-color: #fbbf24; } }
  @media (prefers-reduced-motion: reduce) { .spin, .sel.working { animation: none; } }
  .toast { position: fixed; top: 16px; z-index: 4; padding: 10px 14px; border-radius: 10px; background: #166534; color: #fff;
    font: 600 13px ui-sans-serif, system-ui; box-shadow: 0 8px 24px rgb(0 0 0 / 0.25); }
  .tabs { display: flex; gap: 2px; }
  .tabs button { border: 0; border-radius: 6px; padding: 4px 10px; background: transparent; color: #71717a; font: 600 13px ui-sans-serif, system-ui; cursor: pointer; }
  .tabs button.on { background: #eef2ff; color: #3730a3; }
  .prompt-hint { padding: 4px 6px 6px; }
  .keys { display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; align-items: center; padding: 4px 6px 8px; color: #3f3f46; font-size: 12px; }
  .keys .combo { white-space: nowrap; color: #71717a; }
`;

const STATUS_TEXT = {
  selected: 'Selection synced. Just tell Claude Code what to change – the selection is attached automatically.',
  pending: 'Task sent. Claude picks it up right away (watch mode).',
  waiting:
    '⚠ Claude is not listening right now. The task is saved and will be attached to your next prompt in Claude Code. ' +
    'Or ask Claude to “start the Benda watch mode” – then this button is enough.',
  done: '✓ Claude is done. The page may have reloaded – please check the result.',
};

function buildUi() {
  host = el('benda-overlay');
  root = host.attachShadow({ mode: 'open' });
  root.append(el('style', { text: STYLES }));
  hoverBox = el('div', { class: 'box hover', hidden: true });
  hoverLabel = el('div', { class: 'label', hidden: true });
  selLayer = el('div');
  toolbar = el('div', { class: 'toolbar' });
  panel = el('section', { class: 'panel', hidden: true, 'aria-label': 'Benda' });
  toast = el('div', { class: 'toast', hidden: true, role: 'status' });
  root.append(selLayer, hoverBox, hoverLabel, panel, toolbar, toast);
  document.documentElement.append(host);
}

const DONE_VISIBLE_MS = 8000;

const composer = createComposer({ state, el, bridge: BRIDGE, request, showToast, render: renderPanel, persist });
const { isClaude, hasClaude, agentLabel, agentName, sendLabel, agentPicker, templatePicker, tokenList, loadPrompt, loadSkills, loadAgents } = composer;
const { openTasks, activeTask, taskAgent, tasksPanel } = createTasksView({
  state, el, request, showToast, agentLabel, harnessOf,
  emptyText: 'No tasks yet. Select elements, describe the change and send it – while the agent works, you can queue more.',
});
const isWorking = () => state.job?.status === 'in-progress' || state.tasks.some((task) => task.status === 'in-progress');

function spinnerChip(title, ...texts) {
  return el('span', { class: 'chip', title }, [el('i', { class: 'spin' }), ...texts.map((text) => el('span', { text }))]);
}

/** Compact live status in the toolbar: the active task, then a selection Claude picked up, else what "Send" will use. */
function statusChip() {
  const task = activeTask();
  const queued = state.tasks.filter((t) => t.status === 'queued').length;
  const more = queued ? ` · +${queued} queued` : '';
  if (task?.status === 'in-progress') {
    const name = taskAgent(task);
    return spinnerChip(`${name} is working on a task`, task.startedAt ? elapsed(task.startedAt) : '', `${name} · ${task.activity ?? 'working …'}${more}`);
  }
  if (task) {
    return state.watching
      ? spinnerChip('', `Handing over …${more}`)
      : el('span', { class: 'chip waiting', title: STATUS_TEXT.waiting, text: `● Waiting for your prompt in Claude Code${more}` });
  }
  const last = state.tasks.filter((t) => t.finishedAt).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).at(-1);
  if (last && Date.now() - Date.parse(last.finishedAt) < DONE_VISIBLE_MS) {
    const name = taskAgent(last);
    const text = { done: `✓ ${name} is done – please check the result`, cancelled: '■ Task cancelled' }[last.status] ?? `✕ ${name} failed`;
    return el('span', { class: `chip ${last.status}`, title: last.error ?? '', text });
  }
  const status = state.job?.status;
  if (status === 'in-progress') {
    return spinnerChip('Claude Code is working on your selection', state.since ? elapsed(state.since) : '', `Claude Code · ${state.activity ?? 'working …'}`);
  }
  if (status === 'done' && Date.now() - state.doneAt < DONE_VISIBLE_MS) {
    return el('span', { class: 'chip done', text: '✓ Done – please check the result' });
  }
  if (!state.agent) return el('span', { class: 'watch' });
  const target = `→ ${agentLabel(state.agent)}`;
  if (!isClaude()) {
    return el('span', { class: 'watch on', title: SESSION_HINT[state.session], text: `${target} · ${state.session === 'shared' ? 'shared' : 'new session'}` });
  }
  return el('span', {
    class: `watch${state.watching ? ' on' : ''}`,
    title: state.watching ? 'Watch mode on: Claude starts sent tasks right away' : 'Watch mode off: tasks reach Claude with your next prompt in Claude Code',
    text: `${target} · ${state.watching ? 'listening' : 'watch off'}`,
  });
}

function renderToolbar() {
  toolbar.replaceChildren(
    el('span', { class: `dot${state.connected ? ' ok' : ''}`, title: state.connected ? 'Bridge connected' : 'Bridge not reachable' }),
    statusChip(),
    el('button', {
      class: state.picking ? 'on' : '',
      title: `Select element (${PICK_SHORTCUT})`,
      onclick: () => setPicking(!state.picking),
    }, [
      state.picking ? '◎ Selecting … (Esc)' : '◎ Select',
      ...(state.items.length ? [el('span', { class: 'count', title: 'Selected elements', text: String(state.items.length) })] : []),
    ]),
    el('button', {
      class: panel.hidden ? '' : 'on',
      title: 'Open/close panel',
      'aria-label': 'Open/close panel',
      'aria-expanded': String(!panel.hidden),
      text: '☰',
      onclick: () => {
        panel.hidden = !panel.hidden;
        renderPanel();
      },
    }),
  );
  const side = state.dock === 'right' ? 'right' : 'left';
  for (const node of [toolbar, panel, toast]) {
    node.style.left = side === 'left' ? '16px' : '';
    node.style.right = side === 'right' ? '16px' : '';
  }
}

function itemMeta(item) {
  const { info, source } = item;
  const meta = el('div', { class: 'meta' });
  const where = info.owner ? `in ${info.owner.name} ‹${info.owner.selector}›` : 'not inside a component';
  meta.append(where);
  if (info.component) meta.append(el('br'), `host of ${info.component.name}`);
  if (source?.templateFile) {
    const line = source.templateHits?.[0]?.line;
    meta.append(el('br'), el('strong', { text: `${source.templateFile}${line ? `:${line}` : ''}` }));
  }
  return meta;
}

/** Status box above the composer: the active task, or the plain selection Claude may pick up. */
function composerStatus() {
  const task = activeTask();
  const queued = state.tasks.filter((t) => t.status === 'queued').length;
  const toTasks = el('button', { class: 'link', text: queued ? `Tasks (+${queued} queued)` : 'Tasks', onclick: () => showView('tasks') });
  if (task?.status === 'in-progress') {
    return el('div', { class: 'status in-progress' }, [`⚙︎ ${taskAgent(task)}: ${task.activity ?? 'working …'} `, toTasks]);
  }
  if (task) {
    const status = state.watching ? 'pending' : 'waiting';
    return el('div', { class: `status ${status}` }, [`${STATUS_TEXT[status]} `, toTasks]);
  }
  if (!hasClaude()) return null;
  const status = state.job?.status;
  if (status === 'in-progress') return el('div', { class: 'status in-progress', text: `⚙︎ Claude Code: ${state.activity ?? 'working on the selection …'}` });
  return STATUS_TEXT[status] ? el('div', { class: `status ${status}`, text: STATUS_TEXT[status] }) : null;
}

/** Only when something keeps a task from running as expected – the normal case needs no explanation. */
function hintText() {
  if (!state.connected) return `Bridge at ${BRIDGE} is not reachable – run “npx benda bridge”.`;
  if (!state.agent) return 'No agent available – “opencode models” lists no model matching opencode.include in benda.config.json.';
  if (isClaude() && !state.watching) {
    return 'Watch mode off: sent tasks reach Claude with your next prompt in Claude Code. Without text, just select and type in Claude Code.';
  }
  return null;
}

/** Opens the panel on a tab, or closes it when `view` is null. */
function showView(view) {
  panel.hidden = view === null;
  if (view) state.view = view;
  persist();
  renderPanel();
  // rules and templates apply without a restart – show what the config says now
  if (view === 'prompt') Promise.all([loadPrompt(), loadSkills()]).then(renderPanel, () => {});
}

/** Info view: the parts of the context block in the order the agent receives them, then the keyboard shortcuts. */
function promptPanel() {
  const template = state.templates.find((t) => t.id === state.template);
  const count = state.items.length;
  const part = (n, title, origin, body, none = false) =>
    el('div', { class: 'item' }, [
      el('div', { class: 'head' }, [el('span', { class: 'num', text: String(n) }), el('b', { text: title }), el('span', { class: 'origin', text: origin })]),
      el('div', { class: none ? 'body none' : 'body' }, body),
    ]);
  const hasRules = state.rules.length > 0;
  const tags = state.tags.map((id) => state.tagList.find((t) => t.id === id)).filter(Boolean);
  const agent = agentName();
  return el('div', { class: 'list' }, [
    el('div', { class: 'section', text: 'How the prompt is built' }),
    part(1, 'Template', 'Selection tab · prompt.templates',
      template
        ? [`${template.label}: ${template.text}`]
        : state.templates.length
          ? ['None – pick one under Template in the Selection tab']
          : ['None – add ', el('code', { text: 'prompt.templates' }), ' to benda.config.json'],
      !template),
    part(2, 'Your text', 'Selection tab',
      [state.instruction || (template ? 'None – the template alone is the task'
        : isClaude() ? 'None – your prompt in Claude Code is the task' : 'None – “Please improve the selection.”')],
      !state.instruction),
    part(3, 'Tags', 'Selection tab, “#” · prompt.tags',
      tags.length
        ? [el('ul', {}, tags.map((tag) => el('li', { text: `${tag.label}: ${tag.text}` })))]
        : state.tagList.length
          ? [`None – type “#” in the text field (${state.tagList.length} configured)`]
          : ['None – add ', el('code', { text: 'prompt.tags' }), ' to benda.config.json'],
      !tags.length),
    part(4, 'Skills', `Selection tab, “/” · ${agent}`,
      state.skills.length
        ? [`${state.skills.map((name) => `/${name}`).join(', ')} – named in the prompt, loaded by ${agent} itself`]
        : state.skillList.length
          ? [`None – type “/” in the text field to pick one of the skills ${agent} can load (${state.skillList.length})`]
          : [`None – ${agent} has no skills in this project`],
      !state.skills.length),
    part(5, `Selected elements (${count})`, 'Selection tab',
      [count ? 'File to edit and likely line, component, text, size, computed styles and HTML of each element.'
        : 'None – the task applies to the current page; the agent gets its URL.'], count === 0),
    part(6, 'Project rules', 'prompt.rules',
      hasRules
        ? [el('ul', {}, state.rules.map((rule) => el('li', { text: rule })))]
        : ['None – add ', el('code', { text: 'prompt.rules' }), ' to benda.config.json'],
      !hasRules),
    part(7, 'Closing note', 'Benda', [state.note]),
    el('div', { class: 'hint prompt-hint' }, [
      'Rules, templates and tags come from ', el('code', { text: 'prompt' }), ' in benda.config.json and apply without a restart. ',
      'Tasks from the Data tab use no template, tags or skills. ', el('b', { text: '⧉' }), ' left of the send button copies the prompt, to paste into any other agent.',
    ]),
    el('div', { class: 'section', text: 'Shortcuts' }),
    shortcutList(),
  ]);
}

function shortcutList() {
  const keys = (...combo) => el('span', {}, kbdCombo(...combo));
  const click = (modifier) => el('span', {}, [el('kbd', { text: modifier }), IS_MAC ? '-click' : '+click']);
  const rows = [
    [keys(KEY.alt, KEY.shift, 'C'), 'Start / stop selecting'],
    ...(IS_MAC ? [[el('span', {}, ['Hold ', el('kbd', { text: KEY.alt })]), 'Select while held']] : []),
    ['Click', 'Select an element'],
    [click(KEY.shift), 'Add or remove an element'],
    [el('span', {}, [el('kbd', { text: '↑' }), ' / ', el('kbd', { text: '↓' })]), 'While selecting: parent / back to the child'],
    [keys(KEY.enter), 'While selecting: select the highlighted element'],
    [keys('/'), 'In the text field: pick a skill'],
    [keys('#'), 'In the text field: add a tag'],
    [el('span', {}, [...kbdCombo(KEY.mod, KEY.enter), ' / ', ...kbdCombo(KEY.alt, KEY.enter)]), 'In the text field: send or queue the task'],
    [keys('Esc'), 'Stop selecting, else close the panel'],
  ];
  return el('div', { class: 'keys' }, rows.flatMap(([combo, text]) => [el('div', { class: 'combo' }, [combo]), el('div', { text })]));
}

function apiPanel() {
  if (apiView) return apiView.mount();
  import(new URL('./overlay-api.js', import.meta.url).href).then(({ createApiView, API_STYLES }) => {
    root.append(el('style', { text: API_STYLES }));
    apiView ??= createApiView({ el, bridge: BRIDGE, request, showToast, sendTask, sendLabel, agentPicker, impact: Boolean(capabilities.impact) });
    renderPanel();
  });
  return el('div', { class: 'empty', text: 'Loading …' });
}

/** Queues a task from another tab (no template, tags or skills); the bridge's answer, or null. */
async function queueTask(instruction, items) {
  if (!state.agent) return showToast(hintText() ?? 'No agent available'), null;
  return composer.submit({ instruction, template: null, tags: [], skills: [], items, page: pageInfo() });
}

function componentsPanel() {
  if (componentsView) return componentsView.mount();
  import(new URL('./overlay-components.js', import.meta.url).href).then(({ createComponentsView, COMPONENTS_STYLES }) => {
    root.append(el('style', { text: COMPONENTS_STYLES }));
    componentsView ??= createComponentsView({
      el, bridge: BRIDGE, root, host, showToast, describe, queueTask, agentName,
      selected: () => state.items[0]?.el ?? null,
      canInsert: Boolean(capabilities.insert),
    });
    renderPanel();
  });
  return el('div', { class: 'empty', text: 'Loading …' });
}

/** An element, or a text or template that says what to do on the current page. */
const hasTask = () => state.items.length > 0 || Boolean(state.instruction.trim()) || Boolean(state.template);
const canSend = () => state.connected && Boolean(state.agent) && hasTask();

function dataPanel() {
  const first = state.items[0];
  if (dataView) return dataView.mount(() => describe(first.el), first?.path ?? null);
  Promise.all([
    import(new URL('./overlay-data.js', import.meta.url).href),
    // the live part is optional: without it the tab still shows the static lineage
    import(new URL('./overlay-live.js', import.meta.url).href).catch((err) => (console.warn('[benda] Live data unavailable:', err), null)),
  ]).then(([{ createDataView, DATA_STYLES }, liveModule]) => {
    if (dataView) return renderPanel();
    root.append(el('style', { text: DATA_STYLES }), ...(liveModule ? [el('style', { text: liveModule.LIVE_STYLES })] : []));
    const live = liveModule?.createLiveView({ el, bridge: BRIDGE, network, adapter, selectedElement: () => state.items[0]?.el ?? null, showToast }) ?? null;
    dataView = createDataView({ el, bridge: BRIDGE, request, showToast, agentPicker, sendTask, sendLabel, live });
    if (state.proposal) dataView.onProposal(state.proposal);
    renderPanel();
  });
  return el('div', { class: 'empty', text: 'Loading …' });
}

function renderPanel() {
  renderToolbar();
  if (panel.hidden) return;
  const tab = (view, text) =>
    el('button', { role: 'tab', 'aria-selected': String(state.view === view), class: state.view === view ? 'on' : '', text, onclick: () => showView(view) });
  const tabs = el('div', { class: 'tabs', role: 'tablist' }, [
    tab('selection', `Selection (${state.items.length})`),
    tab('tasks', `Tasks (${openTasks().length})`),
    tab('api', 'API'),
    ...(capabilities.lineage ? [tab('data', 'Data')] : []),
    tab('components', 'Components'),
  ]);
  // the info view explains the others rather than being a tab of its own – it toggles back to the selection
  const promptInfo = el('button', {
    class: state.view === 'prompt' ? 'icon on' : 'icon',
    title: 'How the prompt is built, shortcuts',
    'aria-label': 'How the prompt is built, shortcuts',
    'aria-pressed': String(state.view === 'prompt'),
    text: 'ⓘ',
    onclick: () => showView(state.view === 'prompt' ? 'selection' : 'prompt'),
  });
  const dockToggle = el('button', { class: 'icon', title: 'Dock panel left/right', text: '⇆', onclick: () => { state.dock = state.dock === 'right' ? 'left' : 'right'; persist(); renderPanel(); } });
  const projectLink = capabilities.inventory
    ? [el('a', { class: 'icon', href: `${BRIDGE}/inventory`, target: 'benda-inventory', title: 'Benda Inventory – every building block of the workspace', text: '▦' })]
    : [];
  if (state.view !== 'selection') {
    const views = { tasks: tasksPanel, prompt: promptPanel, data: dataPanel, api: apiPanel, components: componentsPanel };
    panel.replaceChildren(
      el('header', {}, [tabs, el('div', {}, [...projectLink, dockToggle, promptInfo, el('button', { class: 'icon', title: 'Close (Esc)', text: '✕', onclick: () => showView(null) })])]),
      views[state.view](),
    );
    return;
  }
  const header = el('header', {}, [
    tabs,
    el('div', {}, [
      el('button', { class: 'icon', title: 'Clear selection', text: 'Clear', onclick: () => setItems([]) }),
      ...projectLink,
      dockToggle,
      promptInfo,
      el('button', { class: 'icon', title: 'Close (Esc)', text: '✕', onclick: () => { panel.hidden = true; renderToolbar(); } }),
    ]),
  ]);

  const list = el('div', { class: 'list' });
  if (state.items.length === 0) {
    list.append(el('div', { class: 'empty' }, [
      'Click ', el('b', { text: '◎ Select' }), ' or press ', ...kbdCombo(KEY.alt, KEY.shift, 'C'),
      ...(IS_MAC ? [' (or hold ', el('kbd', { text: KEY.alt }), ')'] : []),
      ', then click an element in the app. ', el('kbd', { text: KEY.shift }), IS_MAC ? '-click' : '+click',
      ' adds more elements, ', el('kbd', { text: '↑' }), ' selects the parent. ',
      'Without a selection, a task applies to the current page.',
    ]));
  }
  state.items.forEach((item, i) => {
    list.append(el('div', { class: 'item' }, [
      el('div', { class: 'head' }, [
        el('span', { class: 'num', text: String(i + 1) }),
        el('code', { text: `<${shortTag(item.el)}>`, title: item.path }),
        el('div', { class: 'actions' }, [
          el('button', { class: 'icon', title: 'Select parent element', text: '↑', onclick: () => replaceItem(i, item.el.parentElement) }),
          el('button', { class: 'icon', title: 'Select whole component', text: '◇', onclick: () => replaceItem(i, adapter.componentHost(item.el)) }),
          ...(capabilities.inventory && item.source?.file && item.info.owner
            ? [el('a', {
                class: 'icon',
                href: `${BRIDGE}/inventory#item=${encodeURIComponent(`component:${item.source.file}#${item.info.owner.name.replace(/^_+/, '')}`)}`,
                target: 'benda-inventory',
                title: `Show ${item.info.owner.name.replace(/^_+/, '')} in the Inventory`,
                text: '▦',
              })]
            : []),
          el('button', { class: 'icon', title: 'Remove', text: '✕', onclick: () => setItems(state.items.filter((_, j) => j !== i).map((it) => it.el)) }),
        ]),
      ]),
      itemMeta(item),
    ]));
  });

  const triggers = composer.triggerHint();
  const keys = `${SEND_SHORTCUT} to send${triggers ? ` · ${triggers}` : ''}`;
  const field = composer.textField({
    placeholder: state.template
      ? `Optional: add details for ${agentName()} (${keys})`
      : `${isClaude() && state.items.length ? 'Optional: what' : 'What'} should ${agentName()} change${state.items.length ? '' : ' on this page'}? (${keys})`,
    // the text alone can make a task – no re-render while typing, just the button
    onInput: () => Object.assign(send, sendState()),
    onSubmit: sendComposer,
  });

  const queueing = openTasks().length > 0;
  const sendState = () => ({
    disabled: !canSend(),
    title: !hasTask() ? 'Select an element or describe the change' : queueing ? 'Starts when the tasks before it are finished' : '',
  });
  const send = el('button', { class: 'primary send', text: queueing ? `Queue for ${agentName()}` : sendLabel(), onclick: sendComposer });
  Object.assign(send, sendState());
  const status = composerStatus();
  const composerNode = el('div', { class: 'composer' }, [
    ...(status ? [status] : []),
    field.node,
    ...[tokenList(), templatePicker(), agentPicker()].filter(Boolean),
    el('div', { class: 'row' }, [
      el('button', {
        class: 'secondary copy',
        text: '⧉',
        title: 'Copy prompt – the context block, to paste into any other agent',
        'aria-label': 'Copy prompt',
        disabled: !state.lastPrompt,
        onclick: copyPrompt,
      }),
      send,
    ]),
    ...(hintText() ? [el('div', { class: 'hint', text: hintText() })] : []),
  ]);

  const restoreTyping = composer.keepTyping(root);
  panel.replaceChildren(header, list, composerNode);
  restoreTyping(field);
}

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.hidden = true), 4000);
}

// ---------------------------------------------------------------- picking

function isOwnNode(event) {
  return event.composedPath().includes(host);
}

function setPicking(on) {
  state.picking = on;
  state.hoverStack = [];
  if (!on) {
    hoverBox.hidden = hoverLabel.hidden = true;
    state.hovered = null;
  }
  document.documentElement.style.cursor = on ? 'crosshair' : '';
  renderToolbar();
}

function placeBox(box, rect) {
  Object.assign(box.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}

function showHover(target) {
  state.hovered = target;
  const rect = target.getBoundingClientRect();
  placeBox(hoverBox, rect);
  const owner = adapter.owner(target);
  const hostComp = adapter.component(target);
  hoverLabel.replaceChildren(
    el('em', { text: shortTag(target) }),
    hostComp ? ` ◇ ${hostComp.name}` : '',
    el('i', { text: `  ${owner ? `in ${owner.name}` : ''}  ${Math.round(rect.width)}×${Math.round(rect.height)}` }),
  );
  hoverBox.hidden = hoverLabel.hidden = false;
  const top = rect.top > 32 ? rect.top - 28 : rect.bottom + 6;
  hoverLabel.style.top = `${Math.min(top, innerHeight - 28)}px`;
  hoverLabel.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - 300))}px`;
}

function onPointerMove(event) {
  lastPointer = { x: event.clientX, y: event.clientY };
  if (!state.picking || isOwnNode(event)) return;
  const target = event.composedPath()[0];
  if (!(target instanceof Element) || target === state.hovered) return;
  state.hoverStack = [];
  showHover(target);
}

function onBlockedEvent(event) {
  if (!state.picking || isOwnNode(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type !== 'click') return;
  const target = state.hovered ?? event.composedPath()[0];
  if (!(target instanceof Element)) return;
  pick(target, event.shiftKey);
}

function startHold() {
  hold.timer = null;
  hold.active = true;
  setPicking(true);
  const under = lastPointer && document.elementFromPoint(lastPointer.x, lastPointer.y);
  if (under && under !== host) showHover(under);
}

/** Ends picking by holding ⌥ – on release, and on blur, since a window left with ⌥ held never sees the keyup. */
function endHold() {
  clearTimeout(hold.timer);
  hold.timer = null;
  if (!hold.active) return;
  hold.active = false;
  setPicking(false);
}

function onKeyDown(event) {
  if (event.key !== 'Alt') {
    clearTimeout(hold.timer);
    hold.timer = null;
  } else if (IS_MAC && !event.repeat && !event.shiftKey && !event.metaKey && !event.ctrlKey && !state.picking && !isOwnNode(event)) {
    hold.timer = setTimeout(startHold, HOLD_MS);
    return;
  }
  if (event.altKey && event.shiftKey && event.code === 'KeyC') {
    event.preventDefault();
    hold.active = false; // the toggle decides now, releasing ⌥ must not undo it
    setPicking(!state.picking);
    return;
  }
  if (isOwnNode(event)) return;
  if (event.key === 'Escape') {
    if (state.picking) setPicking(false);
    else if (!panel.hidden) {
      panel.hidden = true;
      renderToolbar();
    }
    return;
  }
  if (!state.picking || !state.hovered) return;
  if (event.key === 'ArrowUp' && state.hovered.parentElement && state.hovered.parentElement !== document.documentElement) {
    event.preventDefault();
    state.hoverStack.push(state.hovered);
    showHover(state.hovered.parentElement);
  } else if (event.key === 'ArrowDown' && state.hoverStack.length) {
    event.preventDefault();
    showHover(state.hoverStack.pop());
  } else if (event.key === 'Enter') {
    event.preventDefault();
    pick(state.hovered, event.shiftKey);
  }
}

function pick(target, additive) {
  const current = state.items.map((item) => item.el);
  let next;
  if (additive) next = current.includes(target) ? current.filter((e) => e !== target) : [...current, target];
  else next = [target];
  if (!additive) setPicking(false);
  panel.hidden = false;
  setItems(next.slice(-MAX_ITEMS));
}

function replaceItem(index, target) {
  if (!target || target === document.documentElement) return;
  setItems(state.items.map((item, i) => (i === index ? target : item.el)));
}

function setItems(elements) {
  clearInterval(restoreTimer); // a fresh pick wins over a selection still being restored
  state.items = elements.map((element) => {
    const existing = state.items.find((item) => item.el === element);
    return existing ?? { el: element, path: cssPath(element), info: describe(element), source: null };
  });
  persist();
  renderPanel();
  syncSelection();
}

// ---------------------------------------------------------------- selection overlay

function drawSelection() {
  const boxes = state.items.map((item, i) => {
    if (!item.el.isConnected) item.el = document.querySelector(item.path) ?? item.el;
    const box = selLayer.children[i] ?? selLayer.appendChild(el('div', { class: 'box sel' }, [el('b')]));
    box.classList.toggle('working', isWorking());
    box.firstChild.textContent = String(i + 1);
    const visible = item.el.isConnected;
    box.hidden = !visible;
    if (visible) placeBox(box, item.el.getBoundingClientRect());
    return box;
  });
  while (selLayer.children.length > boxes.length) selLayer.lastChild.remove();
  requestAnimationFrame(drawSelection);
}

// ---------------------------------------------------------------- bridge communication

function pageInfo() {
  return { url: location.href, title: document.title, viewport: `${innerWidth}×${innerHeight}` };
}

const post = (payload) => request('/selection', { page: pageInfo(), ...payload });

async function syncSelection() {
  clearTimeout(syncSelection.timer);
  syncSelection.timer = setTimeout(async () => {
    try {
      const result = await post({ items: state.items.map((item) => describe(item.el)) });
      applyResult(result);
    } catch {
      setConnected(false);
    }
  }, 250);
}

/**
 * Queues the selection with an instruction for the chosen agent; `context` is appended (e.g. data lineage).
 * `template` is a template id and `tags` are tag ids from benda.config.json – the bridge resolves their text.
 * `skills` are names the bridge checks against what the agent can load. `withSelection: false` sends the
 * instruction alone, for tasks that are about the workspace rather than the selected elements.
 */
async function sendTask(
  instruction = state.instruction,
  context = '',
  template = null,
  { skills = [], tags = [], withSelection = true } = {},
) {
  const items = withSelection ? state.items.map((item) => describe(item.el)) : [];
  if (!items.length && !instruction.trim() && !template) return;
  if (!state.agent) return showToast(hintText() ?? 'No agent available');
  const text = `${instruction || (template || !items.length ? '' : 'Please improve the selection.')}${context ? `\n${context}` : ''}`;
  await composer.submit({ instruction: text, template, tags, skills, items, page: pageInfo() });
}

const sendComposer = () => canSend() && sendTask(state.instruction, '', state.template, { skills: state.skills, tags: state.tags });

function applyResult(result) {
  result.items.forEach((info, i) => {
    if (state.items[i]) state.items[i].source = info.source ?? null;
  });
  state.job = { id: result.id, status: result.status };
  state.lastPrompt = result.prompt;
  persist();
  renderPanel();
}

async function copyPrompt() {
  await navigator.clipboard.writeText(state.lastPrompt);
  showToast('Prompt copied to clipboard');
}

function setConnected(connected) {
  if (state.connected === connected) return;
  state.connected = connected;
  renderPanel();
}

function listenForStatus() {
  const events = new EventSource(`${BRIDGE}/events`);
  events.onopen = () => {
    setConnected(true);
    loadAgents();
  };
  events.onerror = () => setConnected(false);
  events.onmessage = (message) => {
    const { id, status, since, activity, watching, tasks = [], proposal, claude, components } = JSON.parse(message.data);
    state.proposal = proposal;
    componentsView?.onCatalog(components);
    if (composer.updateClaude(claude)) renderPanel();
    dataView?.onProposal(proposal);
    if (JSON.stringify(tasks) !== JSON.stringify(state.tasks)) {
      const wasOpen = new Set(openTasks().map((task) => task.id));
      const finished = tasks.filter((task) => wasOpen.has(task.id) && !OPEN_TASK.has(task.status));
      state.tasks = tasks;
      if (finished.length) setTimeout(renderToolbar, DONE_VISIBLE_MS + 100);
      const done = finished.find((task) => task.status === 'done');
      if (done) showToast(`✓ ${taskAgent(done)} is done${openTasks().length ? ` – ${openTasks().length} more in Tasks` : ''}`);
      renderPanel();
    }
    const watchChanged = state.watching !== watching;
    state.watching = watching;
    const ours = state.job?.id === id;
    const jobChanged = ours && state.job.status !== status;
    const activityChanged = ours && (state.activity !== activity || state.since !== since);
    if (ours) Object.assign(state, { since, activity });
    if (jobChanged) {
      state.job.status = status;
      if (status === 'done') {
        state.doneAt = Date.now();
        setTimeout(renderToolbar, DONE_VISIBLE_MS + 100);
      }
      persist();
    }
    if (jobChanged || watchChanged) renderPanel();
    else if (activityChanged) renderPanel();
  };
}

// ---------------------------------------------------------------- persistence (survives dev-server reloads)

function persist() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      paths: state.items.map((item) => item.path),
      sources: state.items.map((item) => item.source),
      instruction: state.instruction,
      job: state.job,
      agent: state.agent,
      modelOf: state.modelOf,
      session: state.session,
      sessionOf: state.sessionOf,
      template: state.template,
      skills: state.skills,
      tags: state.tags,
      dock: state.dock,
      lastPrompt: state.lastPrompt,
      panelOpen: !panel.hidden,
      view: state.view,
    }));
  } catch {
    /* storage unavailable – state is per page load only */
  }
}

function restore() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  if (!saved?.paths) return;
  Object.assign(state, {
    instruction: saved.instruction ?? '',
    job: saved.job,
    agent: saved.agent ?? null,
    modelOf: saved.modelOf ?? {},
    session: saved.session ?? null,
    sessionOf: saved.sessionOf ?? {},
    template: saved.template ?? null,
    skills: saved.skills ?? [],
    tags: saved.tags ?? [],
    dock: saved.dock ?? 'right',
    lastPrompt: saved.lastPrompt ?? '',
    view: saved.view === 'data' && !capabilities.lineage ? 'selection' : (saved.view ?? 'selection'),
  });
  panel.hidden = !saved.panelOpen;
  // Routed micro frontends render after bootstrap – retry for a few seconds.
  let attempts = 0;
  restoreTimer = setInterval(() => {
    const found = saved.paths.map((path) => document.querySelector(path));
    if (found.every(Boolean) || ++attempts > 20) {
      clearInterval(restoreTimer);
      state.items = found
        .map((node, i) => node && { el: node, path: saved.paths[i], info: describe(node), source: saved.sources?.[i] ?? null })
        .filter(Boolean);
      renderPanel();
    }
  }, 250);
}

// ---------------------------------------------------------------- bootstrap

function init() {
  buildUi();
  restore();
  renderPanel();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    window.addEventListener(type, onBlockedEvent, true);
  }
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', (event) => event.key === 'Alt' && endHold(), true);
  window.addEventListener('blur', endHold);
  document.addEventListener('visibilitychange', endHold);
  listenForStatus();
  requestAnimationFrame(drawSelection);
  setInterval(() => isWorking() && renderToolbar(), 1000);
  const warning = adapter.warning();
  if (warning) console.info(`[benda] ${warning}`);
  console.info(`[benda] Overlay active. Press ${PICK_SHORTCUT}${IS_MAC ? ' or hold ⌥' : ''} to select elements.`);
}

if (!window.__benda) {
  window.__benda = true;
  init();
}
