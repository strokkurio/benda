'use strict';
// `ng add @strokkur/benda-angular`: installs Benda into an Angular workspace. Idempotent – safe to re-run.
// Projects that still carry a copy of the Angular AI Designer (designer/, src/designer.ts) are migrated.
//
// Plain functions on the schematic Tree instead of @angular-devkit/schematics helpers: from a `file:` link this
// file's real path has no node_modules, so only the workspace can resolve the devkit (see installTask()).
const { existsSync, readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { createServer } = require('node:net');
const { homedir } = require('node:os');
const { basename, join, posix, resolve } = require('node:path');
const { version } = require('../../package.json');

const CORE = '@strokkur/benda';
const ADAPTER = '@strokkur/benda-angular';
const CONFIG = 'benda.config.json';
// Starter tags for "#" in the panel – written once; a project that sets prompt.tags (also to []) keeps its own.
const DEFAULT_TAGS = [
  { id: 'sub-agents', label: 'Sub-agents', text: 'If the task has independent parts, hand them to sub-agents and run them in parallel.' },
];
const DEFAULT_PORT = 4399;
// node + path instead of `npx benda`: PreToolUse fires on every tool call, and npx adds noticeable startup time.
const hookCommand = (event) => `node "$CLAUDE_PROJECT_DIR/node_modules/@strokkur/benda/bin/benda.mjs" hook ${event}`;
const HOOKS = [
  ['UserPromptSubmit', 'user-prompt-submit'],
  ['PreToolUse', 'pre-tool-use'],
  ['Stop', 'stop'],
];

// What the Angular AI Designer installer created; removed only when its marker is present.
const LEGACY_DIR = 'designer';
const LEGACY_FILES = ['agents.mjs', 'api-index.mjs', 'bridge.mjs', 'cli.mjs', 'designer.config.json', 'dev.mjs', 'inspector-api.js', 'inspector-data.js', 'inspector.js', 'lib.mjs', 'lineage.mjs', 'source-index.mjs'];
const LEGACY_MARKERS = ['<!-- angular-ai-designer -->', '<!-- angular-ai-designer:data -->'];

const read = (tree, path) => tree.read(path)?.toString('utf8') ?? null;
const readJson = (tree, path, fallback) => {
  const text = read(tree, path);
  return text === null ? fallback : JSON.parse(text);
};
/** The text with "\n" line ends, and how to give it back the file's own (CRLF in a Windows checkout). */
const withLf = (text) => ({ text: text.replace(/\r\n/g, '\n'), restore: text.includes('\r\n') ? (t) => t.replace(/\n/g, '\r\n') : (t) => t });
const write = (tree, path, content) => (tree.exists(path) ? tree.overwrite(path, content) : tree.create(path, content));
const writeJson = (tree, path, data) => write(tree, path, JSON.stringify(data, null, 2) + '\n');

/** An AGENTS.md block: its marker line up to the next marker, the next `## ` heading after its own, or EOF. */
function blockRange(lines, marker) {
  const start = lines.indexOf(marker);
  if (start === -1) return null;
  let end = start + 1;
  let headings = 0;
  while (end < lines.length && !lines[end].startsWith('<!-- ') && !(lines[end].startsWith('## ') && headings++ > 0)) end++;
  return { start, end };
}

/** Replaces an AGENTS.md block in place (or removes it when `block` is empty); absent blocks are appended. */
function replaceBlock(text, marker, block = '') {
  const lines = text.split('\n');
  const range = blockRange(lines, marker);
  if (!range) return block ? `${text.trimEnd()}\n\n${block}` : text;
  const rest = lines.slice(range.end);
  return [...lines.slice(0, range.start), ...(block ? [...block.trimEnd().split('\n'), ''] : []), ...rest].join('\n');
}

const blockText = (text, marker) => {
  const lines = text.split('\n');
  const range = blockRange(lines, marker);
  return range && lines.slice(range.start, range.end).join('\n').trim();
};

const DATA_MARKER = '<!-- benda:data -->';

/** The data-layer rules for AGENTS.md, short; the skill's references/data-layer.md has the full set. */
const dataBlock = (dir) => `${DATA_MARKER}
## Data layer (OpenAPI)

- Layers: generated client (\`@api/<name>\`) → mapper (pure DTO ↔ UI model functions) → store (\`@Service()\`,
  \`rxResource\` over the client, \`computed\` signals, \`isLoading\`, \`error\`, mutations with optimistic update and
  rollback) → component (injects the store only, never imports \`@api/*\`).
- Use \`rxResource\` with the generated client, not \`httpResource\` (it would bypass the client).
- Generated code is regenerated, never edited. Specs live in \`${dir}/\` (\`<name>/<info.version>.yaml\`).
- Every mapper has unit tests; requests are built by a write mapper \`toXInput(draft)\`. Form validators come from
  the spec schema of the request body and agree in code and template.
- Before finishing a data task: run the mapper tests and \`npx benda check\`, and fix its errors.
- Full rules: \`references/data-layer.md\` in the Benda skill.
`;

/** Data blocks earlier Benda versions wrote; only these are replaced, so hand-edited blocks stay as they are. */
const OUTDATED_DATA_BLOCKS = [
  (dir) => `${DATA_MARKER}
## Data layer (OpenAPI)

- Layers: generated client (\`@api/<name>\`, never edited) → mapper (pure DTO ↔ UI model functions, unit-tested)
  → store (\`@Service()\`, \`rxResource\` over the client, \`computed\` signals, \`isLoading\`, \`error\`, mutations with
  optimistic update and rollback) → component (injects the store only, never imports \`@api/*\`).
- Use \`rxResource\` with the generated client, not \`httpResource\` (it would bypass the client).
- Specs live in \`${dir}/\` (\`<name>/<info.version>.yaml\`). After a spec change: regenerate the client and fix
  the mappers the compiler points at.
- Full rules: \`references/data-layer.md\` in the Benda skill.
`,
];

/**
 * Adds the data block, or brings one an earlier version wrote up to date. Returns the text and what happened:
 * 'added', 'updated', 'kept' (hand-edited, left alone) or 'current'.
 */
function withDataBlock(text, dir) {
  const existing = blockText(text, DATA_MARKER);
  const block = dataBlock(dir);
  if (existing === null) return { text: replaceBlock(text, DATA_MARKER, block), change: 'added' };
  if (existing === block.trim()) return { text, change: 'current' };
  const squash = (t) => t.replace(/\s+/g, ' ').trim();
  if (OUTDATED_DATA_BLOCKS.some((old) => squash(old(dir)) === squash(existing)))
    return { text: replaceBlock(text, DATA_MARKER, block), change: 'updated' };
  return { text, change: 'kept' };
}

/** `--agent`: "claude" or "opencode:<provider>/<model>"; anything else is a typo worth stopping for. */
function parseAgent(agent) {
  if (agent === undefined || agent === 'claude') return agent;
  const model = /^opencode:([^/\s]+)\/\S+$/.exec(agent);
  if (!model) throw new Error(`--agent must be "claude" or "opencode:<provider>/<model>", got "${agent}"`);
  return { id: agent, provider: model[1] };
}

function addImport(code, line) {
  const lastImport = [...code.matchAll(/^import .*;$/gm)].pop();
  const at = lastImport ? lastImport.index + lastImport[0].length : 0;
  return `${code.slice(0, at)}\n${line}${code.slice(at)}`;
}

/**
 * Bridge ports of the other projects on this machine. The bridge lists every workspace it ran in, in
 * ~/.benda/workspaces.json (a JSON array of paths); each project's own benda.config.json holds its port.
 */
function portsOfOtherProjects() {
  let workspaces = [];
  try {
    workspaces = JSON.parse(readFileSync(join(homedir(), '.benda', 'workspaces.json'), 'utf8'));
  } catch {}
  if (!Array.isArray(workspaces)) return [];
  return workspaces
    .filter((dir) => typeof dir === 'string' && resolve(dir) !== process.cwd() && existsSync(join(dir, CONFIG)))
    .map((dir) => {
      try {
        return Number(JSON.parse(readFileSync(join(dir, CONFIG), 'utf8')).port ?? DEFAULT_PORT);
      } catch {
        return DEFAULT_PORT;
      }
    });
}

const isFree = (port) =>
  new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });

