// Benda Inventory: the workspace's building blocks at a glance. Served by the bridge at /inventory, so it exists in
// dev mode only, like the overlay. The adapter's inventory fills a tree (project → group → kind, or kind → project);
// an item shows its details and relations, and the composer sends tasks about it to the queue the overlay uses too.
// Framework-free: kinds, items and detail sections come from the adapter (contract: core src/adapter.mjs).
import { createComposer, harnessOf } from './composer.js';
import { createTasksView, OPEN_TASK } from './tasks-view.js';
import { KEY, UI_STYLES, combo, createRequest, el, proposalSteps } from './ui.js';

const BRIDGE = location.origin;
const request = createRequest(BRIDGE);
const STORAGE_KEY = 'benda-inventory';
const SEND_SHORTCUT = `${combo(KEY.mod, KEY.enter)} / ${combo(KEY.alt, KEY.enter)}`;
const DONE_TOAST_MS = 4000;
// `editor` in benda.config.json: one of these names or an URL template with {path} (absolute) and {line}
const EDITORS = {
  vscode: 'vscode://file{path}:{line}',
  cursor: 'cursor://file{path}:{line}',
  idea: 'idea://open?file={path}&line={line}',
  webstorm: 'webstorm://open?file={path}&line={line}',
};
const RELATIONS = { uses: 'Uses', injects: 'Injects', 'routes-to': 'Routes to', 'guarded-by': 'Guarded by', reads: 'Reads', writes: 'Writes' };
const INCOMING = { uses: 'Used by', injects: 'Injected by', 'routes-to': 'Routed from', 'guarded-by': 'Guards' };

const state = {
  connected: false,
  health: null, // GET /health: name, workspace, capabilities, editor
  kinds: [],
  items: [],
  failed: [],
  loading: true,
  error: null,
  selected: null, // id of the item shown
  detail: null, // GET /inventory/item: the item with relations, incoming references and sections
  mode: 'project', // tree: 'project' (project → group → kind) or 'kind' (kind → project)
  query: '',
  collapsed: new Set(), // keys of tree nodes the user closed
  view: 'structure', // 'structure' | 'checks' | 'api'
  check: null, // GET /check: { findings, stats } or { error }
  impact: null, // the API view's last "Impact on the app": { from, to, items }
  places: [], // where new building blocks can go (from the inventory)
  create: null, // the "+ New" form: { kind, project, group, newGroup, fields, spec, operations, bind }
  specs: null, // GET /specs – the APIs a new store can use
  specDetails: {}, // spec file → GET /specs/detail
  waiting: null, // { since, create } – a data-access proposal was asked for
  proposal: null, // the data-access proposal under review: { name, spec, rows, methods, files, notes, … }
  tasks: [],
  watching: false,
  // the composer's fields (composer.js)
  agents: [],
  agent: null,
  session: null,
  modelOf: {},
  sessionOf: {},
  templates: [],
  // templates frame changes in the running app ("Restyle"); here only a deliberate choice applies, not the default
  template: null,
  tagList: [],
  tags: [],
  skillList: [],
  skills: [],
  menu: null,
  instruction: '',
  rules: [],
  note: '',
  lastPrompt: '',
};

