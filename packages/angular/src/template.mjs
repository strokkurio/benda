// Lightweight scan of Angular templates: elements with attributes and lines, control-flow aliases and which store
// signal an expression reads. Regex based on purpose: the Angular compiler is ESM-only and version-bound, and the
// lineage only needs references, not a full template AST.

export const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s=>/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/** `text` starts on line `startLine` of `file` (inline templates start inside the component's .ts file). */
export function scanTemplate(text, startLine = 1, file = null) {
  // comments keep their newlines so that offsets and lines stay valid
  text = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const breaks = [];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) breaks.push(i);
  const lineAt = (offset) => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (breaks[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return startLine + lo;
  };

  const elements = [];
  const stack = [];
  for (const match of text.matchAll(TAG)) {
    const [whole, closing, rawTag, rawAttrs, selfClosing] = match;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = stack.findLastIndex((e) => e.tag === tag);
      if (at !== -1) {
        stack[at].close = match.index;
        stack.length = at;
      }
      continue;
    }
    const attrsAt = match.index + 1 + rawTag.length;
    const attrs = [...rawAttrs.matchAll(ATTR)].map((a) => ({
      name: a[1],
      value: a[2] ?? a[3] ?? a[4] ?? null,
      line: lineAt(attrsAt + a.index),
    }));
    const element = {
      tag,
      attrs,
      parent: stack.at(-1) ?? null,
      start: match.index,
      end: match.index + whole.length,
      close: null,
      line: lineAt(match.index),
      endLine: lineAt(match.index + whole.length - 1),
    };
    elements.push(element);
    if (!selfClosing && !VOID.has(tag)) stack.push(element);
  }
  return { text, file, startLine, lineAt, elements };
}

/** Attribute by name, also as property binding: attr(el, 'maxlength') finds `maxlength`, `[maxlength]`, `[maxLength]`. */
export function attr(element, ...names) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const a of element.attrs) {
    const name = a.name.toLowerCase();
    const plain = name.replace(/^\[(attr\.)?|\]$/g, '');
    if (wanted.has(name) || wanted.has(plain)) return { ...a, bound: name.startsWith('[') };
  }
  return null;
}

