// Maps Angular components seen in the browser (selector / class name) to their source files.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

const SCAN_ROOTS = ['projects', 'apps', 'libs', 'src'];
const CACHE_MS = 2000;
// workspace-relative with "/", as everywhere else in the adapter – on Windows `relative` returns "projects\\shell\\…"
const relPath = (workspace, file) => relative(workspace, file).split(sep).join('/');

function* walk(dir, ignored) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name)) yield* walk(join(dir, entry.name), ignored);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      yield join(dir, entry.name);
    }
  }
}

function projectOf(rel) {
  const [root, name] = rel.split('/');
  return root === 'projects' || root === 'apps' || root === 'libs' ? name : root;
}

function parseComponents(workspace, file) {
  const content = readFileSync(file, 'utf8');
  const components = [];
  for (const match of content.matchAll(/@Component\s*\(/g)) {
    const rest = content.slice(match.index);
    const cls = rest.match(/export\s+(?:default\s+)?class\s+(\w+)/);
    const decorator = cls ? rest.slice(0, cls.index) : rest;
    const selector = decorator.match(/selector:\s*['"`]([^'"`]+)['"`]/)?.[1];
    const templateUrl = decorator.match(/templateUrl:\s*['"`]([^'"`]+)['"`]/)?.[1];
    const rel = relPath(workspace, file);
    components.push({
      className: cls?.[1],
      selectors: (selector ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[a-z][\w-]*$/.test(s)),
      file: rel,
      templateFile: templateUrl ? relPath(workspace, join(dirname(file), templateUrl)) : rel,
      project: projectOf(rel),
    });
  }
  return components;
}

/** Scores template lines by shared classes, own text and tag to point the agent at the element. */
function templateHits(workspace, templateFile, element) {
  let lines;
  try {
    lines = readFileSync(join(workspace, templateFile), 'utf8').split('\n');
  } catch {
    return [];
  }
  const classes = new Set(element.classes ?? []);
  const text = element.ownText?.slice(0, 40);
  return lines
    .map((line, i) => {
      const tokens = line.split(/[\s"'`]+/);
      let score = tokens.filter((t) => classes.has(t)).length * 2;
      if (text && line.includes(text)) score += 6;
      // custom elements (component hosts) are distinctive, plain tags are not
      if (line.includes(`<${element.tag}`)) score += element.tag.includes('-') ? 3 : 1;
      return { line: i + 1, text: line.trim().slice(0, 120), score };
    })
    .filter((hit) => hit.score >= 3)
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, 3)
    .map(({ line, text }) => ({ line, text }));
}

/** Source index of one workspace. `stateDir` (Benda's runtime state) is skipped like build output. */
export function createSourceIndex(workspace, stateDir) {
  const ignored = new Set(['node_modules', 'dist', '.angular', '.git', basename(stateDir), 'coverage']);
  let cache = { builtAt: 0, components: [] };

  function index() {
    if (Date.now() - cache.builtAt < CACHE_MS) return cache.components;
    const components = [];
    for (const root of SCAN_ROOTS) {
      const dir = join(workspace, root);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of walk(dir, ignored)) {
        if (readFileSync(file, 'utf8').includes('@Component')) components.push(...parseComponents(workspace, file));
      }
    }
    cache = { builtAt: Date.now(), components };
    return components;
  }

  /**
   * Finds the component by host selector, then by (possibly underscore-prefixed) class name. Micro frontends often
   * repeat a selector per app: among its components the one with the class name wins, then the one in `info.project`.
   */
  function findComponent(info) {
    if (!info) return null;
    const components = index();
    const name = info.name?.replace(/^_+/, '');
    const bySelector = components.filter((c) => c.selectors.includes(info.selector));
    return (
      (name && bySelector.find((c) => c.className === name)) ||
      (info.project && bySelector.find((c) => c.project === info.project)) ||
      bySelector[0] ||
      components.find((c) => c.className === name) ||
      null
    );
  }

  /** Adds source locations to a browser selection item (mutates and returns it). */
  function enrichItem(item) {
    const owner = findComponent(item.owner);
    if (owner) {
      item.source = {
        file: owner.file,
        templateFile: owner.templateFile,
        project: owner.project,
        templateHits: templateHits(workspace, owner.templateFile, item.element ?? {}),
      };
    }
    const host = findComponent(item.component);
    if (host) item.hostSource = { file: host.file, templateFile: host.templateFile, project: host.project };
    if (!item.source && host) item.source = { ...item.hostSource, templateHits: [] };
    return item;
  }

  return { findComponent, enrichItem };
}