const STYLES = `${UI_STYLES}
  :root { --bg: #f6f6f7; --surface: #fff; --line: #e4e4e7; --soft: #f0f0f2; --text: #18181b; --muted: #71717a; --faint: #a1a1aa;
    --accent: #4f46e5; --accent-soft: #eef2ff; --accent-line: #c7d2fe; --accent-text: #3730a3; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased; }
  a { color: var(--accent-text); text-decoration: none; }
  a:hover { text-decoration: underline; }
  :focus-visible { outline: 2px solid #a5b4fc; outline-offset: 1px; }
  .app { display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  .top { display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--surface); }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; letter-spacing: -.01em; white-space: nowrap; }
  .logo { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; font-size: 13px; }
  .top .name { overflow: hidden; padding: 2px 8px; border-radius: 6px; background: var(--soft); color: var(--muted); font: 12px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
  .seg { display: inline-flex; flex: none; gap: 2px; padding: 2px; border-radius: 8px; background: var(--soft); }
  .seg button { border: 0; border-radius: 6px; padding: 3px 12px; background: transparent; color: var(--muted); font: 600 12px/1.5 ui-sans-serif, system-ui; cursor: pointer; }
  .seg button:hover { color: var(--text); }
  .seg button.on { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / .1); }
  .top .seg { margin-left: 12px; }
  .tally { display: inline-flex; flex: none; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; background: var(--surface);
    color: #3f3f46; font: 600 12px ui-sans-serif, system-ui; white-space: nowrap; cursor: pointer; }
  .tally:hover { background: var(--soft); }
  .tally.ok { color: #166534; }
  .tally.on { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent-text); }
  .spacer { flex: 1; }
  .conn { display: inline-flex; flex: none; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 0 3px #fee2e2; }
  .dot.ok { background: #22c55e; box-shadow: 0 0 0 3px #dcfce7; }
  .main { display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr) minmax(300px, 360px); min-height: 0; }
  .main.wide { grid-template-columns: minmax(0, 1fr) minmax(300px, 360px); }
  @media (max-width: 1200px) {
    .main { grid-template-columns: 240px minmax(0, 1fr) 280px; }
    .main.wide { grid-template-columns: minmax(0, 1fr) 280px; }
    .detail, .center > .composer { padding-inline: 20px; }
  }
  .pane { display: flex; flex-direction: column; min-height: 0; background: var(--surface); border-right: 1px solid var(--line); }
  .pane.center { border-right: 0; background: var(--bg); }
  .pane.side { border-right: 0; border-left: 1px solid var(--line); background: var(--bg); }
  .pane > .head { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 14px; border-bottom: 1px solid var(--line); background: var(--surface); font-weight: 600; }
  .count { min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--soft); color: var(--muted); font-size: 11px; font-weight: 600; text-align: center; }
  .head .count.busy { background: #fef3c7; color: #92400e; }
  .side .item { border-color: var(--line); background: var(--surface); }
  .side .item:has(.pill.done) .num { background: #dcfce7; color: #166534; }
  .tools { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-bottom: 1px solid var(--soft); }
  .tools .row { gap: 4px; }
  .tools .seg button { padding: 2px 10px; }
  .search { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px 6px 30px; color: inherit; font: inherit;
    background: var(--bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E") no-repeat 10px center; }
  .search:focus { outline: 2px solid var(--accent-line); border-color: #6366f1; background-color: var(--surface); }
  .new { margin-left: 4px; border: 0; border-radius: 7px; padding: 3px 10px; background: var(--accent-soft); color: var(--accent-text); font: 600 12px/1.5 ui-sans-serif, system-ui; cursor: pointer; }
  .new:hover { background: #e0e7ff; }
  .tree { flex: 1; overflow-y: auto; padding: 6px 6px 16px; }
  .node > .label { position: relative; display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 6px; border-radius: 6px; color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; }
  .node > .label:hover { background: var(--soft); color: var(--text); }
  .node.d0 > .label { color: var(--text); font-weight: 700; }
  .node.d0 + .node.d0 { margin-top: 4px; }
  .node > .label .caret { flex: none; width: 12px; height: 12px; transition: transform .12s;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M4.5 3l3 3-3 3' fill='none' stroke='%23a1a1aa' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center no-repeat; }
  .node > .label .folder { flex: none; width: 14px; height: 14px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linejoin='round'%3E%3Cpath d='M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'/%3E%3C/svg%3E") center no-repeat; }
  .node.group > .label, .node.project > .label { color: var(--text); }
  .node.kind > .label { font-weight: 500; }
  .node > .label .caret.open { transform: rotate(90deg); }
  .node > .label .count { margin-left: auto; }
  .node > .label .add { position: absolute; right: 4px; display: none; border: 0; border-radius: 5px; padding: 0 7px; background: var(--accent-soft); color: var(--accent-text); font: 600 13px/20px ui-sans-serif, system-ui; cursor: pointer; }
  .node > .label:hover .add, .node > .label:focus-within .add { display: block; }
  .node > .label:hover:has(.add) .count, .node > .label:focus-within:has(.add) .count { visibility: hidden; }
  .node > .label .add:hover { background: #e0e7ff; }
  .children { margin-left: 12px; padding-left: 4px; border-left: 1px solid var(--soft); }
  .leaf { display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 8px 0 6px; border: 0; border-radius: 6px; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  .leaf:hover { background: var(--soft); }
  .leaf.on { background: var(--accent-soft); color: var(--accent-text); box-shadow: inset 2px 0 0 var(--accent); }
  .leaf .nm { font-weight: 500; white-space: nowrap; }
  .leaf .sum { min-width: 0; overflow: hidden; color: var(--faint); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  /* --k: the kind's hue, so a kind has one colour in the tree, the details and the overview */
  .kico { display: inline-grid; flex: none; place-items: center; width: 18px; height: 18px; border-radius: 5px; background: hsl(var(--k) 85% 94%); color: hsl(var(--k) 55% 42%); font-size: 11px; line-height: 1; }
  .foot { padding: 8px 12px; border-top: 1px solid var(--soft); background: #fffbeb; color: #92400e; font-size: 11px; }
  .detail { flex: 1; overflow-y: auto; padding: 24px 28px 32px; display: flex; flex-direction: column; gap: 14px; }
  .detail > * { width: 100%; max-width: 920px; margin-inline: auto; }
  .stack { display: flex; flex-direction: column; gap: 14px; }
  .hdr { display: flex; flex-direction: column; gap: 4px; margin-bottom: 2px; }
  .hdr h1 { margin: 0; font-size: 22px; line-height: 1.25; letter-spacing: -.015em; overflow-wrap: anywhere; }
  .kindtag { display: inline-flex; align-items: center; gap: 6px; color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .kindtag[style] { color: hsl(var(--k) 50% 38%); }
  .where { color: var(--muted); font-size: 12px; }
  .where.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin-top: 2px; }
  .where .file { font: 12px var(--mono); }
  .where code { padding: 1px 6px; border-radius: 5px; background: var(--soft); color: #3f3f46; font: 11px var(--mono); }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; background: var(--surface); box-shadow: 0 1px 2px rgb(0 0 0 / .04); }
  .card h2 { margin: 0 0 10px; color: var(--text); font-size: 13px; font-weight: 600; }
  .card h2::first-letter { text-transform: uppercase; }
  .card table { width: 100%; border-collapse: collapse; }
  .card th, .card td { padding: 6px 12px 6px 0; border-top: 1px solid var(--soft); text-align: left; vertical-align: top; font-size: 12px; }
  .card tr:first-child > * { border-top: 0; }
  .card th { padding-top: 0; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
  .card td.k { width: 140px; color: var(--muted); }
  .card ul { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.6; }
  .rel { display: grid; grid-template-columns: 120px 1fr; gap: 8px 12px; align-items: center; font-size: 12px; }
  .rel .type { color: var(--muted); }
  .refs { display: flex; flex-wrap: wrap; gap: 6px; }
  .ref { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 7px; padding: 2px 8px 2px 3px; background: var(--surface); color: #3f3f46;
    font: 12px var(--mono); cursor: pointer; }
  .ref:hover { border-color: #a5b4fc; background: var(--accent-soft); color: var(--accent-text); }
  span.ref { padding-left: 8px; cursor: default; }
  .ref .kico { width: 16px; height: 16px; font: 10px ui-sans-serif, system-ui; }
  .placeholder { margin: auto; max-width: 440px; color: var(--muted); line-height: 1.6; text-align: center; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .tile { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
    color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .tile:hover { border-color: #a5b4fc; box-shadow: 0 2px 10px rgb(79 70 229 / .1); }
  .tile .kico { width: 28px; height: 28px; margin-bottom: 4px; border-radius: 8px; font-size: 14px; }
  .tile b { font-size: 22px; line-height: 1; letter-spacing: -.02em; }
  .tile .lbl { color: var(--muted); font-size: 12px; }
  .tile.warn b { color: #b45309; }
  .tile.good b { color: #15803d; }
  .center > .composer { padding: 12px 28px 14px; border-top: 1px solid var(--line); background: var(--surface); box-shadow: 0 -4px 16px rgb(0 0 0 / .03); }
  .center > .composer > * { width: 100%; max-width: 920px; margin-inline: auto; }
  .form { display: grid; grid-template-columns: 120px 1fr; gap: 10px 14px; align-items: center; }
  .form > label { color: #52525b; font-size: 12px; }
  .form input[type=text] { min-width: 0; border: 1px solid #d4d4d8; border-radius: 8px; padding: 6px 8px; font: inherit; color: inherit; }
  .form input[type=text]:focus { outline: 2px solid var(--accent-line); border-color: #6366f1; }
  .pair { display: flex; gap: 8px; min-width: 0; }
  .checks { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto; padding: 4px 0; font-size: 12px; }
  .checks label { display: flex; align-items: baseline; gap: 6px; }
  .checks code { font: 11px var(--mono); color: #52525b; }
  .card table input { width: 100%; min-width: 60px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; font: 12px var(--mono); background: #fff; }
  .actions-row { display: flex; gap: 8px; justify-content: flex-end; }
  .lvl { flex: none; font-size: 9px; }
  .lvl.error, .imp.breaking { color: #dc2626; }
  .lvl.warning, .imp.changed { color: #d97706; }
  .lvl.info, .imp.new { color: #a1a1aa; }
  .imp { flex: none; font-size: 11px; }
  .finding { display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: baseline; padding: 10px 0; border-top: 1px solid var(--soft); font-size: 12px; }
  .finding:first-of-type { padding-top: 0; border-top: 0; }
  .finding .msg { color: var(--text); }
  .finding .sub { grid-column: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--muted); }
  .finding .sub a { font: 11px var(--mono); }
  .finding > .icon { border: 1px solid var(--line); padding: 2px 10px; font-size: 12px; }
  .banner { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid #fde68a; background: #fffbeb; color: #92400e; font-size: 12px; }
  .banner .icon { margin-left: auto; }
  .toast { position: fixed; top: 64px; right: 16px; z-index: 4; padding: 10px 14px; border-radius: 10px; background: #166534; color: #fff;
    font: 600 13px ui-sans-serif, system-ui; box-shadow: 0 8px 24px rgb(0 0 0 / 0.25); }
`;

let app;
let toast;
let apiView = null; // created on first use from overlay-api.js

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.hidden = true), DONE_TOAST_MS);
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: state.mode,
      collapsed: [...state.collapsed],
      selected: state.selected,
      view: state.view,
      agent: state.agent,
      session: state.session,
      modelOf: state.modelOf,
      sessionOf: state.sessionOf,
      template: state.template,
      skills: state.skills,
      tags: state.tags,
      instruction: state.instruction,
      create: state.create,
      waiting: state.waiting,
      proposal: state.proposal,
    }));
  } catch {
    /* storage unavailable – the page starts fresh next time */
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved) return;
    Object.assign(state, {
      mode: saved.mode === 'kind' ? 'kind' : 'project',
      collapsed: new Set(saved.collapsed ?? []),
      selected: saved.selected ?? null,
      view: ['api', 'checks'].includes(saved.view) ? saved.view : 'structure',
      agent: saved.agent ?? null,
      session: saved.session ?? null,
      modelOf: saved.modelOf ?? {},
      sessionOf: saved.sessionOf ?? {},
      template: saved.template ?? null,
      skills: saved.skills ?? [],
      tags: saved.tags ?? [],
      instruction: saved.instruction ?? '',
      create: saved.create ?? null,
      waiting: saved.waiting ?? null,
      proposal: saved.proposal ?? null,
    });
  } catch {
    /* unreadable – start fresh */
  }
}