export const isInside = (element, ancestor) => {
  for (let p = element.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
};

/** Children of an element in document order (direct and nested). */
export const descendants = (scan, ancestor) => scan.elements.filter((e) => isInside(e, ancestor));

/** The template element of the selected DOM element: by id / formcontrolname / name, else by the template line hit. */
export function locateElement(scan, item) {
  const element = item.element ?? {};
  const attributes = element.attributes ?? {};
  const tag = element.tag;
  for (const key of ['id', 'formcontrolname', 'name']) {
    const value = attributes[key];
    if (!value) continue;
    const found = scan.elements.find((e) => (!tag || e.tag === tag) && attr(e, key)?.value === value);
    if (found) return found;
  }
  for (const hit of item.source?.templateHits ?? []) {
    const found =
      scan.elements.find((e) => e.tag === tag && e.line <= hit.line && hit.line <= e.endLine) ??
      scan.elements.find((e) => e.tag === tag && e.line > hit.line && e.line <= hit.line + 3);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------- store signal references

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What a template expression reads from a store. `sources.stores`: component property → { store, signals }
 * (`store.customers()`); `sources.derived`: component signal/input → { store, signal } (`rows()`, `customer()`).
 */
function sourceOf(expr, sources, aliases) {
  expr = expr.trim();
  let m = expr.match(/^(?:this\.)?(\w+)\.(\w+)\(\)((?:\??\.\w+)*)/);
  if (m && sources.stores.get(m[1])?.signals.includes(m[2])) {
    return { store: sources.stores.get(m[1]).store, storeSignal: m[2], path: m[3].replace(/\?/g, '').slice(1) };
  }
  m = expr.match(/^(?:this\.)?(\w+)(?:\(\))?((?:\??\.\w+)*)/);
  const known = m && (aliases.get(m[1]) ?? sources.derived.get(m[1]));
  if (known) {
    const path = [known.path, m[2].replace(/\?/g, '').slice(1)].filter(Boolean).join('.');
    return { store: known.store, storeSignal: known.storeSignal ?? known.signal, path };
  }
  return null;
}

const ALIAS_PATTERNS = [
  /@for\s*\(\s*(?<alias>\w+)\s+of\s+(?<expr>[^;]+);/g,
  /\*ngFor\s*=\s*["']\s*let\s+(?<alias>\w+)\s+of\s+(?<expr>[^;"']+)/g,
  /@(?:else\s+)?if\s*\((?<expr>[^;]+);\s*as\s+(?<alias>\w+)\s*\)/g,
  /\*ngIf\s*=\s*["'](?<expr>[^";]+?)\s+as\s+(?<alias>\w+)/g,
  /@let\s+(?<alias>\w+)\s*=\s*(?<expr>[^;]+);/g,
];

/**
 * Control-flow aliases (`@for (c of …)`, `@if (…; as c)`, `@let`) by offset, `source` the store signal they stand for
 * or null – kept even then, because a second `@for (c of …)` ends what the first `c` meant.
 */
function aliasesOf(scan, sources) {
  const found = [];
  for (const pattern of ALIAS_PATTERNS) {
    for (const m of scan.text.matchAll(pattern))
      found.push({ alias: m.groups.alias, expr: m.groups.expr, at: m.index });
  }
  found.sort((a, b) => a.at - b.at);
  const aliases = [];
  const known = new Map();
  for (const a of found) {
    const source = sourceOf(a.expr, sources, known);
    known.set(a.alias, source);
    aliases.push({ ...a, source });
  }
  return aliases;
}

/** The aliases visible at an offset (declared before it; block scopes are not tracked). */
function aliasesAt(aliases, offset) {
  const map = new Map();
  for (const a of aliases) if (a.at < offset) map.set(a.alias, a.source);
  return map;
}

/** Resolves an expression at a template offset, e.g. the value of `[customer]="c"` inside `@for (c of …)`. */
export function resolveAt(scan, sources, expr, offset) {
  return sourceOf(expr, sources, aliasesAt(aliasesOf(scan, sources), offset));
}

/** Every read of a store signal and its fields: [{ store, storeSignal, field, line, file }]. */
export function templateBindings(scan, sources) {
  const bindings = [];
  const seen = new Set();
  const add = (source, field, offset) => {
    const path = [source.path, field].filter(Boolean).join('.') || null;
    const binding = {
      store: source.store,
      storeSignal: source.storeSignal,
      field: path,
      line: scan.lineAt(offset),
      file: scan.file,
    };
    const key = `${binding.storeSignal}|${binding.field}|${binding.line}`;
    if (!seen.has(key)) bindings.push(binding);
    seen.add(key);
  };
  // `c.name.trim()` reads c.name: a trailing method call is dropped from the path
  const pathFrom = (m, chain) => {
    const parts = chain.replace(/\?/g, '').split('.').filter(Boolean);
    if (scan.text[m.index + m[0].length] === '(') parts.pop();
    return parts.join('.') || null;
  };

  for (const [property, { store, signals }] of sources.stores) {
    const pattern = new RegExp(`(?<![.\\w])${escape(property)}\\.(\\w+)\\(\\)((?:\\??\\.\\w+)*)`, 'g');
    for (const m of scan.text.matchAll(pattern)) {
      if (signals.includes(m[1])) add({ store, storeSignal: m[1], path: '' }, pathFrom(m, m[2]), m.index);
    }
  }
  for (const [name, source] of sources.derived) {
    const pattern = new RegExp(`(?<![.\\w])${escape(name)}\\(\\)((?:\\??\\.\\w+)*)`, 'g');
    for (const m of scan.text.matchAll(pattern))
      add({ ...source, storeSignal: source.storeSignal ?? source.signal }, pathFrom(m, m[1]), m.index);
  }
  const aliases = aliasesOf(scan, sources);
  for (const a of aliases) {
    if (!a.source) continue;
    // up to the next alias of the same name: `@for (c of orders())` after `@for (c of customers())` is another `c`
    const end = aliases.find((b) => b.alias === a.alias && b.at > a.at)?.at ?? scan.text.length;
    const pattern = new RegExp(`(?<![.\\w])${escape(a.alias)}((?:\\??\\.\\w+)+)`, 'g');
    pattern.lastIndex = a.at;
    for (let m; (m = pattern.exec(scan.text)) && m.index < end;) {
      const path = pathFrom(m, m[1]);
      if (path) add(a.source, path, m.index);
    }
  }
  return bindings.sort((a, b) => a.line - b.line);
}
