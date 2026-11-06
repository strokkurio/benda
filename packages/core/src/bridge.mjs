// Local bridge between the in-browser overlay and the coding agents (Claude Code, OpenCode).
//   GET  /overlay.js    – the overlay script (loaded by the app in dev mode), plus its lazy tabs (overlay-api.js,
//                         overlay-data.js, overlay-live.js, overlay-components.js), its network capture (overlay-network.js) and the
//                         modules it shares with other UIs (ui.js, composer.js, tasks-view.js)
//   GET  /adapter.js    – the framework adapter's browser module (see adapter.mjs)
//   GET  /health        – liveness check for the overlay, adapter name and capabilities
//   GET  /agents        – agents/models the overlay offers ("Run with")
//   GET  /prompt        – project rules, templates and tags from benda.config.json, plus the closing note
//   GET  /skills        – skills the harness of an agent can load (?agent=<id>), offered under "/"
//   GET  /events        – server-sent events with selection status and the task queue, and a `workspace` event when
//                         source files change (the Inventory reads the workspace again)
//   POST /selection     – stores a plain browser selection (no task) in .benda/selection.json
//   POST /tasks         – queues a task for an agent (.benda/tasks.json, see tasks.mjs)
//   POST /tasks/cancel  – cancels a queued or running task ({ id })
//   POST /tasks/retry   – queues a finished task again ({ id })
//   POST /tasks/clear   – removes the finished tasks
//   POST /sessions/reset – the next "shared" task of a harness starts a new session ({ harness: "claude" | "opencode" })
//   GET  /specs         – OpenAPI specs below api/ with their client generators
//   GET  /specs/detail  – operations and schemas of one spec (?file=api/…)
//   POST /specs         – adds a spec or a new version of one ({ text, overwrite })
//   POST /specs/generate – re-runs the client generator for a spec ({ file })
//   GET  /specs/operations – every operation with its path pattern, for matching the app's requests in the overlay
//   POST /specs/validate – checks responses against the spec ({ file, operationId, status, body } or { items: [...] })
//   GET  /specs/simulate – a response built from the spec (?file=…&operationId=…&mode=delay|empty|error-500|error-4xx)
//   POST /specs/impact  – what another version of an API breaks or offers in the app's mappers, stores and forms
//                         ({ from, to } spec files), if the adapter supports it
//   POST /lineage       – data lineage of a selected element, if the adapter supports it
//   GET  /inventory     – the Inventory: the workspace's building blocks, their details and tasks about them
//   GET  /inventory/items – the adapter's inventory of the workspace (kinds, items, relations), if it supports it
//   GET  /inventory/item – details of one item (?id=…) with the items that refer to it
//   GET  /components    – the component catalog an agent submitted with `benda components`
//   POST /components/insert – writes a catalog component before, after or into a dropped-on element, if the adapter
//                         supports it ({ name, position, item }); refused (409) when an agent must do it
//   GET  /check         – the adapter's workspace check (findings of `benda check`), if it supports it
// Binds to 127.0.0.1 and only answers requests to a localhost host name, and browser requests from (*.)localhost origins.
import { readFileSync, readdirSync, watch, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { loadAdapter } from './adapter.mjs';
import { RUN_FILE, claudeAgent, defaultAgentId, listAgents, recoverStaleRun, resetSession } from './agents.mjs';
import { addSpec, generateClient, impactInput, listSpecs, operationIndex, simulatedResponse, specDetail, validateResponse } from './api-index.mjs';
import { closingNote, formatSelection } from './context.mjs';
import { promptParts } from './prompt.mjs';
import { listSkills } from './skills.mjs';
import { addTask, cancelTask, clearFinished, retryTask, storeSelection, syncTasks, taskSummary } from './tasks.mjs';
import { ACTIVITY_FILE, CLAUDE_FILE, COMPONENTS_FILE, CONFIG_NAME, OVERLAY_DIR, PROPOSAL_FILE, SELECTION_FILE, WORKSPACE, claudeEnabled, describePortOwner, isWatching, portOwner, projectName, readActivity, readComponents, readConfig, readProposal, readSelection, registerWorkspace } from './lib.mjs';

// *.localhost too: browsers resolve it to the loopback address, so a local reverse proxy can serve the app under a name
const LOCAL_ORIGIN = /^https?:\/\/(([a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY = 5_000_000;
const clients = new Set();

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    // decodes across chunk borders – chunk by chunk, an "ü" split in two would become "�"
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      // a throw here would escape the handler's try/catch and end the bridge
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function statusEvent(selection, tasks) {
  const activity = readActivity();
  const payload = {
    id: selection?.id ?? null,
    status: selection?.status ?? 'none',
    since: selection?.updatedAt ?? null,
    // only steps taken for the current task, not leftovers from an earlier one
    activity: activity && selection?.updatedAt && activity.at >= selection.updatedAt ? activity.text : null,
    watching: isWatching(),
    tasks: tasks.map(taskSummary),
    proposal: readProposal(),
    // only the version: the overlay fetches the catalog itself when it changed
    components: readComponents()?.at ?? null,
    // the session's model changes with /model – "Run with" follows it
    claude: claudeEnabled() ? claudeAgent() : null,
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

let watching = isWatching();

function broadcast() {
  watching = isWatching();
  // every change of selection.json or run.json passes here, so the queue follows the agents
  const tasks = syncTasks();
  const event = statusEvent(readSelection(), tasks);
  for (const client of clients) client.write(event);
}

// Build output, dependencies and tool folders (.git, .benda, .angular, .vite, …) change without the source changing.
const NOT_SOURCE = new Set(['node_modules', 'dist', 'build', 'coverage', 'out-tsc', 'tmp']);
const isSource = (path) => path.split(/[\\/]/).every((part) => part && !part.startsWith('.') && !NOT_SOURCE.has(part) && !part.endsWith('~'));

/**
 * Tells the Inventory when files change – an agent, the editor or git renames, adds or deletes a building block.
 * Each source folder of the workspace gets a recursive watcher of its own, so node_modules is never watched (on Linux
 * every watched folder costs an inotify handle). Bursts (an agent writing ten files) arrive as one event.
 */
function watchWorkspace() {
  let timer = null;
  const changed = (filename) => {
    if (filename && !isSource(String(filename))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const event = `event: workspace\ndata: {}\n\n`;
      for (const client of clients) client.write(event);
    }, 400);
  };
  const folders = readdirSync(WORKSPACE, { withFileTypes: true }).filter((entry) => entry.isDirectory() && isSource(entry.name));
  try {
    // files at the top (angular.json, package.json) only, folders below have their own watcher
    const watchers = [
      watch(WORKSPACE, (type, filename) => folders.every((f) => f.name !== filename) && changed(filename)),
      ...folders.map((folder) => watch(join(WORKSPACE, folder.name), { recursive: true }, changed)),
    ];
    // a watched folder that is deleted ends its watcher with an error – the bridge goes on without it
    for (const watcher of watchers) watcher.on('error', () => watcher.close());
  } catch (err) {
    console.warn(`[benda] Cannot watch the workspace (${err.message}) – the Inventory reads it again when it is shown.`);
  }
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function startBridge() {
  const { port } = readConfig();
  const adapter = await loadAdapter();
  const scripts = new Map([
    ['/overlay.js', join(OVERLAY_DIR, 'overlay.js')],
    ['/overlay-api.js', join(OVERLAY_DIR, 'overlay-api.js')],
    ['/overlay-data.js', join(OVERLAY_DIR, 'overlay-data.js')],
    ['/overlay-network.js', join(OVERLAY_DIR, 'overlay-network.js')],
    ['/overlay-live.js', join(OVERLAY_DIR, 'overlay-live.js')],
    ['/ui.js', join(OVERLAY_DIR, 'ui.js')],
    ['/composer.js', join(OVERLAY_DIR, 'composer.js')],
    ['/tasks-view.js', join(OVERLAY_DIR, 'tasks-view.js')],
    ['/inventory.js', join(OVERLAY_DIR, 'inventory.js')],
    ['/overlay-components.js', join(OVERLAY_DIR, 'overlay-components.js')],
    ['/adapter.js', adapter.browserModule],
  ]);
  const enrichItem = (item) => adapter.enrichItem(item);

  /**
   * An inventory item as the Inventory shows it and a task carries it: the adapter's details, its relations with
   * the names of their targets, and the items that refer to it ("used by", "injected by", …).
   */
  function subjectOf(id) {
    const { items } = adapter.inventory();
    const { item, sections } = adapter.itemDetail(id);
    const byId = new Map(items.map((i) => [i.id, i]));
    const brief = (i) => ({ id: i.id, kind: i.kind, name: i.name, file: i.file });
    return {
      ...item,
      relations: item.relations.map((r) => ({ ...r, ...(r.target && byId.has(r.target) ? { item: brief(byId.get(r.target)) } : {}) })),
      incoming: items.flatMap((i) => i.relations.filter((r) => r.target === id).map((r) => ({ type: r.type, item: brief(i) }))),
      sections,
    };
  }

  /**
   * A new building block as the Inventory asks for it ({ kind, name, project, group, fields, api?, mode? }), checked
   * against the inventory: the folder it goes to, an existing item of the same kind to follow (same group, else same
   * project, else anywhere) and the field values with their labels.
   */
  function createOf(spec) {
    const { kinds, items, places = [] } = adapter.inventory();
    const kind = kinds.find((k) => k.id === spec.kind && k.create);
    if (!kind) throw new Error(`"${spec.kind}" cannot be created in the Inventory`);
    const name = String(spec.name ?? '').trim();
    if (!name) throw new Error(`The new ${kind.label.toLowerCase()} needs a name`);
    const group = String(spec.group ?? '').trim();
    if (!/^[\w.-]*(\/[\w.-]+)*$/.test(group)) throw new Error(`"${group}" is no folder name`);
    const base = places.find((p) => p.project === spec.project && p.group === '');
    if (!base) throw new Error(`Unknown project "${spec.project}"`);
    const place = places.find((p) => p.project === spec.project && p.group === group);
    const sameKind = (i) => i.kind === kind.id;
    const reference =
      items.find((i) => sameKind(i) && i.project === spec.project && i.group === group) ??
      items.find((i) => sameKind(i) && i.project === spec.project) ??
      items.find(sameKind);
    const fields = kind.create.fields
      .filter((f) => f.id !== 'name')
      .map((f) => {
        const value = spec.fields?.[f.id];
        if (f.type !== 'item') return { label: f.label, value: String(value ?? '').trim() };
        const item = items.find((i) => i.id === value);
        return { label: f.label, value: item ? `${item.name} (${item.file})` : '' };
      })
      .filter((f) => f.value);
    const api = kind.create.dataAccess && spec.api?.spec
      ? {
          spec: String(spec.api.spec),
          operations: (spec.api.operations ?? []).map(String),
          bind: (spec.api.bind ?? []).map((id) => items.find((i) => i.id === id)).filter(Boolean).map((i) => ({ name: i.name, file: i.file })),
        }
      : null;
    return {
      kind: kind.id,
      kindLabel: kind.label,
      name,
      project: spec.project,
      group,
      folder: place?.folder ?? `${base.folder}/${group}`,
      newFolder: !place,
      prefix: base.prefix ?? null,
      fields,
      reference: reference ? { name: reference.name, file: reference.file } : null,
      api,
      mode: spec.mode === 'propose' ? 'propose' : 'implement',
    };
  }

  /** A plain selection without a task: attached to the next prompt in Claude Code. */
  function selectionFromBody(body) {
    const items = Array.isArray(body.items) ? body.items.slice(0, 20).map(enrichItem) : [];
    const at = new Date().toISOString();
    const selection = { id: newId(), status: items.length ? 'selected' : 'cleared', instruction: '', template: null, tags: [], skills: [], page: body.page ?? {}, items, createdAt: at, updatedAt: at };
    storeSelection(selection);
    return selection;
  }

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    // Browsers always send Origin on cross-origin requests; foreign sites must not inject selections.
    if (origin && !LOCAL_ORIGIN.test(origin)) return send(res, 403, 'forbidden origin');
    // DNS rebinding: a foreign name resolving to 127.0.0.1 is same-origin to the browser, so its GETs carry no Origin
    if (!LOCAL_HOST.test(req.headers.host ?? '')) return send(res, 403, 'forbidden host');
    const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');

    try {
      if (req.method === 'OPTIONS') {
        return send(res, 204, '', { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      }
      if (req.method === 'GET' && scripts.has(pathname)) {
        // Two projects on the same port: the app of one would attach to the other's bridge and its selections would
        // be resolved – and edited – in the wrong workspace. The loader names its project, so refuse a stranger.
        const expected = pathname === '/overlay.js' ? searchParams.get('name') : null;
        if (expected && expected !== projectName()) {
          const message = `[benda] The bridge on port ${port} belongs to "${projectName()}" (${WORKSPACE}), not to "${expected}". Give each project its own port: "port" in ${CONFIG_NAME} and loadBenda({ port }).`;
          return send(res, 200, `console.warn(${JSON.stringify(message)});\n`, { ...cors, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        }
        const js = readFileSync(scripts.get(pathname), 'utf8');
        return send(res, 200, js, { ...cors, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      if (req.method === 'GET' && pathname === '/health') {
        return send(res, 200, { ok: true, name: projectName(), workspace: WORKSPACE, adapter: adapter.name, capabilities: { lineage: Boolean(adapter.lineage), impact: Boolean(adapter.impact), inventory: Boolean(adapter.inventory), check: Boolean(adapter.check), insert: Boolean(adapter.insert) }, editor: readConfig().editor ?? 'vscode' }, cors);
      }
      if (req.method === 'GET' && pathname === '/inventory') {
        return send(res, 200, readFileSync(join(OVERLAY_DIR, 'inventory.html'), 'utf8'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      if (req.method === 'GET' && pathname === '/inventory/items') {
        if (!adapter.inventory) return send(res, 404, `The ${adapter.name} adapter has no inventory`, cors);
        return send(res, 200, adapter.inventory(), cors);
      }
      if (req.method === 'GET' && pathname === '/inventory/item') {
        if (!adapter.itemDetail) return send(res, 404, `The ${adapter.name} adapter has no inventory`, cors);
        return send(res, 200, subjectOf(searchParams.get('id')), cors);
      }
      if (req.method === 'GET' && pathname === '/components') {
        return send(res, 200, readComponents() ?? { components: [] }, cors);
      }
      if (req.method === 'POST' && pathname === '/components/insert') {
        if (!adapter.insert) return send(res, 409, `The ${adapter.name} adapter cannot insert components itself`, cors);
        const { name, position, item } = await readBody(req);
        // the snippet comes from the catalog file, never from the request
        const component = readComponents()?.components.find((c) => c.name === name);
        if (!component) return send(res, 404, `"${name}" is not in the component catalog`, cors);
        return send(res, 200, adapter.insert({ item: enrichItem(item), position, component }), cors);
      }
      if (req.method === 'GET' && pathname === '/check') {
        if (!adapter.check) return send(res, 404, `The ${adapter.name} adapter has no check`, cors);
        return send(res, 200, adapter.check(), cors);
      }
      if (req.method === 'GET' && pathname === '/events') {
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(statusEvent(readSelection(), syncTasks()));
        clients.add(res);
        res.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && pathname === '/agents') {
        return send(res, 200, { agents: await listAgents(), defaultAgent: defaultAgentId() }, cors);
      }
      if (req.method === 'GET' && pathname === '/skills') {
        const agent = (await listAgents()).find((a) => a.id === searchParams.get('agent'));
        return send(res, 200, { skills: listSkills(agent) }, cors);
      }
      if (req.method === 'GET' && pathname === '/prompt') {
        const parts = promptParts();
        return send(res, 200, { ...parts, note: closingNote(parts.rules.length > 0) }, cors);
      }
      if (req.method === 'POST' && pathname === '/tasks') {
        const { task, ahead } = await addTask(await readBody(req), enrichItem, adapter.itemDetail ? { subject: subjectOf, create: createOf } : null);
        broadcast();
        return send(res, 200, { task: taskSummary(task), ahead, prompt: formatSelection(task) }, cors);
      }
      const taskAction = { '/tasks/cancel': cancelTask, '/tasks/retry': retryTask, '/tasks/clear': clearFinished }[pathname];
      if (req.method === 'POST' && taskAction) {
        taskAction((await readBody(req)).id);
        broadcast();
        return send(res, 200, { ok: true }, cors);
      }
      if (req.method === 'POST' && pathname === '/sessions/reset') {
        resetSession((await readBody(req)).harness);
        return send(res, 200, { ok: true }, cors);
      }
      if (req.method === 'GET' && pathname === '/specs') {
        return send(res, 200, listSpecs(), cors);
      }
      if (req.method === 'GET' && pathname === '/specs/detail') {
        return send(res, 200, specDetail(searchParams.get('file')), cors);
      }
      if (req.method === 'POST' && pathname === '/specs') {
        return send(res, 200, addSpec(await readBody(req)), cors);
      }
      if (req.method === 'POST' && pathname === '/specs/generate') {
        return send(res, 200, await generateClient((await readBody(req)).file), cors);
      }
      if (req.method === 'GET' && pathname === '/specs/operations') {
        return send(res, 200, operationIndex(), cors);
      }
      if (req.method === 'POST' && pathname === '/specs/validate') {
        const body = await readBody(req);
        if (!Array.isArray(body.items)) return send(res, 200, { issues: validateResponse(body) }, cors);
        // one failing item (e.g. a spec that was just removed) must not fail the whole batch
        const results = body.items.slice(0, 50).map((item) => {
          try {
            return { issues: validateResponse(item) };
          } catch (err) {
            return { error: String(err?.message ?? err) };
          }
        });
        return send(res, 200, { results }, cors);
      }
      if (req.method === 'GET' && pathname === '/specs/simulate') {
        const [file, operationId, mode] = ['file', 'operationId', 'mode'].map((key) => searchParams.get(key));
        return send(res, 200, simulatedResponse({ file, operationId, mode }), cors);
      }
      if (req.method === 'POST' && pathname === '/specs/impact') {
        if (!adapter.impact) return send(res, 404, `The ${adapter.name} adapter has no impact analysis`, cors);
        // the core diffs the specs, the adapter maps the diff onto the code generated from them
        const { diff, ...input } = impactInput(await readBody(req));
        const { items, summary } = await adapter.impact(input);
        return send(res, 200, { from: input.from, to: input.to, diff, items, summary }, cors);
      }
      if (req.method === 'POST' && pathname === '/lineage') {
        if (!adapter.lineage) return send(res, 404, `The ${adapter.name} adapter has no data lineage`, cors);
        const { item } = await readBody(req);
        return send(res, 200, adapter.lineage(enrichItem(item)), cors);
      }
      if (req.method === 'POST' && pathname === '/selection') {
        const selection = selectionFromBody(await readBody(req));
        return send(res, 200, { ...selection, prompt: formatSelection(selection) }, cors);
      }
      return send(res, 404, 'not found', cors);
    } catch (err) {
      return send(res, err?.status ?? 400, String(err?.message ?? err), cors);
    }
  });

  // Hooks and the CLI update the selection file from other processes – push every change to the overlay.
  watchFile(SELECTION_FILE, { interval: 400 }, broadcast);
  watchFile(ACTIVITY_FILE, { interval: 400 }, broadcast);
  watchFile(RUN_FILE, { interval: 400 }, broadcast);
  watchFile(PROPOSAL_FILE, { interval: 400 }, broadcast);
  watchFile(COMPONENTS_FILE, { interval: 400 }, broadcast);
  watchFile(CLAUDE_FILE, { interval: 1000 }, broadcast);
  watchWorkspace();
  setInterval(() => {
    if (isWatching() !== watching) broadcast();
  }, 1000).unref();
  setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, 20_000).unref();

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[benda] ${describePortOwner(port, (await portOwner(port)) ?? {})}`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, '127.0.0.1', () => {
    // only once the port is ours: a second bridge that fails with EADDRINUSE must not mark the live bridge's run stale
    recoverStaleRun();
    syncTasks(); // tasks queued before a restart continue
    console.log(`[benda] Bridge on http://localhost:${port} – project ${projectName()} – workspace ${WORKSPACE} – adapter: ${adapter.name} – default agent: ${defaultAgentId()}`);
    const sharing = registerWorkspace(port);
    if (sharing.length) {
      console.warn(`[benda] Port ${port} is also set in ${sharing.map((dir) => join(dir, CONFIG_NAME)).join(', ')} – these projects cannot run at the same time.`);
    }
  });
}