const composer = createComposer({ state, el, bridge: BRIDGE, request, showToast, render, persist });
const { agentName, sendLabel, agentPicker, templatePicker, tokenList, agentLabel, isClaude, loadAgents } = composer;
const { openTasks, tasksPanel, taskAgent } = createTasksView({
  state, el, request, showToast, agentLabel, harnessOf,
  emptyText: 'No tasks yet. Pick a building block, describe the change and send it – tasks from the app’s overlay show up here too.',
});

// ---------------------------------------------------------------- data

const kindOf = (id) => state.kinds.find((k) => k.id === id) ?? { id, label: id, plural: id, icon: '•' };
const itemById = (id) => state.items.find((item) => item.id === id);
// hues spread around the wheel; the adapter's kind order decides which kind gets which
const HUES = [239, 160, 25, 280, 199, 340, 95, 45];
const kindStyle = (id) => `--k: ${HUES[Math.max(0, state.kinds.findIndex((k) => k.id === id)) % HUES.length]}`;
const kindIcon = (id) => el('span', { class: 'kico', style: kindStyle(id), 'aria-hidden': 'true', text: kindOf(id).icon });
/** A building block as a chip that selects it. */
const itemChip = (item, onclick = () => select(item.id)) =>
  el('button', { class: 'ref', title: `${kindOf(item.kind).label} · ${item.file}`, onclick }, [kindIcon(item.kind), item.name]);

let reading = null; // the inventory request under way
let readAgain = false; // files changed while it ran

/** Reads the inventory again; calls during a read (an agent writing file after file) end in one more read after it. */
async function loadInventory() {
  if (reading) {
    readAgain = true;
    return reading;
  }
  reading = readInventory();
  try {
    await reading;
  } finally {
    reading = null;
  }
  if (readAgain) {
    readAgain = false;
    return loadInventory();
  }
}

async function readInventory() {
  const before = state.selected && itemById(state.selected);
  try {
    const res = await fetch(`${BRIDGE}/inventory/items`);
    if (!res.ok) throw new Error(await res.text());
    const { kinds, items, failed, places } = await res.json();
    Object.assign(state, { kinds, items, failed: failed ?? [], places: places ?? [], error: null });
  } catch (err) {
    state.error = err.message;
  }
  state.loading = false;
  if (state.selected && !itemById(state.selected)) {
    // renamed or moved: the item of the same kind in the same file, else the one with the same name elsewhere
    const renamed = before && (state.items.find((item) => item.kind === before.kind && item.file === before.file) ??
      state.items.find((item) => item.kind === before.kind && item.name === before.name));
    state.selected = renamed?.id ?? null;
    if (renamed) history.replaceState(null, '', `#item=${encodeURIComponent(renamed.id)}`);
    persist();
  }
  render();
  if (state.selected) loadDetail();
  loadCheck();
}

async function loadCheck() {
  if (!state.health?.capabilities?.check) return;
  try {
    const res = await fetch(`${BRIDGE}/check`);
    if (!res.ok) throw new Error(await res.text());
    state.check = await res.json();
  } catch (err) {
    state.check = { error: err.message };
  }
  render();
}

// ---------------------------------------------------------------- findings and impact per item

const LEVELS = ['error', 'warning', 'info'];
/** Findings whose file is the item's file or its component template. */
const findingsOf = (item) =>
  (state.check?.findings ?? []).filter((f) => f.file === item.file || (item.detail?.template && !item.detail.template.inline && f.file === item.detail.template.file));
const impactOf = (item) => (state.impact?.items ?? []).filter((i) => i.file === item.file && i.level !== 'new');
const worst = (list, order) => order.find((level) => list.some((x) => x.level === level));
/** The item a finding belongs to, if the inventory has one. */
const itemOfFinding = (finding) => state.items.find((item) => findingsOf(item).includes(finding));

function badges(item) {
  const findings = findingsOf(item);
  const impact = impactOf(item);
  const level = worst(findings, LEVELS);
  const changed = worst(impact, ['breaking', 'changed']);
  return [
    ...(level ? [el('span', { class: `lvl ${level}`, title: findings.map((f) => `${f.level}: ${f.message}`).join('\n'), text: '●' })] : []),
    ...(changed ? [el('span', { class: `imp ${changed}`, title: impact.map((i) => `${i.level}: ${i.message}`).join('\n'), text: '⚑' })] : []),
  ];
}

/** Queues a task that fixes these findings; with an item, the item goes along as the subject. */
function sendFix(findings, itemId = null) {
  if (!state.agent) return showToast('No agent available');
  composer.submit({
    instruction: findings.length === 1 ? 'Fix this finding of `npx benda check`.' : `Fix these ${findings.length} findings of \`npx benda check\`.`,
    checks: findings,
    ...(itemId ? { subject: { id: itemId } } : {}),
    page: { url: location.href, title: document.title },
  });
}

function findingRow(finding, { withItem = false } = {}) {
  const item = withItem ? itemOfFinding(finding) : null;
  const link = editorLink(finding.file, finding.line);
  return el('div', { class: 'finding' }, [
    el('span', { class: `lvl ${finding.level}`, title: finding.level, text: '●' }),
    el('span', { class: 'msg' }, [el('b', { text: finding.rule }), ` ${finding.message}`]),
    el('button', { class: 'icon', text: 'Fix', title: `Queue a task that fixes it (${agentName()})`, onclick: () => sendFix([finding], item?.id ?? itemOfFinding(finding)?.id ?? null) }),
    el('span', { class: 'sub' }, [
      ...(item ? [itemChip(item, () => { state.view = 'structure'; select(item.id); })] : []),
      link ? el('a', { href: link, text: `${finding.file}${finding.line ? `:${finding.line}` : ''}` }) : finding.file,
      ...(finding.fix ? [el('span', { text: finding.fix })] : []),
    ]),
  ]);
}

function checksCard(item) {
  const findings = findingsOf(item);
  if (!findings.length) return null;
  return el('div', { class: 'card' }, [
    el('h2', { text: `Checks (${findings.length})` }),
    ...findings.map((f) => findingRow(f)),
    ...(findings.length > 1 ? [el('div', { class: 'actions-row' }, [el('button', { class: 'secondary', text: `Fix all ${findings.length}`, onclick: () => sendFix(findings, item.id) })])] : []),
  ]);
}

function impactCard(item) {
  const impact = impactOf(item);
  if (!impact.length) return null;
  return el('div', { class: 'card' }, [
    el('h2', { text: `Impact of ${state.impact.to} (${impact.length})` }),
    ...impact.map((i) => el('div', { class: 'finding' }, [
      el('span', { class: `imp ${i.level}`, title: i.level, text: '⚑' }),
      el('span', { class: 'msg' }, [el('b', { text: i.symbol ?? i.kind }), ` ${i.message}`]),
      el('span'),
      el('span', { class: 'sub', text: `${i.file}${i.line ? `:${i.line}` : ''}${i.fix ? ` – ${i.fix}` : ''}` }),
    ])),
    el('div', { class: 'hint', text: 'The API tab’s “Migrate” sends the whole migration as one task.' }),
  ]);
}

/** Every finding of the workspace, worst first, with Fix per finding and per level. */
function checksView() {
  if (!state.check) return el('div', { class: 'empty', text: 'Running the check …' });
  if (state.check.error) return el('div', { class: 'empty', text: state.check.error });
  const findings = state.check.findings ?? [];
  const stats = Object.entries(state.check.stats ?? {}).map(([k, v]) => `${v} ${k}`).join(', ');
  const byLevel = LEVELS.map((level) => [level, findings.filter((f) => f.level === level)]).filter(([, list]) => list.length);
  return el('div', { class: 'stack' }, [
    pageHead({
      tag: '✓ npx benda check',
      title: findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'No findings',
      where: `Checked ${stats || 'the workspace'} against the data-layer rules.`,
    }),
    ...byLevel.map(([level, list]) => el('div', { class: 'card' }, [
      el('h2', { text: `${level}s (${list.length})` }),
      ...list.map((f) => findingRow(f, { withItem: true })),
      ...(list.length > 1 ? [el('div', { class: 'actions-row' }, [el('button', { class: 'secondary', text: `Fix all ${list.length} ${level}s`, onclick: () => sendFix(list) })])] : []),
    ])),
  ]);
}

