// The `benda` command. Together with the context block (context.mjs) it is the contract with the skill.
//   dev [app...]   bridge + API mocks + the adapter's dev servers
//   bridge         bridge only
//   wait           blocks until the browser sends a task, prints it and exits (watch mode)
//   show           prints the current selection as Markdown
//   clear          discards the current selection
//   proposal [file]  reads a mapping or form proposal (JSON, from the file or stdin) and shows it in the overlay's
//                  Data tab, or a data-access proposal for the Inventory
//   components [file]  reads a component catalog (JSON, from the file or stdin) the agent took from the design system's
//                  MCP server and shows it in the overlay's Components tab
//   check [--json] [--level error|warning|info]
//                  static data-layer check of the whole workspace (adapter capability, no bridge needed);
//                  exits 1 if a finding reaches the level (default error)
//   hook <event>   called by the Claude Code hooks (no-ops when benda.config.json has "claude": false):
//     user-prompt-submit  injects a new browser selection into Claude's context
//     pre-tool-use        reports Claude's current step to the overlay while a task runs
//     stop                marks the delivered selection as done, with Claude's last message as summary
//   (user-prompt-submit and stop also note the session's model, which "Run with" shows)
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatSelection } from './context.mjs';
import { DELIVERABLE, claudeEnabled, describeStep, noteClaudeModel, readSelection, readStdin, registerWatcher, setStatus, writeActivity, writeComponents, writeProposal } from './lib.mjs';

async function userPromptSubmit() {
  const { prompt = '', transcript_path: transcript } = JSON.parse((await readStdin()) || '{}');
  noteClaudeModel(transcript);
  // Background-task notifications also fire UserPromptSubmit – only real user prompts may consume a selection.
  if (prompt.trimStart().startsWith('<task-notification>')) return;
  const selection = readSelection();
  if (!selection || !DELIVERABLE.has(selection.status)) return;
  setStatus('in-progress');
  writeActivity('Reading the task');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: formatSelection(selection) },
    }),
  );
}

async function preToolUse() {
  const { tool_name: name, tool_input: input } = JSON.parse((await readStdin()) || '{}');
  if (readSelection()?.status !== 'in-progress') return;
  const text = describeStep(name, input);
  if (text) writeActivity(text);
}

const MAX_SUMMARY = 2000;

async function stop() {
  // last_assistant_message, not the transcript: Claude Code writes the transcript asynchronously, it may lag behind
  const { last_assistant_message: message = '', transcript_path: transcript } = JSON.parse((await readStdin()) || '{}');
  noteClaudeModel(transcript);
  const summary = String(message).trim();
  setStatus('done', ['in-progress'], { summary: summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary });
}

const hooks = { 'user-prompt-submit': userPromptSubmit, 'pre-tool-use': preToolUse, stop };

