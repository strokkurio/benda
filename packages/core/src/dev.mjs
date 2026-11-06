// `benda dev`: starts the bridge, the API mock servers from benda.config.json (`api.mocks`) and the adapter's dev
// servers (Angular: `ng serve` for every application, or only the ones passed as args).
//   benda dev           – bridge + mocks + all apps
//   benda dev shell     – bridge + mocks + only the shell
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadAdapter } from './adapter.mjs';
import { BIN, WORKSPACE, describePortOwner, portOwner, readConfig } from './lib.mjs';

const workspaceRequire = createRequire(join(WORKSPACE, 'package.json'));

/** Prism (`@stoplight/prism-cli`) serves example responses straight from an OpenAPI spec. */
function prismBin() {
  try {
    const pkgPath = workspaceRequire.resolve('@stoplight/prism-cli/package.json');
    const { bin } = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return join(pkgPath, '..', typeof bin === 'string' ? bin : bin.prism);
  } catch {
    return null;
  }
}
const COLORS = [35, 36, 33, 32, 34, 31];
const children = [];
let stopping = false;

function run(label, color, args) {
  // BENDA_WORKSPACE pins the bridge to this project even if a child's cwd lookup would find another config
  const child = spawn(process.execPath, args, { cwd: WORKSPACE, env: { ...process.env, FORCE_COLOR: '1', BENDA_WORKSPACE: WORKSPACE } });
  const prefix = `\x1b[${color}m${label.padEnd(14)}\x1b[0m│ `;
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = '';
    stream.setEncoding('utf8'); // "✔" split across two chunks would print as "�"
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  }
  child.on('exit', (code) => process.stdout.write(`${prefix}exited (${code ?? 'signal'})\n`));
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

export async function runDev(requested) {
  const adapter = await loadAdapter();
  // before anything starts: a failing adapter (no @angular/cli yet) must not leave a bridge running behind it
  const servers = adapter.devServers?.(requested) ?? [];
  const unknown = requested.filter((name) => !servers.some((server) => server.label === name));
  if (unknown.length) console.warn(`[benda] No app named ${unknown.map((name) => `"${name}"`).join(', ')} – starting ${servers.map((s) => s.label).join(', ') || 'no app'}.`);
  // Checked before anything starts: without its own bridge the apps would load the overlay from whoever holds the
  // port – possibly another project's bridge, which would then edit that project.
  const { port } = readConfig();
  const owner = await portOwner(port);
  if (owner && owner.workspace !== WORKSPACE) {
    console.error(`[benda] ${describePortOwner(port, owner)}`);
    process.exit(1);
  }
  if (owner) console.log(`[benda] ${describePortOwner(port, owner)} Using it.`);
  else {
    const bridge = run('benda', 90, [BIN, 'bridge']);
    // The apps are of no use to Benda without the bridge: stop everything rather than run on half set up.
    bridge.on('exit', (code) => {
      if (stopping) return;
      console.error('[benda] The bridge stopped – stopping the dev environment.');
      shutdown(code || 1);
    });
  }
  // `{ spec, port }` → Prism with the spec's examples; `{ script, port }` → your own Node mock (e.g. stateful,
  // with real filtering), started as `node <script> --port <port>`.
  for (const mock of readConfig().api?.mocks ?? []) {
    if (mock.script) {
      run(`mock:${mock.port}`, 90, [join(WORKSPACE, mock.script), '--port', String(mock.port)]);
      continue;
    }
    const bin = prismBin();
    if (!bin) {
      console.log(`[benda] Skipping mock for ${mock.spec}: install @stoplight/prism-cli (npm i -D @stoplight/prism-cli)`);
      continue;
    }
    run(`mock:${mock.port}`, 90, [bin, 'mock', join(WORKSPACE, mock.spec), '--port', String(mock.port), '--host', '127.0.0.1']);
  }
  servers.forEach((server, i) => run(server.label, COLORS[i % COLORS.length], server.args));

  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
}