async function loadDetail() {
  const id = state.selected;
  try {
    const res = await fetch(`${BRIDGE}/inventory/item?id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(await res.text());
    const detail = await res.json();
    if (state.selected === id) state.detail = detail;
  } catch (err) {
    if (state.selected === id) state.detail = { error: err.message };
  }
  render();
}

function select(id) {
  if (state.selected === id && state.detail && !state.create) return;
  state.create = null;
  state.selected = id;
  state.detail = null;
  history.replaceState(null, '', `#item=${encodeURIComponent(id)}`);
  persist();
  render();
  loadDetail();
}

// ---------------------------------------------------------------- tree

function matches(item, query) {
  return [item.name, item.file, item.summary, kindOf(item.kind).label].some((text) => text?.toLowerCase().includes(query));
}

/** Nested nodes for the current mode; levels without a name (files right below src/app) are left out. */
function treeModel() {
  const query = state.query.trim().toLowerCase();
  const items = query ? state.items.filter((item) => matches(item, query)) : state.items;
  const kindIndex = (id) => {
    const at = state.kinds.findIndex((k) => k.id === id);
    return at === -1 ? state.kinds.length : at;
  };
  // `ctx` tells "+ New" on a node what it already knows: project, folder, kind
  const levels = state.mode === 'project'
    // the project's own kinds (its application, root routes, app component) before its feature folders
    ? [
        (i) => ({ key: i.project, label: i.project, ctx: { project: i.project, group: '' } }),
        (i) => (i.group ? { key: i.group, label: i.group, order: 1000, ctx: { group: i.group } } : null),
        (i) => ({ key: i.kind, label: kindOf(i.kind).plural, order: kindIndex(i.kind), ctx: { kind: i.kind } }),
      ]
    : [
        (i) => ({ key: i.kind, label: kindOf(i.kind).plural, order: kindIndex(i.kind), ctx: { kind: i.kind } }),
        (i) => ({ key: i.project, label: i.project, ctx: { project: i.project, group: '' } }),
      ];
  const root = { key: '', children: new Map(), items: [], ctx: {} };
  for (const item of items) {
    let node = root;
    for (const level of levels) {
      const part = level(item);
      if (!part) continue;
      const key = `${node.key}/${part.key}`;
      if (!node.children.has(key)) node.children.set(key, { key, label: part.label, order: part.order ?? 0, children: new Map(), items: [], ctx: { ...node.ctx, ...part.ctx }, type: part.ctx.kind ? 'kind' : part.ctx.project ? 'project' : 'group' });
      node = node.children.get(key);
    }
    node.items.push(item);
  }
  return root;
}

const countOf = (node) => node.items.length + [...node.children.values()].reduce((sum, child) => sum + countOf(child), 0);

function treeNode(node, searching, depth) {
  const open = searching || !state.collapsed.has(node.key);
  const toggle = () => {
    if (state.collapsed.has(node.key)) state.collapsed.delete(node.key);
    else state.collapsed.add(node.key);
    persist();
    render();
  };
  return el('div', { class: `node ${node.type} d${depth}` }, [
    // a div, not a button: it holds the "+" button
    el('div', {
      class: 'label',
      role: 'button',
      tabindex: '0',
      'aria-expanded': String(open),
      'data-focus': `node-${node.key}`,
      onclick: toggle,
      onkeydown: (e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        toggle();
      },
      title: node.key.slice(1),
    }, [
      el('span', { class: open ? 'caret open' : 'caret', 'aria-hidden': 'true' }),
      ...(node.type === 'group' ? [el('span', { class: 'folder', 'aria-hidden': 'true' })] : []),
      node.label,
      el('span', { class: 'count', text: String(countOf(node)) }),
      ...(creatable(node.ctx)
        ? [el('button', {
            class: 'add',
            title: `New ${node.ctx.kind ? kindOf(node.ctx.kind).label.toLowerCase() : 'building block'}${node.ctx.project ? ` in ${node.ctx.project}${node.ctx.group ? `/${node.ctx.group}` : ''}` : ''}`,
            text: '+',
            onclick: (e) => {
              e.stopPropagation();
              openCreate(node.ctx);
            },
          })]
        : []),
    ]),
    ...(open ? [el('div', { class: 'children' }, treeChildren(node, searching, depth + 1))] : []),
  ]);
}

function treeChildren(node, searching, depth = 0) {
  const children = [...node.children.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const items = [...node.items].sort((a, b) => a.name.localeCompare(b.name));
  return [
    ...children.map((child) => treeNode(child, searching, depth)),
    ...items.map((item) => el('button', {
      class: item.id === state.selected ? 'leaf on' : 'leaf',
      title: `${kindOf(item.kind).label} · ${item.file}${item.line ? `:${item.line}` : ''}`,
      'aria-current': item.id === state.selected ? 'true' : false,
      'data-focus': `leaf-${item.id}`,
      onclick: () => select(item.id),
    }, [
      kindIcon(item.kind),
      el('span', { class: 'nm', text: item.name }),
      ...badges(item),
      el('span', { class: 'sum', text: item.summary ?? '' }),
    ])),
  ];
}

function treePane() {
  const search = el('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Search name, file, summary',
    'aria-label': 'Search',
    'data-focus': 'search',
    value: state.query,
    oninput: (e) => {
      state.query = e.target.value;
      render();
    },
  });
  const modeButton = (id, text, title) => el('button', {
    class: state.mode === id ? 'on' : '',
    'aria-pressed': String(state.mode === id),
    text,
    title,
    onclick: () => {
      state.mode = id;
      persist();
      render();
    },
  });
  const mode = el('div', { class: 'seg', role: 'group', 'aria-label': 'Group by' }, [
    modeButton('project', 'Project', 'Group by project and folder'),
    modeButton('kind', 'Kind', 'Group by kind'),
  ]);
  const reload = el('button', { class: 'icon', title: 'Read the workspace again', 'aria-label': 'Read the workspace again', text: '↻', onclick: loadInventory });
  let body;
  if (state.loading) body = el('div', { class: 'empty', text: 'Reading the workspace …' });
  else if (state.error) body = el('div', { class: 'empty', text: state.error });
  else if (!state.items.length) body = el('div', { class: 'empty', text: 'No building blocks found.' });
  else {
    const model = treeModel();
    body = model.children.size || model.items.length ? treeChildren(model, Boolean(state.query.trim())) : [el('div', { class: 'empty', text: 'Nothing matches.' })];
  }
  return el('section', { class: 'pane' }, [
    ...(state.impact?.items.some((i) => i.level !== 'new')
      ? [el('div', { class: 'banner' }, [
          `⚑ Impact of ${state.impact.to}: ${['breaking', 'changed'].map((l) => `${state.impact.items.filter((i) => i.level === l).length} ${l}`).join(', ')}`,
          el('button', { class: 'icon', text: '✕', title: 'Hide the impact marks', onclick: () => { state.impact = null; render(); } }),
        ])]
      : []),
    el('div', { class: 'tools' }, [
      search,
      el('div', { class: 'row' }, [
        mode,
        el('span', { class: 'spacer' }),
        reload,
        ...(creatable({}) ? [el('button', { class: 'new', title: 'Create a building block with the agent', text: '+ New', onclick: () => openCreate({}) })] : []),
      ]),
    ]),
    el('div', { class: 'tree' }, Array.isArray(body) ? body : [body]),
    ...(state.failed.length
      ? [el('div', { class: 'foot', title: state.failed.map((f) => `${f.file}: ${f.error}`).join('\n'), text: `${state.failed.length} file(s) could not be analysed` })]
      : []),
  ]);
}

// ---------------------------------------------------------------- details

function editorLink(file, line) {
  const workspace = state.health?.workspace;
  if (!workspace || !file) return null;
  const template = EDITORS[state.health.editor] ?? (String(state.health.editor ?? '').includes('{path}') ? state.health.editor : EDITORS.vscode);
  // Windows paths ("C:\\x") become "/C:/x", the form the editors' URL handlers expect
  const path = `${workspace}/${file}`.replace(/\\/g, '/').replace(/^(?!\/)/, '/');
  return template.replace('{path}', path).replace('{line}', String(line ?? 1));
}

const refChip = (entry) => (entry.item ? itemChip(entry.item) : el('span', { class: 'ref', text: entry.label ?? '?' }));

function relationsCard(detail) {
  const rows = [];
  for (const [type, label] of Object.entries(RELATIONS)) {
    const list = detail.relations.filter((r) => r.type === type);
    if (list.length) rows.push(el('div', { class: 'type', text: label }), el('div', { class: 'refs' }, list.map(refChip)));
  }
  for (const [type, label] of Object.entries(INCOMING)) {
    const list = detail.incoming.filter((r) => r.type === type);
    if (list.length) rows.push(el('div', { class: 'type', text: label }), el('div', { class: 'refs' }, list.map(refChip)));
  }
  return rows.length ? el('div', { class: 'card' }, [el('h2', { text: 'Relations' }), el('div', { class: 'rel' }, rows)]) : null;
}

function sectionCard(section) {
  const body = [];
  if (section.text) body.push(el('div', { class: 'hint', text: section.text }));
  if (section.items) body.push(el('ul', {}, section.items.map((entry) => el('li', { text: String(entry) }))));
  if (section.rows && section.columns) {
    body.push(el('table', {}, [
      el('tr', {}, section.columns.map((c) => el('th', { text: c }))),
      ...section.rows.map((row) => el('tr', {}, row.map((value) => el('td', { text: String(value ?? '') })))),
    ]));
  } else if (section.rows) {
    body.push(el('table', {}, section.rows.map(([label, value]) => el('tr', {}, [el('td', { class: 'k', text: label }), el('td', { text: String(value ?? '') })]))));
  }
  return el('div', { class: 'card' }, [el('h2', { text: section.title }), ...body]);
}

/** Title block of the center: a tag line (text or nodes), the title and a line saying where or what. */
function pageHead({ tag, title, where, style, meta = false }) {
  return el('div', { class: 'hdr' }, [
    el('div', { class: 'kindtag', style }, [tag].flat()),
    el('h1', { text: title }),
    ...(where ? [el('div', { class: meta ? 'where meta' : 'where' }, [where].flat())] : []),
  ]);
}

/** Without a selection: what the workspace holds, one tile per kind, and the findings. */
function overview() {
  if (state.loading || state.error || !state.items.length) {
    return el('div', { class: 'placeholder' }, [
      el('p', { text: 'Pick a building block on the left to see its details, what it uses and what uses it.' }),
      el('p', { text: 'Then describe a change below it – the agent gets the block with its relations as context.' }),
    ]);
  }
  const projects = new Set(state.items.map((item) => item.project)).size;
  const showKind = (id) => {
    // group by kind with only this kind open; the project mode's open folders stay as they are
    state.mode = 'kind';
    for (const k of state.kinds) state.collapsed[k.id === id ? 'delete' : 'add'](`/${k.id}`);
    persist();
    render();
  };
  const tiles = state.kinds
    .map((k) => [k, state.items.filter((item) => item.kind === k.id).length])
    .filter(([, n]) => n)
    .map(([k, n]) => el('button', { class: 'tile', title: `Show the ${k.plural.toLowerCase()} in the tree`, onclick: () => showKind(k.id) }, [
      kindIcon(k.id),
      el('b', { text: String(n) }),
      el('span', { class: 'lbl', text: k.plural }),
    ]));
  const findings = state.check?.findings;
  if (findings) {
    tiles.push(el('button', { class: findings.length ? 'tile warn' : 'tile good', title: 'Findings of npx benda check', onclick: () => { state.view = 'checks'; persist(); render(); } }, [
      el('span', { class: 'kico', style: '--k: 38', 'aria-hidden': 'true', text: findings.length ? '!' : '✓' }),
      el('b', { text: String(findings.length) }),
      el('span', { class: 'lbl', text: findings.length === 1 ? 'Finding' : 'Findings' }),
    ]));
  }
  return el('div', { class: 'stack' }, [
    pageHead({
      tag: 'Workspace',
      title: state.health?.name ?? 'Benda Inventory',
      where: `${state.items.length} building blocks in ${projects} project${projects === 1 ? '' : 's'}`,
    }),
    el('div', { class: 'tiles' }, tiles),
    el('div', { class: 'hint', text: 'Pick a building block to see its details, what it uses and what uses it – then describe a change below it: the agent gets the block with its relations as context.' }),
  ]);
}

function detailView() {
  if (!state.selected) return overview();
  const item = itemById(state.selected);
  const detail = state.detail;
  if (!detail) return el('div', { class: 'empty', text: 'Loading …' });
  if (detail.error) return el('div', { class: 'empty', text: detail.error });
  const link = editorLink(detail.file, detail.line);
  const file = `${detail.file}${detail.line ? `:${detail.line}` : ''}`;
  return el('div', {}, [
    pageHead({
      tag: [kindIcon(detail.kind), kindOf(detail.kind).label],
      style: kindStyle(detail.kind),
      title: detail.name,
      meta: true,
      where: [
        link ? el('a', { class: 'file', href: link, title: 'Open in editor', text: `${file} ↗` }) : el('span', { class: 'file', text: file }),
        el('span', { text: `${detail.project}${detail.group ? ` / ${detail.group}` : ''}` }),
        ...(detail.summary ? [el('code', { text: detail.summary })] : []),
      ],
    }),
    ...(item ? [] : [el('div', { class: 'hint', text: 'This item is no longer in the workspace.' })]),
  ]);
}

/**
 * The composer under the center: text field, chips, Template, Run with and the send button. `submit(fields)` gets the
 * POST /tasks fields of what is typed; `ready()` says whether the rest of the view allows sending.
 */
function composerBlock({ placeholder, label, ready = () => true, needsText = true, submit }) {
  const queueing = openTasks().length > 0;
  const triggers = composer.triggerHint();
  const keys = `${SEND_SHORTCUT} to send${triggers ? ` · ${triggers}` : ''}`;
  const hasText = () => !needsText || Boolean(state.instruction.trim() || state.template);
  const canSend = () => state.connected && Boolean(state.agent) && hasText() && ready();
  const sendState = () => ({
    disabled: !canSend(),
    title: !hasText() ? 'Describe the change' : !ready() ? 'Fill in the fields above' : queueing ? 'Starts when the tasks before it are finished' : '',
  });
  const sendNow = () =>
    canSend() &&
    submit({
      instruction: state.instruction.trim(),
      template: state.template,
      tags: state.tags,
      skills: state.skills,
      page: { url: location.href, title: document.title },
    });
  const field = composer.textField({ placeholder: `${placeholder} (${keys})`, onInput: () => Object.assign(send, sendState()), onSubmit: sendNow });
  const send = el('button', { class: 'primary send', text: queueing ? `Queue for ${agentName()}` : `${label} ${agentName()}`, onclick: sendNow });
  Object.assign(send, sendState());
  const hint = !state.connected
    ? `Bridge at ${BRIDGE} is not reachable – run “npx benda bridge”.`
    : !state.agent
      ? 'No agent available – check “claude” and “opencode” in benda.config.json.'
      : isClaude() && !state.watching
        ? 'Watch mode off: sent tasks reach Claude with your next prompt in Claude Code – or choose “New per task” under Run with.'
        : null;
  return {
    node: el('div', { class: 'composer' }, [
      field.node,
      ...[tokenList(), templatePicker(), agentPicker()].filter(Boolean),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'secondary copy',
          text: '⧉',
          title: 'Copy prompt – the context block of the last task, to paste into any other agent',
          'aria-label': 'Copy prompt',
          disabled: !state.lastPrompt,
          onclick: async () => {
            await navigator.clipboard.writeText(state.lastPrompt);
            showToast('Prompt copied to clipboard');
          },
        }),
        send,
      ]),
      ...(hint ? [el('div', { class: 'hint', text: hint })] : []),
    ]),
    field,
    refresh: () => Object.assign(send, sendState()),
  };
}