/** First port from 4399 up that no other project, no app or mock of this one and no running process uses. */
async function pickPort(taken) {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 100; port++) if (!taken.has(port) && (await isFree(port))) return port;
  return DEFAULT_PORT;
}

/** The devkit's install task, resolved from the workspace (the Angular CLI always has it). */
function installTask(context) {
  try {
    const { NodePackageInstallTask } = createRequire(join(process.cwd(), 'package.json'))('@angular-devkit/schematics/tasks');
    context.addTask(new NodePackageInstallTask());
    return true;
  } catch {
    return false;
  }
}


exports.ngAdd = (options) => async (tree, context) => {
  const log = (msg) => context.logger.info(`  ${msg}`);
  const manualSteps = [];

  const angular = readJson(tree, 'angular.json', null);
  if (!angular) throw new Error('No angular.json found – run ng add inside an Angular workspace.');
  const allApps = Object.entries(angular.projects).filter(([, p]) => p.projectType === 'application');
  const requested = options.project ? String(options.project).split(',').map((name) => name.trim()).filter(Boolean) : [];
  const unknownApps = requested.filter((name) => !allApps.some(([n]) => n === name));
  if (unknownApps.length) throw new Error(`Unknown application(s): ${unknownApps.join(', ')}`);
  const apps = requested.length ? allApps.filter(([name]) => requested.includes(name)) : allApps;
  const agent = parseAgent(options.agent);

  context.logger.info(`Benda → ${process.cwd()}`);

  // 0. a copied Angular AI Designer: its settings move to benda.config.json, its runtime goes
  const legacy = read(tree, posix.join(LEGACY_DIR, 'lib.mjs'))?.includes('Angular AI Designer') ?? false;
  const legacyConfig = legacy ? readJson(tree, posix.join(LEGACY_DIR, 'designer.config.json'), {}) : {};
  if (legacy) {
    for (const file of LEGACY_FILES) {
      const path = posix.join(LEGACY_DIR, file);
      if (tree.exists(path)) tree.delete(path);
    }
    log(`removed     ${LEGACY_DIR}/ (copied Angular AI Designer runtime)`);
  }

  // 1. benda.config.json – merged, so settings like the OpenCode model filter survive re-runs
  const existing = { ...legacyConfig, ...readJson(tree, CONFIG, {}) };
  const pkg = readJson(tree, 'package.json', {});
  // A new project gets a port of its own, so it can run next to the other Benda projects on this machine.
  let picked = false;
  let port = Number(options.port ?? existing.port);
  if (!port) {
    const taken = new Set([
      ...portsOfOtherProjects(),
      ...allApps.map(([, p]) => Number(p.architect?.serve?.options?.port)),
      ...(existing.api?.mocks ?? []).map((mock) => Number(mock.port)),
    ]);
    port = await pickPort(taken);
    picked = port !== DEFAULT_PORT;
  }
  const config = {
    adapter: ADAPTER,
    // the bridge only serves the overlay to apps that name this project, see loadBenda({ name })
    name: existing.name ?? (pkg.name || basename(process.cwd())),
    opencode: { include: ['*'], autoApprove: true, timeoutMinutes: 15 },
    api: { dir: 'api', mocks: [] },
    ...existing,
    port,
  };
  // merged per field like the core does: `api: { mocks }` alone still has its dir
  config.api = { dir: 'api', mocks: [], ...existing.api };
  if (!config.prompt?.tags) config.prompt = { ...config.prompt, tags: DEFAULT_TAGS };
  if (agent === 'claude') delete config.claude;
  if (typeof agent === 'object') {
    // Local-only: OpenCode runs every task, so offer the chosen provider's models and give slower local models time.
    config.claude = false;
    config.defaultAgent = agent.id;
    if (!existing.opencode) config.opencode = { ...config.opencode, include: [`${agent.provider}/*`], timeoutMinutes: 30 };
  }
  const localOnly = config.claude === false;
  const model = typeof agent === 'object' ? agent.id.slice('opencode:'.length) : null;
  const globMatches = (glob) => new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(model);
  if (model && !config.opencode.include.some(globMatches)) {
    manualSteps.push(`${CONFIG}: opencode.include (${config.opencode.include.join(', ')}) does not offer ${model} – add "${agent.provider}/*"`);
  }
  writeJson(tree, CONFIG, config);
  log(`wrote       ${CONFIG} (project ${config.name}, port ${port}${picked ? ` – ${DEFAULT_PORT} is taken by another project or process` : ''}, ${localOnly ? `local-only, default ${config.defaultAgent ?? 'first OpenCode model'}` : 'Claude Code'}, OpenCode models: ${config.opencode.include.join(', ')})`);

  // 2. loadBenda() after bootstrap in each app – dev mode only, the overlay itself comes from the bridge
  const callOptions = [port !== DEFAULT_PORT && `port: ${port}`, `name: '${config.name.replace(/['\\]/g, '\\$&')}'`].filter(Boolean);
  const call = `loadBenda({ ${callOptions.join(', ')} })`;
  const importLine = `import { loadBenda } from '${ADAPTER}';`;
  for (const [name, project] of apps) {
    const sourceRoot = project.sourceRoot ?? posix.join(project.root, 'src');
    const legacyLoader = posix.join(sourceRoot, 'designer.ts');
    if (read(tree, legacyLoader)?.includes('loadDesigner')) {
      tree.delete(legacyLoader);
      log(`removed     ${legacyLoader}`);
    }
    // Native Federation moves bootstrapApplication() into bootstrap.ts
    const entry = ['bootstrap.ts', 'main.ts'].map((f) => posix.join(sourceRoot, f)).find((f) => read(tree, f)?.includes('bootstrapApplication('));
    if (!entry) {
      manualSteps.push(`${name}: call ${call} from '${ADAPTER}' after bootstrapApplication(...)`);
      continue;
    }
    let code = read(tree, entry);
    if (code.includes('loadDesigner')) {
      code = code.replace(/^import \{ loadDesigner \} from '\.\/designer';\n/m, '').replace(/loadDesigner\(\)/g, call);
    }
    if (code.includes('loadBenda')) {
      // any form of the import counts – Prettier's double quotes or more names in the braces
      if (!/import\s*\{[^}]*\bloadBenda\b[^}]*\}\s*from\s*['"]@strokkur\/benda-angular['"]/.test(code)) code = addImport(code, importLine);
      // port and name follow benda.config.json, also when a re-run changes them
      code = code.replace(/loadBenda\(\s*(\{[^}]*\})?\s*\)/g, call);
      if (code !== read(tree, entry)) {
        tree.overwrite(entry, code);
        log(`updated     ${entry}`);
      } else log(`unchanged   ${entry} (loadBenda already called)`);
      continue;
    }
    const patched = code.replace(/(bootstrapApplication\([^;]*?\))(\s*\.catch)/, `$1\n  .then(() => ${call})$2`);
    if (patched === code) {
      manualSteps.push(`${name}: in ${entry} call ${call} from '${ADAPTER}' after bootstrapApplication(...)`);
      continue;
    }
    tree.overwrite(entry, addImport(patched, importLine));
    log(`patched     ${entry}`);
  }

  // 3. Claude Code hooks: deliver browser selections on prompt submit, stream progress per tool call, report completion
  //    on stop. Local-only projects get none, and lose the ones an earlier Claude Code install added.
  const settingsPath = '.claude/settings.json';
  const settings = readJson(tree, settingsPath, {});
  settings.hooks ??= {};
  for (const [event, hook] of HOOKS) {
    const command = hookCommand(hook);
    settings.hooks[event] = (settings.hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: group.hooks?.filter((h) => !h.command?.includes('designer/cli.mjs') && (!localOnly || h.command !== command)) }))
      .filter((group) => group.hooks?.length);
    const present = settings.hooks[event].some((group) => group.hooks.some((h) => h.command === command));
    if (!localOnly && !present) settings.hooks[event].push({ hooks: [{ type: 'command', command, timeout: 10 }] });
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (tree.exists(settingsPath) || Object.keys(settings).length) {
    writeJson(tree, settingsPath, settings);
    log(`updated     ${settingsPath} (${localOnly ? 'no Benda hooks: local-only' : 'UserPromptSubmit, PreToolUse and Stop hooks'})`);
  }

  // 4. npm scripts and the core package (it provides the `benda` command)
  pkg.scripts ??= {};
  for (const name of ['designer', 'dev']) if (pkg.scripts[name]?.includes('designer/')) delete pkg.scripts[name];
  pkg.scripts.benda ??= 'benda bridge';
  pkg.scripts.dev ??= 'benda dev';
  const hasCore = Boolean(pkg.dependencies?.[CORE] ?? pkg.devDependencies?.[CORE]);
  if (!hasCore) pkg.devDependencies = { ...pkg.devDependencies, [CORE]: `^${version}` };
  writeJson(tree, 'package.json', pkg);
  log(`updated     package.json (scripts: benda, dev${hasCore ? '' : `; devDependency ${CORE}`})`);
  if (!hasCore && !installTask(context)) manualSteps.push('Run npm install');

  // 5. runtime state stays local
  const ignoreFile = withLf(read(tree, '.gitignore') ?? '');
  const gitignore = ignoreFile.text.replace(/\n*# Angular AI Designer runtime state\n\/\.designer\n?/, '\n');
  if (!gitignore.split('\n').includes('/.benda')) {
    write(tree, '.gitignore', ignoreFile.restore(`${gitignore.trimEnd()}\n\n# Benda runtime state\n/.benda\n`));
    log('updated     .gitignore');
  }

  // 6. project instructions in AGENTS.md, which OpenCode and most other agents read, so the agent knows the loop even
  //    without the skill loaded. Claude Code reads AGENTS.md only without a CLAUDE.md, so CLAUDE.md imports it.
  //    --agent rewrites the Benda block in place for the new mode; plain re-runs keep hand edits.
  // markers are found line by line, so a CRLF file would never match and get every block appended again
  const agentsFile = withLf(read(tree, 'AGENTS.md') ?? '');
  const claudeFile = withLf(read(tree, 'CLAUDE.md') ?? '');
  // `ln -s AGENTS.md CLAUDE.md` reads the same text: an import written into it would land in AGENTS.md itself
  const linked = tree.exists('AGENTS.md') && claudeFile.text.trim() !== '' && claudeFile.text === agentsFile.text;
  let agentsMd = agentsFile.text;
  let claudeMd = linked ? '' : claudeFile.text;
  for (const marker of LEGACY_MARKERS) claudeMd = replaceBlock(claudeMd, marker);
  // without an AGENTS.md all of CLAUDE.md moves, since OpenCode reads CLAUDE.md only while there is no AGENTS.md;
  // next to an existing one only the blocks earlier versions wrote move, hand edits included
  const moveAll = !tree.exists('AGENTS.md') && claudeMd.trim() !== '' && !/^@AGENTS\.md\s*$/m.test(claudeMd);
  if (moveAll) [agentsMd, claudeMd] = [claudeMd, ''];
  const moved = moveAll ? ['all'] : [];
  for (const marker of moveAll ? [] : ['<!-- benda -->', DATA_MARKER]) {
    const block = blockText(claudeMd, marker);
    if (!block) continue;
    claudeMd = replaceBlock(claudeMd, marker);
    if (!blockText(agentsMd, marker)) agentsMd = replaceBlock(agentsMd, marker, `${block}\n`);
    moved.push(marker);
  }
  const delivery = localOnly
    ? `- Elements selected in the browser (Alt+Shift+C, Mac: ⌥⇧C) are sent with a task to OpenCode; the task contains the
  context block "Benda – selection from the browser".`
    : `- Select elements in the browser with Alt+Shift+C (Mac: ⌥⇧C). The selection lands in \`.benda/selection.json\` and is
  attached through the UserPromptSubmit hook as the context block "Benda – selection from the browser".`;
  const watchMode = localOnly
    ? ''
    : `- Watch mode (default once the dev environment runs): start \`npx benda wait\` in the background. Without a running
  watcher, tasks sent from the browser only reach Claude with the next prompt. The command exits as soon as a task
  is sent and prints it. Start it again right after finishing the task.
- \`npx benda show\` prints the current selection.
`;
  const bendaBlock = `<!-- benda -->
## Benda (live selection in the browser)

- \`npm run dev\` starts the bridge (port ${port}) and all apps; \`npm run benda\` starts the bridge only.
${delivery}
- With such a context: change the file under "File to edit" (template of the owning component), follow its
  "Project rules" (\`prompt.rules\` in ${CONFIG}) or else the project's styling conventions and existing tokens, keep
  the change limited to the selection, then summarise briefly.
${watchMode}`;
  if (!agentsMd.includes('<!-- benda -->') || agent !== undefined) agentsMd = replaceBlock(agentsMd, '<!-- benda -->', bendaBlock);
  const data = withDataBlock(agentsMd, config.api.dir);
  agentsMd = agentsFile.restore(data.text.trimStart());
  if (agentsMd !== (read(tree, 'AGENTS.md') ?? '')) {
    write(tree, 'AGENTS.md', agentsMd);
    const from = moveAll ? ' (content of CLAUDE.md moved over)' : moved.length ? ' (Benda sections moved over from CLAUDE.md)' : '';
    log(`updated     AGENTS.md${from}${data.change === 'updated' ? ' (data-layer rules brought up to date)' : ''}`);
  }
  if (data.change === 'kept') log('kept        AGENTS.md data-layer rules (edited by hand; see references/data-layer.md in the skill)');
  // a local-only project needs no CLAUDE.md; one that is there gets the import all the same
  if (!linked && (!localOnly || tree.exists('CLAUDE.md')) && !/^@AGENTS\.md\s*$/m.test(claudeMd)) {
    claudeMd = `@AGENTS.md\n${claudeMd.trim() ? `\n${claudeMd.trimStart()}` : ''}`;
  }
  claudeMd = claudeFile.restore(claudeMd);
  if (!linked && claudeMd !== (read(tree, 'CLAUDE.md') ?? '')) {
    write(tree, 'CLAUDE.md', claudeMd);
    log('updated     CLAUDE.md (imports AGENTS.md for Claude Code)');
  }

  // YAML specs need a YAML parser from the workspace – Benda itself has no dependencies
  let hasYamlSpecs = false;
  tree.getDir(config.api.dir).visit((path) => {
    if (/\.ya?ml$/i.test(path)) hasYamlSpecs = true;
  });
  const hasYamlLib = ['yaml', 'js-yaml'].some((name) => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
  if (hasYamlSpecs && !hasYamlLib) manualSteps.push('YAML specs found but no YAML library: npm i -D yaml');

  if (manualSteps.length) {
    context.logger.warn('\nStill to do by hand:');
    for (const step of manualSteps) context.logger.warn(`  - ${step}`);
  }
  context.logger.info('\nDone. Start: npm run dev  (or: npm run benda + ng serve <app>)');
  if (localOnly) context.logger.info('Browser tasks run with OpenCode – `opencode models` must list the default model.');
  else context.logger.info('Claude Code picks up the hooks once it reloads them (open /hooks or restart the session).');
  if (legacy) context.logger.info('Old runtime state in .designer/ is no longer used and can be deleted.');
  return tree;
};
