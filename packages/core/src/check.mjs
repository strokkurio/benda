// `benda check`: the adapter's static data-layer check for the terminal and CI. The rules are framework-specific and
// live in the adapter's optional check() capability (contract in adapter.mjs); this module only runs and reports.
import { loadAdapter } from './adapter.mjs';

const LEVELS = ['info', 'warning', 'error'];

function parseArgs(args) {
  const options = { json: false, level: 'error' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--level') options.level = args[++i];
    else if (arg.startsWith('--level=')) options.level = arg.slice('--level='.length);
    else throw new Error(`Unknown option "${arg}". Usage: benda check [--json] [--level error|warning|info]`);
  }
  if (!LEVELS.includes(options.level)) throw new Error(`--level must be one of ${LEVELS.join(', ')}`);
  return options;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function report({ findings, stats }, failing, options) {
  const location = (f) => `${f.file}:${f.line}`;
  const width = Math.max(0, ...findings.map((f) => location(f).length));
  const ruleWidth = Math.max(0, ...findings.map((f) => f.rule.length));
  let file = null;
  for (const f of findings) {
    if (file !== null && f.file !== file) console.log('');
    file = f.file;
    console.log(`${location(f).padEnd(width)}  ${f.level.padEnd(7)}  ${f.rule.padEnd(ruleWidth)}  ${f.message}`);
    if (f.fix) console.log(`    fix: ${f.fix}`);
  }
  if (findings.length) console.log('');
  const count = (level) => findings.filter((f) => f.level === level).length;
  const files = new Set(findings.map((f) => f.file)).size;
  const { durationMs, ...counts } = stats;
  const scanned = Object.entries(counts)
    .map(([key, value]) => `${value} ${value === 1 ? key.replace(/s$/, '') : key}`)
    .join(', ');
  console.log(
    `${plural(count('error'), 'error')}, ${plural(count('warning'), 'warning')}, ${plural(count('info'), 'info')}` +
      `${findings.length ? ` in ${plural(files, 'file')}` : ''}` +
      `${scanned ? ` – checked ${scanned}` : ''} in ${(durationMs / 1000).toFixed(1)} s`,
  );
  console.log(
    failing.length
      ? `Failed: ${plural(failing.length, 'finding')} at level ${options.level} or above.`
      : `Passed (threshold: ${options.level}).`,
  );
}

export async function runCheck(args) {
  const options = parseArgs(args);
  const adapter = await loadAdapter();
  if (typeof adapter.check !== 'function') {
    const message = `The adapter "${adapter.name}" has no static check – nothing to do.`;
    console.log(
      options.json ? JSON.stringify({ supported: false, message, findings: [], stats: {} }, null, 2) : message,
    );
    return;
  }
  const started = performance.now();
  const result = await adapter.check();
  const findings = result?.findings ?? [];
  const stats = { ...result?.stats, durationMs: Math.round(performance.now() - started) };
  const threshold = LEVELS.indexOf(options.level);
  const failing = findings.filter((f) => LEVELS.indexOf(f.level) >= threshold);
  if (options.json) console.log(JSON.stringify({ supported: true, findings, stats }, null, 2));
  else report({ findings, stats }, failing, options);
  // exitCode instead of exit(): stdout must be flushed completely when piped in CI
  if (failing.length) process.exitCode = 1;
}