/** The composer for the selected item. */
function composerView() {
  if (!state.selected || !state.detail || state.detail.error) return null;
  return composerBlock({
    placeholder: `What should ${agentName()} do with ${state.detail.name}?`,
    label: 'Send to',
    submit: (fields) => composer.submit({ ...fields, subject: { id: state.selected } }),
  });
}

// ---------------------------------------------------------------- create

const creatableKinds = () => state.kinds.filter((k) => k.create);
/** "+ New" makes sense where a creatable kind fits: anywhere without a kind, else only for a creatable one. */
const creatable = (ctx) => (ctx.kind ? Boolean(kindOf(ctx.kind).create) : creatableKinds().length > 0) && state.places.length > 0;
const projectsOf = () => [...new Set(state.places.map((p) => p.project))];
const NEW_FOLDER = '__new__';

function openCreate(ctx) {
  const kinds = creatableKinds();
  const project = ctx.project ?? state.detail?.project ?? projectsOf()[0];
  state.create = {
    kind: ctx.kind && kindOf(ctx.kind).create ? ctx.kind : (kinds.find((k) => k.id === 'component') ?? kinds[0]).id,
    project,
    group: ctx.group ?? (ctx.project ? '' : (state.detail?.project === project ? state.detail.group : '')),
    newGroup: '',
    fields: {},
    spec: '',
    operations: [],
    bind: [],
  };
  state.selected = null;
  state.detail = null;
  history.replaceState(null, '', location.pathname);
  persist();
  render();
  if (kindOf(state.create.kind).create?.dataAccess) loadSpecs();
}