async function wait() {
  registerWatcher();
  for (;;) {
    const selection = readSelection();
    if (selection?.status === 'pending') {
      setStatus('in-progress');
      writeActivity('Reading the task');
      console.log(formatSelection(selection));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

const PROPOSAL_SHAPES =
  'Expected a mapping { rows: [{ ui, model, dto, conversion }], component?, operation?, spec?, notes? }, a form ' +
  '{ kind: "form", rows: [{ ui, model, dto, conversion, widget, validators, options? }], form?, component?, operation?, spec?, notes? } ' +
  'or a data access { kind: "data-access", name, spec, rows: [{ model, type, dto, conversion }], ' +
  'methods: [{ storeMethod, operation, role: "read"|"write", mapper }], files: [{ path, purpose }], bind?, notes? }';

/** A store with model and mappers for the Inventory: the model fields, the store's methods and the files. */
function dataAccessProposal(input) {
  if (!Array.isArray(input.rows) || input.rows.some((r) => typeof r !== 'object' || !r.model)) throw new Error(PROPOSAL_SHAPES);
  return {
    ...input,
    rows: input.rows.map((r) => ({ model: String(r.model), type: String(r.type ?? ''), dto: String(r.dto ?? ''), conversion: String(r.conversion ?? 'none') })),
    methods: (Array.isArray(input.methods) ? input.methods : []).map((m) => ({
      storeMethod: String(m.storeMethod ?? ''),
      operation: String(m.operation ?? ''),
      role: m.role === 'write' ? 'write' : 'read',
      mapper: String(m.mapper ?? ''),
    })),
    files: (Array.isArray(input.files) ? input.files : []).map((f) => ({ path: String(f.path ?? f), purpose: String(f.purpose ?? '') })),
  };
}

// Agents may send lists where the overlay edits a comma-separated text ("required, maxLength 120").
const listText = (value) => (Array.isArray(value) ? value.join(', ') : String(value ?? ''));

/** Agents submit mapping and form proposals here; the overlay shows them as an editable table. */
async function proposal([file] = []) {
  // a file, because headless Claude Code refuses a JSON heredoc on the command line
  const input = JSON.parse(file ? readFileSync(resolve(file), 'utf8') : await readStdin());
  // removed only once it proved to be a proposal: a wrong path (angular.json) must not delete a project file
  const done = () => file && rmSync(resolve(file), { force: true });
  if (input.kind === 'data-access') {
    const proposal = dataAccessProposal(input);
    writeProposal({ ...proposal, id: Date.now().toString(36), at: new Date().toISOString() });
    done();
    console.log(`Data access proposal with ${proposal.rows.length} fields and ${proposal.methods.length} methods submitted – the user reviews it in the Inventory.`);
    return;
  }
  const isForm = input.kind === 'form';
  if (
    (input.kind !== undefined && input.kind !== 'mapping' && !isForm) ||
    !Array.isArray(input.rows) ||
    input.rows.some((r) => typeof r !== 'object' || !r.model)
  ) {
    throw new Error(PROPOSAL_SHAPES);
  }
  const rows = input.rows.map((r) => ({
    ui: String(r.ui ?? ''),
    model: String(r.model),
    dto: String(r.dto ?? ''),
    conversion: String(r.conversion ?? 'none'),
    ...(isForm ? { widget: listText(r.widget), validators: listText(r.validators), options: listText(r.options) } : {}),
  }));
  writeProposal({ ...input, rows, id: Date.now().toString(36), at: new Date().toISOString() });
  done();
  console.log(
    `${isForm ? 'Form proposal' : 'Proposal'} with ${rows.length} rows submitted – the user reviews it in the overlay's Data tab.`,
  );
}

const CATALOG_SHAPE =
  'Expected { source?, components: [{ name, snippet, description?, group?, import?: { name, from } }] } – snippet is ' +
  'the markup to insert (starting with its element), import the class a framework needs for it, if any';
const MAX_COMPONENTS = 2000;

/** The design system's components for the overlay's Components tab, as the agent read them from its MCP server. */
async function components([file] = []) {
  const input = JSON.parse(file ? readFileSync(resolve(file), 'utf8') : await readStdin());
  const list = Array.isArray(input) ? input : input.components;
  if (!Array.isArray(list) || !list.length) throw new Error(CATALOG_SHAPE);
  const text = (value, max) => String(value ?? '').trim().slice(0, max);
  const entries = list.slice(0, MAX_COMPONENTS).map((c) => {
    // the snippet is written into the project's templates as it is – it must at least be markup
    if (typeof c !== 'object' || !text(c.name, 1) || !/^<[a-zA-Z]/.test(text(c.snippet, 4000))) throw new Error(`${CATALOG_SHAPE}. Invalid: ${JSON.stringify(c)}`);
    const imported = c.import && { name: text(c.import.name, 200), from: text(c.import.from, 300) };
    if (imported && (!/^[A-Za-z_$][\w$]*$/.test(imported.name) || !/^[^'"`\s\\]+$/.test(imported.from))) throw new Error(`Invalid import of "${c.name}": ${JSON.stringify(c.import)}`);
    return {
      name: text(c.name, 200),
      snippet: text(c.snippet, 4000),
      description: text(c.description, 500),
      group: text(c.group, 100),
      ...(imported ? { import: imported } : {}),
    };
  });
  writeComponents({ source: text(input.source, 200), components: entries, at: new Date().toISOString() });
  if (file) rmSync(resolve(file), { force: true });
  console.log(`Component catalog with ${entries.length} components submitted – the user drags them into the page from the overlay's Components tab.`);
}

const commands = {
  dev: async (apps) => (await import('./dev.mjs')).runDev(apps),
  bridge: async () => (await import('./bridge.mjs')).startBridge(),
  wait,
  show: () => {
    const selection = readSelection();
    console.log(selection ? `Status: ${selection.status}\n\n${formatSelection(selection)}` : 'No selection.');
  },
  clear: () => setStatus('cleared'),
  proposal,
  components,
  check: async (args) => (await import('./check.mjs')).runCheck(args),
  hook: async ([event]) => {
    if (!hooks[event]) throw new Error(`Unknown hook "${event}" (${Object.keys(hooks).join(', ')})`);
    // A local-only project may still be opened in Claude Code – its prompts must not consume browser selections.
    // Neither may a headless run the bridge started (BENDA_HEADLESS): the selection belongs to the terminal session.
    if (claudeEnabled() && !process.env.BENDA_HEADLESS) await hooks[event]();
  },
};

export async function main([command, ...args]) {
  const run = commands[command];
  if (!run) {
    console.error(`Usage: benda <${Object.keys(commands).join('|')}>`);
    process.exit(1);
  }
  try {
    await run(args);
  } catch (err) {
    console.error(`[benda] ${[command, ...args].join(' ')} failed: ${err?.message ?? err}`);
    // Hooks must never block the user's prompt – report and continue.
    if (command !== 'hook') process.exit(1);
  }
}
