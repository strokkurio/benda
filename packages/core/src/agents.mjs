// Agents that can handle a browser task – a harness, a model and the sessions it can run in ("Run with" shows all three):
//   claude              – the Claude Code session in the user's terminal (hooks / `benda wait`), session "terminal".
//                         Its model is the session's, as the hooks last saw it – Benda cannot choose it.
//   claude:<model>      – Claude Code, run headless by the bridge (`claude -p --output-format stream-json`)
//   opencode:<model>    – OpenCode, run headless by the bridge (`opencode run --standalone --format json`)
// Headless runs start a new session per task ("task") or continue one shared session per harness ("shared", its id in
// .benda/sessions.json). `"claude": false` removes both Claude variants.
// Runs are tracked in .benda/run.json, separate from selection.json, so they never displace a task that is waiting
// for the terminal session and survive the user clicking around meanwhile.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatSelection } from './context.mjs';
import { STATE_DIR, WORKSPACE, claudeEnabled, describeStep, readClaudeModel, readConfig, readSessions, writeSession } from './lib.mjs';

export const RUN_FILE = join(STATE_DIR, 'run.json');

/** "claude-opus-5-5" → "Opus 5.5"; ids of another shape stay as they are. */
function claudeModelName(id) {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=-|\[|$)/.exec(id);
  return match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}` : id;
}

/** null until the hooks have seen the session's model. */
export function claudeAgent() {
  const model = readClaudeModel();
  const modelLabel = model ? claudeModelName(model) : null;
  return {
    id: 'claude',
    kind: 'claude',
    harness: 'Claude Code',
    sessions: ['terminal'],
    modelLabel,
    label: modelLabel ? `Claude Code · ${modelLabel}` : 'Claude Code',
  };
}

const TOOLS_CACHE_MS = 60_000;
// Benda's own commands, which its tasks ask for (proposals, the data-layer check, the component catalog) – allowed in
// every headless Claude run
const BENDA_COMMANDS = ['Bash(npx benda proposal:*)', 'Bash(npx benda check:*)', 'Bash(npx benda components:*)'];
const HEADLESS_SESSIONS = ['task', 'shared'];

let toolsCache = { at: 0, opencodeModels: [], claudeCli: false };
let current = null; // { run, child } – the run object is shared by the event, exit and cancel handlers

function opencodeConfig() {
  return { bin: 'opencode', include: ['*'], autoApprove: true, timeoutMinutes: 15, ...readConfig().opencode };
}

/** `"claude"` in benda.config.json is false (no Claude at all) or the settings of headless runs. */
function claudeConfig() {
  const own = readConfig().claude;
  return { bin: 'claude', models: ['opus', 'sonnet', 'haiku'], permissionMode: 'acceptEdits', allowedTools: [], timeoutMinutes: 15, ...(own && typeof own === 'object' ? own : {}) };
}

function claudeCliAvailable() {
  return new Promise((resolve) => execFile(claudeConfig().bin, ['--version'], { cwd: WORKSPACE, timeout: 10_000 }, (err) => resolve(!err)));
}

/** "sonnet" → "Sonnet", a full id like "claude-opus-5-5" → "Opus 5.5". */
function claudeAliasLabel(model) {
  return model.startsWith('claude-') ? claudeModelName(model) : `${model[0].toUpperCase()}${model.slice(1)}`;
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

function opencodeModels() {
  return new Promise((resolve) => {
    execFile(opencodeConfig().bin, ['models'], { cwd: WORKSPACE, timeout: 20_000 }, (err, stdout) =>
      resolve(err ? [] : stdout.split('\n').map((line) => line.trim()).filter(Boolean)),
    );
  });
}

/**
 * Claude (unless disabled): the terminal session, plus headless models if the `claude` CLI runs here; then every
 * OpenCode model matching `opencode.include` in benda.config.json.
 */
export async function listAgents() {
  if (Date.now() - toolsCache.at > TOOLS_CACHE_MS) {
    const [opencodeModelList, claudeCli] = await Promise.all([opencodeModels(), claudeEnabled() ? claudeCliAvailable() : false]);
    toolsCache = { at: Date.now(), opencodeModels: opencodeModelList, claudeCli };
  }
  const include = opencodeConfig().include.map(globToRegExp);
  const opencode = toolsCache.opencodeModels
    .filter((model) => include.some((pattern) => pattern.test(model)))
    // "acme/acme/qwen" → "acme/qwen": providers that prefix their model ids repeat the provider name
    .map((model) => {
      const modelLabel = model.replace(/^([^/]+)\/\1\//, '$1/');
      return { id: `opencode:${model}`, kind: 'opencode', harness: 'OpenCode', sessions: HEADLESS_SESSIONS, model, modelLabel, label: `OpenCode · ${modelLabel}` };
    });
  if (!claudeEnabled()) return opencode;
  const headless = toolsCache.claudeCli
    ? claudeConfig().models.map((model) => {
        const modelLabel = claudeAliasLabel(model);
        return { id: `claude:${model}`, kind: 'claude-run', harness: 'Claude Code', sessions: HEADLESS_SESSIONS, model, modelLabel, label: `Claude Code · ${modelLabel}` };
      })
    : [];
  return [claudeAgent(), ...headless, ...opencode];
}

/** null lets the overlay fall back to the first listed agent. */
export function defaultAgentId() {
  return process.env.BENDA_DEFAULT_AGENT || readConfig().defaultAgent || (claudeEnabled() ? 'claude' : null);
}

export function readRun() {
  try {
    return JSON.parse(readFileSync(RUN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeRun(run) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${RUN_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(run, null, 2));
  renameSync(tmp, RUN_FILE);
}

function buildPrompt(task) {
  const where = task.items?.length ? 'the user selected these elements in the running app' : 'the user is on this page of the running app';
  return [
    'You are working in the project in the current directory. Follow the project rules from your instructions (AGENTS.md).',
    `Implement the following task from Benda (${where}).`,
    'This is a one-off run without the user: do not start the Benda watch mode, and do not wait for further tasks.',
    'Change only what the task needs. Finish with a short summary (1–3 sentences) of what you changed.',
    '',
    formatSelection(task),
  ].join('\n');
}

/**
 * Per-run OpenCode config: the project rules as instructions, and the selected model also as
 * small_model, so helper calls (titles, summaries) stay local instead of using the global default.
 */
function opencodeEnv(model) {
  let base = {};
  try {
    base = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
  } catch {
    /* ignore malformed user override */
  }
  // AGENTS.md holds the rules; CLAUDE.md only in projects an earlier Benda version set up
  const instructions = ['AGENTS.md', 'CLAUDE.md'].filter((file) => existsSync(join(WORKSPACE, file))).slice(0, 1);
  const config = { small_model: model, ...base, instructions: [...(base.instructions ?? []), ...instructions] };
  return { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

/**
 * What differs per harness: settings, command line, environment and how its event stream reads. Each event handler
 * returns true when the run changed. The prompt goes in through stdin, so its length never hits an argument limit.
 */
const RUNNERS = {
  opencode: {
    harness: 'OpenCode',
    config: opencodeConfig,
    args: (task, agent, config, resume) => [
      'run', '--standalone', '--model', agent.model, '--format', 'json',
      '--title', `Benda: ${(task.instruction || task.template?.label || '').slice(0, 50)}`,
      ...(config.autoApprove ? ['--auto'] : []),
      ...(resume ? ['--session', resume] : []),
    ],
    env: (agent) => opencodeEnv(agent.model),
    handle(run, event) {
      // every line carries the session, so even a run that fails early can be continued
      if (event.sessionID) run.sessionId = event.sessionID;
      if (event.type === 'tool_use') run.activity = describeStep(event.part?.tool, event.part?.state?.input ?? {}) ?? run.activity;
      else if (event.type === 'text' && event.part?.text) {
        run.summary = event.part.text.trim();
        run.activity = 'Writing summary';
      } else if (event.type === 'error') run.error = event.error?.message ?? 'Unknown OpenCode error';
      else return false;
      return true;
    },
  },
  claude: {
    harness: 'Claude Code',
    config: claudeConfig,
    args: (task, agent, config, resume) => [
      '-p', '--output-format', 'stream-json', '--verbose', '--model', agent.model, '--permission-mode', config.permissionMode,
      '--allowedTools', ...BENDA_COMMANDS, ...config.allowedTools,
      ...(resume ? ['--resume', resume] : []),
    ],
    // the project's Benda hooks belong to the terminal session – in this run they must not touch its selection
    env: () => ({ ...process.env, BENDA_HEADLESS: '1' }),
    handle(run, event) {
      if (event.session_id) run.sessionId = event.session_id;
      if (event.type === 'system' && event.subtype === 'init') {
        // an alias like "sonnet" resolves here to the model that really runs
        if (event.model) run.label = `Claude Code · ${claudeModelName(event.model)}`;
        run.activity = 'Reading the task';
      } else if (event.type === 'assistant') {
        for (const part of event.message?.content ?? []) {
          if (part.type === 'tool_use') run.activity = describeStep(part.name, part.input ?? {}) ?? run.activity;
          else if (part.type === 'text' && part.text?.trim()) {
            run.summary = part.text.trim();
            run.activity = 'Writing summary';
          }
        }
      } else if (event.type === 'result') {
        if (event.is_error || event.subtype !== 'success') run.error = String(event.result || event.subtype || 'Unknown Claude Code error');
        else if (event.result?.trim()) run.summary = event.result.trim();
      } else return false;
      return true;
    },
  },
};

const runnerOf = (agentId) => (agentId.startsWith('opencode:') ? RUNNERS.opencode : RUNNERS.claude);
const sessionKey = (runner) => (runner === RUNNERS.opencode ? 'opencode' : 'claude');

function finish(run, status, error = null) {
  if (run.status !== 'in-progress') return;
  Object.assign(run, { status, error, finishedAt: new Date().toISOString() });
  writeRun(run);
  current = null;
}

/**
 * Starts a headless run for a task ({ id, instruction, items, page, session }) with an agent ({ id, label, model }).
 * One run at a time. A "shared" task continues the harness's shared session and keeps its id for the next one.
 */
export function startRun(task, agent) {
  if (current) throw new Error('A run is already in progress.');
  const runner = runnerOf(agent.id);
  const config = runner.config();
  const key = sessionKey(runner);
  const shared = task.session === 'shared';
  const resume = shared ? (readSessions()[key] ?? null) : null;
  const run = {
    id: task.id,
    agent: agent.id,
    label: agent.label,
    session: task.session,
    sessionId: resume,
    instruction: task.instruction,
    status: 'in-progress',
    since: new Date().toISOString(),
    activity: `Starting ${runner.harness}`,
    summary: '',
    error: null,
  };
  writeRun(run);

  const child = spawn(config.bin, runner.args(task, agent, config, resume), { cwd: WORKSPACE, env: runner.env(agent), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // a process that dies at once closes stdin; the exit handler reports it
  child.stdin.end(buildPrompt(task));
  current = { run, child };

  const timer = setTimeout(() => cancelRun(`Timed out after ${config.timeoutMinutes} min`), config.timeoutMinutes * 60_000);
  let buffer = '';
  let stderr = '';
  const onLine = (line) => {
    if (run.status !== 'in-progress') return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!runner.handle(run, event)) return;
    if (shared && run.sessionId && run.sessionId !== readSessions()[key]) writeSession(key, run.sessionId);
    writeRun(run);
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) onLine(line);
  });
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  child.on('error', (err) => {
    clearTimeout(timer);
    finish(run, 'failed', err.code === 'ENOENT' ? `"${config.bin}" not found – is ${runner.harness} installed?` : err.message);
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (code === 0 && !run.error) return finish(run, 'done');
    const error = run.error ?? (stderr.trim() || `${config.bin} exited with code ${code}`);
    finish(run, 'failed', explainError(error, { shared: Boolean(resume) }));
  });
  return run;
}

const NEW_SESSION = 'Start a new shared session with ↺, then run the task again with ↻.';

// Provider errors come as raw API text ("litellm.BadRequestError: …"); the known kinds get their cause and the next
// step in front, the raw text stays below as the details.
const ERROR_KINDS = [
  {
    test: /image\(s\) may be provided|too many images|images? (?:limit|per (?:prompt|request))/i,
    explain: (raw, shared) => {
      const limit = raw.match(/at most (\d+) image/i)?.[1];
      const what = `The model accepts ${limit ? `at most ${limit}` : 'only a few'} images per prompt.`;
      return shared
        ? `${what} This shared session already holds more – screenshots the agent read in earlier tasks – so every further request fails. ${NEW_SESSION}`
        : `${what} The agent read more images (screenshots) in this task. Ask it not to read images, or use a model that accepts more.`;
    },
  },
  {
    test: /context (?:length|window)|maximum context|too many tokens|prompt is too long|input is too long|context_length_exceeded/i,
    explain: (raw, shared) =>
      shared
        ? `The conversation no longer fits the model's context. ${NEW_SESSION} Or use "New per task".`
        : "The task with the project rules and the harness's tool definitions does not fit the model's context. Raise the context length (Ollama: the model's context setting) or use a larger model.",
  },
  {
    test: /\b401\b|\b403\b|unauthori[sz]ed|invalid (?:api|x-api)[ -]?key|authentication|forbidden/i,
    explain: () => 'The model provider rejected the credentials. Check the login or API key of the harness for this provider.',
  },
  {
    test: /\b429\b|rate.?limit|quota|overloaded/i,
    explain: () => 'The provider is at its rate limit, quota or capacity. Wait a moment, then run the task again with ↻.',
  },
  {
    test: /econnrefused|fetch failed|connection (?:refused|error)|enotfound|socket hang up|getaddrinfo/i,
    explain: () => 'The model server cannot be reached. Is it running (e.g. `ollama serve`, the proxy) at the address the harness uses?',
  },
  {
    test: /model[^.\n]{0,40}(?:not found|does not exist)|no such model|unknown model|invalid model/i,
    explain: () => 'The provider does not know this model. Check the model id under "Run with" and in the harness config.',
  },
];

/** A failed run's error for the task list: cause and next step first when the kind is known, then the raw text. */
export function explainError(raw, { shared = false } = {}) {
  const kind = ERROR_KINDS.find((k) => k.test.test(raw));
  if (kind) return `${kind.explain(raw, shared)}\n\nDetails: ${raw}`;
  return shared ? `${raw}\n\nIf the shared session is gone, start a new one with ↺.` : raw;
}

/** The next "shared" task of the harness ("claude" | "opencode") starts a new session. */
export function resetSession(harness) {
  if (!['claude', 'opencode'].includes(harness)) throw new Error(`Unknown harness "${harness}"`);
  writeSession(harness, null);
}

export function cancelRun(reason = 'Cancelled') {
  if (!current) return null;
  const { run, child } = current;
  finish(run, 'cancelled', reason);
  child.kill('SIGTERM');
  return run;
}

/** A run left "in-progress" by a previous bridge process can never finish – mark it failed. */
export function recoverStaleRun() {
  const run = readRun();
  if (run?.status === 'in-progress') {
    Object.assign(run, { status: 'failed', error: 'Bridge restarted during the run' });
    writeRun(run);
  }
}