async function loadSpecs() {
  if (state.specs) return;
  try {
    state.specs = (await (await fetch(`${BRIDGE}/specs`)).json()).specs ?? [];
  } catch {
    state.specs = [];
  }
  render();
}

async function loadSpecDetail(file) {
  if (!file || state.specDetails[file]) return;
  try {
    state.specDetails[file] = await (await fetch(`${BRIDGE}/specs/detail?file=${encodeURIComponent(file)}`)).json();
  } catch {
    state.specDetails[file] = { operations: [] };
  }
  render();
}

/** The same choice the bridge makes: an item of that kind in the folder, else in the project, else anywhere. */
function referenceFor(c) {
  const group = c.group === NEW_FOLDER ? c.newGroup : c.group;
  const same = (i) => i.kind === c.kind;
  return state.items.find((i) => same(i) && i.project === c.project && i.group === group)
    ?? state.items.find((i) => same(i) && i.project === c.project)
    ?? state.items.find(same);
}

/** POST /tasks `create` from the form. */
function createSpec(c, mode) {
  return {
    kind: c.kind,
    name: (c.fields.name ?? '').trim(),
    project: c.project,
    group: c.group === NEW_FOLDER ? c.newGroup.trim() : c.group,
    fields: c.fields,
    mode,
    ...(kindOf(c.kind).create?.dataAccess ? { api: { spec: c.spec, operations: c.operations, bind: c.bind } } : {}),
  };
}

function createForm() {
  const c = state.create;
  const kind = kindOf(c.kind);
  const dataAccess = Boolean(kind.create?.dataAccess);
  const update = (change, rerender = true) => {
    Object.assign(c, change);
    persist();
    if (rerender) render();
    else block?.refresh();
  };
  const dropdown = (props, options, value) => {
    const node = el('select', props, options.map(([key, text]) => el('option', { value: key, text })));
    node.value = value;
    return node;
  };
  const groups = state.places.filter((p) => p.project === c.project);
  const rows = [
    el('label', { text: 'Kind' }),
    dropdown({ onchange: (e) => { update({ kind: e.target.value, fields: {} }); if (kindOf(e.target.value).create?.dataAccess) loadSpecs(); } }, creatableKinds().map((k) => [k.id, `${k.icon} ${k.label}`]), c.kind),
    el('label', { text: 'Place' }),
    el('div', { class: 'pair' }, [
      dropdown({ onchange: (e) => update({ project: e.target.value, group: '', bind: [] }) }, projectsOf().map((p) => [p, p]), c.project),
      dropdown({ onchange: (e) => update({ group: e.target.value }) }, [...groups.map((p) => [p.group, p.group ? p.group : '(project folder)']), [NEW_FOLDER, 'New folder …']], c.group),
      ...(c.group === NEW_FOLDER ? [el('input', { type: 'text', 'data-focus': 'new-folder', placeholder: 'folder name, e.g. orders', value: c.newGroup, oninput: (e) => update({ newGroup: e.target.value }, false) })] : []),
    ]),
  ];
  for (const field of kind.create?.fields ?? []) {
    rows.push(el('label', { text: `${field.label}${field.required ? ' *' : ''}` }));
    if (field.type === 'select') {
      rows.push(dropdown({ onchange: (e) => update({ fields: { ...c.fields, [field.id]: e.target.value } }) }, [['', '–'], ...field.options.map((o) => [o, o])], c.fields[field.id] ?? ''));
    } else if (field.type === 'item') {
      const options = state.items.filter((i) => i.kind === field.kind).sort((a, b) => Number(b.project === c.project) - Number(a.project === c.project) || a.name.localeCompare(b.name));
      rows.push(dropdown({ onchange: (e) => update({ fields: { ...c.fields, [field.id]: e.target.value } }) }, [['', '–'], ...options.map((i) => [i.id, `${i.name} · ${i.project}`])], c.fields[field.id] ?? ''));
    } else {
      rows.push(el('input', { type: 'text', 'data-focus': `field-${field.id}`, placeholder: field.placeholder ?? '', value: c.fields[field.id] ?? '', oninput: (e) => update({ fields: { ...c.fields, [field.id]: e.target.value } }, false) }));
    }
  }
  if (dataAccess) {
    const detail = state.specDetails[c.spec];
    rows.push(
      el('label', { text: 'API *' }),
      state.specs
        ? dropdown({ onchange: (e) => { update({ spec: e.target.value, operations: [] }); loadSpecDetail(e.target.value); } }, [['', '–'], ...state.specs.map((sp) => [sp.file, `${sp.title} ${sp.version} · ${sp.file}`])], c.spec)
        : el('span', { class: 'hint', text: 'Loading the specs …' }),
    );
    if (c.spec) {
      if (!detail) loadSpecDetail(c.spec);
      rows.push(
        el('label', { text: 'Operations *' }),
        el('div', { class: 'checks' }, (detail?.operations ?? []).map((op) => el('label', {}, [
          el('input', { type: 'checkbox', checked: c.operations.includes(op.operationId), onchange: (e) => update({ operations: e.target.checked ? [...c.operations, op.operationId] : c.operations.filter((o) => o !== op.operationId) }, false) }),
          `${op.method.toUpperCase()} ${op.path}`,
          el('code', { text: op.operationId }),
        ]))),
      );
    }
    const components = state.items.filter((i) => i.kind === 'component' && i.project === c.project).sort((a, b) => a.name.localeCompare(b.name));
    rows.push(
      el('label', { text: 'Use in' }),
      el('div', { class: 'checks' }, components.map((i) => el('label', {}, [
        el('input', { type: 'checkbox', checked: c.bind.includes(i.id), onchange: (e) => update({ bind: e.target.checked ? [...c.bind, i.id] : c.bind.filter((b) => b !== i.id) }, false) }),
        i.name,
        el('code', { text: i.group || '' }),
      ]))),
    );
  }
  const reference = referenceFor(c);
  const header = pageHead({
    tag: [kindIcon(c.kind), `New ${kind.label.toLowerCase()}`],
    style: kindStyle(c.kind),
    title: c.fields.name?.trim() || `New ${kind.label.toLowerCase()}`,
    where: reference
      ? ['Follows ', itemChip(reference), ' – same structure and conventions']
      : 'Nothing of this kind yet – the agent uses the project’s conventions.',
  });
  const ready = () =>
    Boolean(c.fields.name?.trim()) &&
    (c.group !== NEW_FOLDER || /^[\w.-]+$/.test(c.newGroup.trim())) &&
    (!dataAccess || (c.spec && c.operations.length > 0));
  const block = composerBlock({
    placeholder: dataAccess ? 'Optional: what the store should do beyond the operations' : `Optional: what the new ${kind.label.toLowerCase()} should do`,
    label: dataAccess ? 'Propose with' : 'Create with',
    ready,
    needsText: false,
    submit: async (fields) => {
      if (dataAccess) {
        const spec = createSpec(c, 'propose');
        const result = await composer.submit({ ...fields, instruction: proposeText(spec, fields.instruction), create: spec });
        if (result) {
          state.waiting = { since: new Date().toISOString(), create: spec, wishes: fields.instruction };
          state.create = null;
          persist();
          render();
        }
        return;
      }
      const result = await composer.submit({ ...fields, instruction: fields.instruction || `Create the ${kind.label.toLowerCase()} described below.`, create: createSpec(c, 'implement') });
      if (result) {
        state.create = null;
        persist();
        render();
        showToast(`${kind.label} ${c.fields.name.trim()} is on its way – it shows up here when the task is done`);
      }
    },
  });
  return {
    view: el('div', { class: 'stack' }, [header, el('div', { class: 'card' }, [el('div', { class: 'form' }, rows)]), el('div', { class: 'actions-row' }, [el('button', { class: 'secondary', text: 'Cancel', onclick: () => { state.create = null; persist(); render(); } })])]),
    block,
  };
}

/** Asks the agent for a data-access proposal through `npx benda proposal` – no file changes yet. */
function proposeText(spec, wishes) {
  const place = spec.group ? `${spec.project}/${spec.group}` : spec.project;
  return [
    `Propose the data access for a new store for the entity ${spec.name} in ${place}, over the operations ${spec.api.operations.join(', ')} of ${spec.api.spec}.`,
    'Do not change any project files. Look at the operations and their schemas in the spec, at the data-layer rules in AGENTS.md and at the store to follow (see Create).',
    'Propose the UI model fields (model, TypeScript type, the API field path they come from, the conversion), one store method per operation (read or write, with its mapper) and the files to create.',
    ...(wishes ? [`The user also wants: ${wishes}`] : []),
    ...proposalSteps({
      kind: 'data-access',
      name: spec.name,
      spec: spec.api.spec,
      rows: [{ model: '<UI model field>', type: '<TypeScript type>', dto: '<API field path, e.g. totalAmount.value>', conversion: '<conversion, or none>' }],
      methods: [{ storeMethod: '<store method or signal>', operation: '<operationId>', role: '<read|write>', mapper: '<mapper function>' }],
      files: [{ path: '<workspace-relative path>', purpose: '<model | mapper | mapper test | store>' }],
      notes: '<assumptions, open questions>',
    }),
  ].join('\n');
}

function waitingView() {
  const w = state.waiting;
  return el('div', { class: 'stack' }, [
    pageHead({ tag: '+ New store', title: `${w.create.name}Store` }),
    el('div', { class: 'status in-progress', text: '⚙︎ Waiting for the proposal … the agent submits it via “npx benda proposal”. It shows up here for you to check and change.' }),
    el('div', { class: 'actions-row' }, [el('button', { class: 'secondary', text: 'Stop waiting', onclick: () => { state.waiting = null; persist(); render(); } })]),
  ]);
}

/** New proposal from the bridge (SSE): only a data-access proposal asked for on this page. */
function onProposal(proposal) {
  if (!proposal || proposal.kind !== 'data-access' || !state.waiting) return;
  if (proposal.at < state.waiting.since || proposal.id === state.proposal?.id) return;
  state.proposal = { ...JSON.parse(JSON.stringify(proposal)), create: state.waiting.create };
  state.waiting = null;
  persist();
  render();
}

const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function proposalView() {
  const p = state.proposal;
  const edit = (list, i, key) => el('input', { 'data-focus': `${list === p.rows ? 'row' : 'method'}-${i}-${key}`, value: list[i][key], oninput: (e) => { list[i][key] = e.target.value; persist(); } });
  const table = (title, columns, list, keys, blank) => el('div', { class: 'card' }, [
    el('h2', { text: title }),
    el('table', {}, [
      el('tr', {}, [...columns.map((c) => el('th', { text: c })), el('th')]),
      ...list.map((row, i) => el('tr', {}, [
        ...keys.map((key) => el('td', {}, [edit(list, i, key)])),
        el('td', {}, [el('button', { class: 'icon', text: '✕', title: 'Remove', onclick: () => { list.splice(i, 1); persist(); render(); } })]),
      ])),
    ]),
    el('button', { class: 'icon', text: '+ Row', onclick: () => { list.push({ ...blank }); persist(); render(); } }),
  ]);
  return el('div', { class: 'stack' }, [
    pageHead({ tag: '+ New store · proposal', title: `${p.name}Store`, where: `${p.spec} · ${p.create.group ? `${p.create.project}/${p.create.group}` : p.create.project}` }),
    table('UI model', ['Field', 'Type', 'API field', 'Conversion'], p.rows, ['model', 'type', 'dto', 'conversion'], { model: '', type: '', dto: '', conversion: 'none' }),
    table('Store methods', ['Method', 'Operation', 'Role', 'Mapper'], p.methods, ['storeMethod', 'operation', 'role', 'mapper'], { storeMethod: '', operation: '', role: 'read', mapper: '' }),
    el('div', { class: 'card' }, [el('h2', { text: 'Files' }), el('ul', {}, p.files.map((f) => el('li', { text: `${f.path}${f.purpose ? ` – ${f.purpose}` : ''}` })))]),
    ...(p.notes ? [el('div', { class: 'card' }, [el('h2', { text: 'Notes from the agent' }), el('div', { class: 'hint', text: p.notes })])] : []),
    el('div', { class: 'actions-row' }, [el('button', { class: 'secondary', text: 'Discard', onclick: () => { state.proposal = null; persist(); render(); } })]),
  ]);
}

function implementText(p, wishes) {
  return [
    `Implement this confirmed data access for the new store ${p.name}Store (see Create):`,
    `UI model ${p.name}:`,
    '| Field | Type | API field | Conversion |',
    '|---|---|---|---|',
    ...p.rows.filter((r) => r.model.trim()).map((r) => `| ${[r.model, r.type, r.dto, r.conversion].map(cell).join(' | ')} |`),
    'Store methods:',
    '| Method | Operation | Role | Mapper |',
    '|---|---|---|---|',
    ...p.methods.filter((m) => m.storeMethod.trim() || m.operation.trim()).map((m) => `| ${[m.storeMethod, m.operation, m.role, m.mapper].map(cell).join(' | ')} |`),
    `Files: ${p.files.map((f) => f.path).join(', ') || 'as the data-layer rules say'}.`,
    ...(wishes ? [`The user also wants: ${wishes}`] : []),
    'Follow the data-layer rules in AGENTS.md: a readonly UI model (and a Draft type for writes), pure mappers with unit tests, a store over the generated client – reads with rxResource, isLoading and error, mutations as the rules describe – and use it in the components listed under Create.',
    'Run the mapper tests and `npx benda check`.',
  ].join('\n');
}

function proposalComposer() {
  const p = state.proposal;
  return composerBlock({
    placeholder: 'Optional: anything else for the implementation',
    label: 'Implement with',
    needsText: false,
    submit: async (fields) => {
      const result = await composer.submit({ ...fields, instruction: implementText(p, fields.instruction), create: { ...p.create, mode: 'implement' } });
      if (result) {
        state.proposal = null;
        persist();
        render();
        showToast(`${p.name}Store is on its way – it shows up here when the task is done`);
      }
    },
  });
}

function centerPane() {
  let content;
  let composerPart = null;
  if (state.proposal) {
    content = [proposalView()];
    composerPart = proposalComposer();
  } else if (state.waiting) content = [waitingView()];
  else if (state.create) {
    const form = createForm();
    content = [form.view];
    composerPart = form.block;
  } else {
    const detail = state.detail && !state.detail.error ? state.detail : null;
    const item = detail && itemById(state.selected);
    content = [detailView(), ...(detail ? [item && checksCard(item), item && impactCard(item), relationsCard(detail), ...detail.sections.map(sectionCard)].filter(Boolean) : [])];
    composerPart = composerView();
  }
  return {
    node: el('section', { class: 'pane center' }, [el('div', { class: 'detail' }, content), ...(composerPart ? [composerPart.node] : [])]),
    field: composerPart?.field ?? null,
  };
}

// ---------------------------------------------------------------- API view (the overlay's API tab)

function apiPane() {
  if (apiView) return el('section', { class: 'pane' }, [apiView.mount()]);
  import('./overlay-api.js').then(({ createApiView, API_STYLES }) => {
    document.head.append(el('style', { text: API_STYLES }));
    const sendTask = (instruction, context = '', template = null) =>
      composer.submit({ instruction: `${instruction}${context ? `\n${context}` : ''}`, template, items: [], page: { url: location.href, title: document.title } });
    const onImpact = (impact) => {
      state.impact = impact;
      render();
    };
    apiView ??= createApiView({ el, bridge: BRIDGE, request, showToast, sendTask, sendLabel, agentPicker, impact: Boolean(state.health?.capabilities?.impact), onImpact });
    render();
  });
  return el('section', { class: 'pane' }, [el('div', { class: 'empty', text: 'Loading …' })]);
}

// ---------------------------------------------------------------- page

function topBar() {
  const view = (id, text) =>
    el('button', { class: state.view === id ? 'on' : '', 'aria-pressed': String(state.view === id), text, onclick: () => { state.view = id; persist(); render(); } });
  const findings = state.check?.findings ?? [];
  const counts = LEVELS.map((level) => [level, findings.filter((f) => f.level === level).length]).filter(([, n]) => n);
  const checks = state.health?.capabilities?.check
    ? [el('button', {
        class: `tally${state.view === 'checks' ? ' on' : ''}${counts.length ? '' : ' ok'}`,
        title: 'Findings of npx benda check',
        onclick: () => { state.view = 'checks'; persist(); render(); loadCheck(); },
      }, counts.length ? counts.flatMap(([level, n], i) => [...(i ? [' · '] : []), el('span', { class: `lvl ${level}`, text: '● ' }), `${n} ${level}${n === 1 ? '' : 's'}`]) : ['✓ No findings'])]
    : [];
  return el('header', { class: 'top' }, [
    el('span', { class: 'brand' }, [el('span', { class: 'logo', 'aria-hidden': 'true', text: 'B' }), 'Benda Inventory']),
    ...(state.health?.name ? [el('span', { class: 'name', text: state.health.name })] : []),
    el('nav', { class: 'seg', 'aria-label': 'Views' }, [view('structure', 'Structure'), view('api', 'API')]),
    ...checks,
    el('span', { class: 'spacer' }),
    el('span', { class: 'conn', title: state.connected ? `Bridge at ${BRIDGE}` : `Bridge at ${BRIDGE} is not reachable` }, [
      el('span', { class: `dot${state.connected ? ' ok' : ''}` }),
      state.agent ? agentLabel(state.agent) : 'no agent',
    ]),
  ]);
}

function render() {
  if (!app) return;
  // keep scroll positions and typing across the rebuild
  const scroll = [...app.querySelectorAll('.tree, .detail, .side .list')].map((node) => node.scrollTop);
  const restoreTyping = composer.keepTyping(document);
  // form fields keep the focus too: status events rebuild the page while the user types
  const focused = document.activeElement?.dataset?.focus ? { key: document.activeElement.dataset.focus, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  const center = state.view === 'api'
    ? { node: apiPane(), field: null }
    : state.view === 'checks'
      ? { node: el('section', { class: 'pane center' }, [el('div', { class: 'detail' }, [checksView()])]), field: null }
      : centerPane();
  const open = openTasks().length;
  const tasks = el('section', { class: 'pane side' }, [
    el('div', { class: 'head' }, ['Tasks', ...(open ? [el('span', { class: 'count busy', title: `${open} open`, text: String(open) })] : [])]),
    tasksPanel(),
  ]);
  app.replaceChildren(
    topBar(),
    el('main', { class: state.view === 'api' ? 'main wide' : 'main' }, [...(state.view === 'api' ? [] : [treePane()]), center.node, tasks]),
  );
  [...app.querySelectorAll('.tree, .detail, .side .list')].forEach((node, i) => (node.scrollTop = scroll[i] ?? 0));
  if (center.field) restoreTyping(center.field);
  const again = focused && app.querySelector(`[data-focus="${CSS.escape(focused.key)}"]`);
  if (again) {
    again.focus();
    again.setSelectionRange?.(focused.start, focused.end);
  }
}

let events = null;

/**
 * Status stream of the bridge. A browser keeps only six connections per host open, and every tab with Benda holds one
 * – so a page in the background lets go of its stream and picks it up again when it is shown.
 */
function listen() {
  events = new EventSource(`${BRIDGE}/events`);
  events.onopen = () => {
    state.connected = true;
    loadAgents();
    render();
  };
  events.onerror = () => {
    state.connected = false;
    render();
  };
  events.onmessage = (message) => {
    const { tasks = [], watching, claude, proposal } = JSON.parse(message.data);
    onProposal(proposal);
    let changed = composer.updateClaude(claude) || state.watching !== watching;
    state.watching = watching;
    if (JSON.stringify(tasks) !== JSON.stringify(state.tasks)) {
      const wasOpen = new Set(openTasks().map((task) => task.id));
      const finished = tasks.filter((task) => wasOpen.has(task.id) && !OPEN_TASK.has(task.status));
      state.tasks = tasks;
      changed = true;
      const done = finished.find((task) => task.status === 'done');
      if (done) {
        showToast(`✓ ${taskAgent(done)} is done`);
        // the workspace event says so too, unless the bridge cannot watch the workspace
        loadInventory();
      }
    }
    if (changed) render();
  };
  // source files changed – by an agent, the editor or git
  events.addEventListener('workspace', () => !state.loading && loadInventory());
}

async function init() {
  document.head.append(el('style', { text: STYLES }));
  app = el('div', { class: 'app' });
  toast = el('div', { class: 'toast', hidden: true, role: 'status' });
  document.body.append(app, toast);
  restore();
  const fromHash = /^#item=(.+)$/.exec(location.hash)?.[1];
  if (fromHash) state.selected = decodeURIComponent(fromHash);
  try {
    state.health = await (await fetch(`${BRIDGE}/health`)).json();
    if (state.health.name) document.title = `Benda Inventory · ${state.health.name}`;
  } catch {
    /* the bridge answered this page, so it comes back – the status dot says so */
  }
  render();
  if (state.health && !state.health.capabilities?.inventory) {
    state.loading = false;
    state.error = `The ${state.health.adapter} adapter cannot list building blocks – the Inventory needs an adapter that supports it (e.g. @strokkur/benda-angular).`;
    render();
  } else loadInventory();
  listen();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      events?.close();
      events = null;
    } else if (!events) {
      listen();
      // the stream was closed while the page was hidden, so it missed what changed meanwhile
      if (!state.loading && state.health?.capabilities?.inventory) loadInventory();
    }
  });
  addEventListener('hashchange', () => {
    const id = /^#item=(.+)$/.exec(location.hash)?.[1];
    if (id) select(decodeURIComponent(id));
  });
}

init();
