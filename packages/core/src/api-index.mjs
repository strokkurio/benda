// OpenAPI specs of the workspace for the overlay's API view: discovery, detail, diff, adding
// specs/versions and re-running the client generator. Works with any layout below `api.dir`
// (default "api") and detects orval, openapi-generator (openapitools.json) and npm scripts.
// At runtime the overlay's network capture matches the app's requests to operations, validates responses against
// the spec and answers simulated requests (empty, error) with bodies derived from it.
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { WORKSPACE, readConfig } from './lib.mjs';

const SPEC_EXTENSIONS = new Set(['.yaml', '.yml', '.json']);
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const IGNORED_DIRS = new Set(['node_modules', '.git']);
const GENERATE_TIMEOUT_MS = 180_000;

const workspaceRequire = createRequire(join(WORKSPACE, 'package.json'));

function apiConfig() {
  return { dir: 'api', ...readConfig().api };
}

const apiDir = () => resolve(WORKSPACE, apiConfig().dir);
const rel = (file) => relative(WORKSPACE, file).split(sep).join('/');
const clean = (path) => (path ? normalize(path.replace(/^#\{cwd\}\//, '')).split(sep).join('/') : null);

// ---------------------------------------------------------------- parsing

let yamlParser;

/** The workspace's own YAML library ("yaml" or "js-yaml") – Benda ships without dependencies. */
function yaml() {
  if (yamlParser !== undefined) return yamlParser;
  for (const [name, parse] of [['yaml', (m) => m.parse], ['js-yaml', (m) => m.load]]) {
    try {
      yamlParser = parse(workspaceRequire(name));
      return yamlParser;
    } catch {
      /* try the next one */
    }
  }
  return (yamlParser = null);
}

export function parseSpecText(text) {
  if (text.trimStart().startsWith('{')) return JSON.parse(text);
  const parse = yaml();
  if (!parse) throw new Error('YAML specs need the "yaml" package in the workspace (npm i -D yaml)');
  return parse(text);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walk(path);
    } else if (SPEC_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      yield path;
    }
  }
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/);
  const pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (diff) return diff;
  }
  return String(a).localeCompare(String(b));
}

const refName = (ref) => ref.split('/').pop();

function typeOf(schema) {
  if (!schema) return 'any';
  if (schema.$ref) return refName(schema.$ref);
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (schema.allOf) return schema.allOf.map(typeOf).join(' & ');
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map(typeOf).join(' | ');
  let type = schema.type === 'array' ? `${typeOf(schema.items)}[]` : (schema.type ?? 'object');
  if (schema.format) type += ` (${schema.format})`;
  if (schema.nullable) type += ' | null';
  return type;
}

function resolveRef(doc, ref) {
  return ref.startsWith('#/') ? ref.slice(2).split('/').reduce((node, key) => node?.[key], doc) : null;
}

/** Properties incl. those inherited via allOf (local $refs only). */
function propertiesOf(schema, doc, seen = new Set()) {
  if (!schema) return [];
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return [];
    seen.add(schema.$ref);
    return propertiesOf(resolveRef(doc, schema.$ref), doc, seen);
  }
  const own = Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
    name,
    type: typeOf(prop),
    required: (schema.required ?? []).includes(name),
    description: prop.description ?? '',
    // form proposals take their validators from these, also for components without a store
    constraints: Object.fromEntries(
      ['maxLength', 'minLength', 'minimum', 'maximum', 'pattern'].filter((k) => prop[k] != null).map((k) => [k, prop[k]]),
    ),
  }));
  return [...(schema.allOf ?? []).flatMap((part) => propertiesOf(part, doc, seen)), ...own];
}

function contentType(node, doc) {
  const target = node?.$ref ? resolveRef(doc, node.$ref) : node;
  const content = target?.content;
  if (!content) return null;
  const media = content['application/json'] ?? Object.values(content)[0];
  return typeOf(media?.schema);
}

function operationsOf(doc) {
  const operations = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      operations.push({
        method,
        path,
        operationId: op.operationId ?? null,
        summary: op.summary ?? '',
        tags: op.tags ?? [],
        deprecated: Boolean(op.deprecated),
        parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => {
          const param = p.$ref ? resolveRef(doc, p.$ref) ?? { name: refName(p.$ref) } : p;
          return { name: param.name, in: param.in, required: Boolean(param.required), type: typeOf(param.schema) };
        }),
        requestBody: contentType(op.requestBody, doc),
        responses: Object.entries(op.responses ?? {}).map(([status, response]) => ({
          status,
          description: (response.$ref ? resolveRef(doc, response.$ref) : response)?.description ?? '',
          type: contentType(response, doc),
        })),
      });
    }
  }
  return operations;
}

const schemasOf = (doc) => doc.components?.schemas ?? doc.definitions ?? {};

// ---------------------------------------------------------------- generators

function scriptGenerators() {
  const scripts = JSON.parse(readFileSync(join(WORKSPACE, 'package.json'), 'utf8')).scripts ?? {};
  return Object.entries(scripts)
    .filter(([, cmd]) => /openapi-generator(-cli)?\s+generate/.test(cmd))
    .map(([name, cmd]) => ({
      tool: 'openapi-generator',
      config: `package.json → scripts.${name}`,
      input: clean(cmd.match(/(?:-i|--input-spec)[\s=]+(\S+)/)?.[1]),
      output: clean(cmd.match(/(?:-o|--output)[\s=]+(\S+)/)?.[1]),
      command: `npm run ${name}`,
    }));
}

function openapiToolsGenerators() {
  const file = join(WORKSPACE, 'openapitools.json');
  if (!existsSync(file)) return [];
  const generators = JSON.parse(readFileSync(file, 'utf8'))['generator-cli']?.generators ?? {};
  return Object.entries(generators).map(([key, g]) => ({
    tool: `openapi-generator (${g.generatorName ?? '?'})`,
    config: `openapitools.json → ${key}`,
    input: clean(g.inputSpec),
    output: clean(g.output),
    command: `npx @openapitools/openapi-generator-cli generate --generator-key ${key}`,
  }));
}

/** `{ … }` at the start of `text` up to its closing brace, or null. */
function balanced(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(0, i + 1);
  }
  return null;
}

function orvalGenerators() {
  const file = ['orval.config.ts', 'orval.config.js', 'orval.config.mjs', 'orval.config.cjs']
    .map((name) => join(WORKSPACE, name))
    .find(existsSync);
  if (!file) return [];
  const text = readFileSync(file, 'utf8');
  const targetIn = (s) => s.match(/\btarget\s*:\s*['"`]([^'"`]+)/)?.[1];
  // an output shared by several specs: `output: shared` or `output: { ...shared, clean: true }`
  const constantTarget = (name) => {
    const at = text.search(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b[^=]*=`));
    const object = at < 0 ? null : balanced(text.slice(text.indexOf('=', at) + 1).trimStart());
    return object ? targetIn(object) : undefined;
  };
  // Light-weight scan instead of executing the config: every `input:` with the output that follows it.
  return text
    .split(/\binput\s*:/)
    .slice(1)
    .map((part) => {
      const at = part.search(/\boutput\s*:/);
      const output = at < 0 ? '' : part.slice(at);
      const value = output.slice(output.indexOf(':') + 1).trimStart();
      // the output object only, so a later project's target is not taken for it
      const object = value.startsWith('{') ? balanced(value) : null;
      const reference = object ? object.match(/\.\.\.\s*([A-Za-z_$][\w$]*)/)?.[1] : value.match(/^[A-Za-z_$][\w$]*/)?.[0];
      return {
        tool: 'orval',
        config: rel(file),
        input: clean(part.match(/['"`]([^'"`]+)['"`]/)?.[1]),
        output: clean(
          (object ? targetIn(object) : undefined) ??
            (reference && constantTarget(reference)) ??
            output.match(/output\s*:\s*['"`]([^'"`]+)/)?.[1],
        ),
        command: 'npx orval',
      };
    });
}

export function detectGenerators() {
  const override = apiConfig().generate;
  const found = [...orvalGenerators(), ...openapiToolsGenerators(), ...scriptGenerators()];
  return override ? found.map((g) => ({ ...g, command: override })) : found;
}

// ---------------------------------------------------------------- public API

export function listSpecs() {
  const dir = apiDir();
  const generators = detectGenerators();
  const specs = [];
  if (existsSync(dir)) {
    for (const file of walk(dir)) {
      let doc;
      try {
        doc = parseSpecText(readFileSync(file, 'utf8'));
      } catch (err) {
        specs.push({ file: rel(file), error: err.message });
        continue;
      }
      if (!doc || typeof doc !== 'object' || (!doc.openapi && !doc.swagger)) continue;
      const path = rel(file);
      specs.push({
        file: path,
        title: doc.info?.title ?? basename(file),
        version: String(doc.info?.version ?? '?'),
        description: doc.info?.description ?? '',
        openapi: String(doc.openapi ?? doc.swagger),
        operations: operationsOf(doc).length,
        schemas: Object.keys(schemasOf(doc)).length,
        generators: generators.filter((g) => g.input === path),
      });
    }
  }
  specs.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '') || compareVersions(a.version, b.version));
  return { dir: rel(dir), specs, generators };
}

function safeSpecPath(file) {
  const abs = resolve(WORKSPACE, String(file));
  if (!abs.startsWith(apiDir() + sep)) throw new Error('Spec must be inside the API folder');
  return abs;
}

export function specDetail(file) {
  const doc = parseSpecText(readFileSync(safeSpecPath(file), 'utf8'));
  return {
    file,
    title: doc.info?.title ?? file,
    version: String(doc.info?.version ?? '?'),
    description: doc.info?.description ?? '',
    openapi: String(doc.openapi ?? doc.swagger),
    servers: (doc.servers ?? []).map((s) => s.url),
    operations: operationsOf(doc),
    schemas: Object.entries(schemasOf(doc)).map(([name, schema]) => ({
      name,
      type: typeOf(schema),
      description: schema.description ?? '',
      properties: propertiesOf(schema, doc),
    })),
    generators: detectGenerators().filter((g) => g.input === file),
  };
}

/** What changed between two specs: operations, schemas and schema properties. */
export function diffSpecs(fromDoc, toDoc) {
  const ops = (doc) => new Set(operationsOf(doc).map((o) => `${o.method.toUpperCase()} ${o.path}`));
  const [opsA, opsB] = [ops(fromDoc), ops(toDoc)];
  const [schemasA, schemasB] = [schemasOf(fromDoc), schemasOf(toDoc)];
  const props = (doc, schema) => new Set(propertiesOf(schema, doc).map((p) => p.name));
  const changedSchemas = Object.keys(schemasB)
    .filter((name) => schemasA[name])
    .map((name) => {
      const [a, b] = [props(fromDoc, schemasA[name]), props(toDoc, schemasB[name])];
      return { name, added: [...b].filter((p) => !a.has(p)), removed: [...a].filter((p) => !b.has(p)) };
    })
    .filter((s) => s.added.length || s.removed.length);
  return {
    addedOperations: [...opsB].filter((o) => !opsA.has(o)),
    removedOperations: [...opsA].filter((o) => !opsB.has(o)),
    addedSchemas: Object.keys(schemasB).filter((n) => !schemasA[n]),
    removedSchemas: Object.keys(schemasA).filter((n) => !schemasB[n]),
    changedSchemas,
  };
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'api';

/** Stores a pasted/uploaded spec as a new spec or a new version of an existing one. */
export function addSpec({ text, overwrite = false }) {
  const doc = parseSpecText(String(text ?? ''));
  if (!doc || typeof doc !== 'object' || (!doc.openapi && !doc.swagger)) throw new Error('Not an OpenAPI/Swagger document');
  const title = doc.info?.title;
  const version = doc.info?.version;
  if (!title || !version) throw new Error('The spec needs info.title and info.version');

  const siblings = listSpecs().specs.filter((s) => s.title === title && !s.error);
  // Versions of one API live together; a flat layout (spec directly in api/) gets its own folder.
  const existingDir = siblings[0] && dirname(resolve(WORKSPACE, siblings[0].file));
  const folder = existingDir && existingDir !== apiDir() ? existingDir : join(apiDir(), slug(title));
  const target = join(folder, `${String(version).replace(/[^\w.-]/g, '_')}${text.trimStart().startsWith('{') ? '.json' : '.yaml'}`);
  if (existsSync(target) && !overwrite) throw Object.assign(new Error(`${rel(target)} already exists`), { status: 409 });

  mkdirSync(folder, { recursive: true });
  writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`);

  const previous = siblings.filter((s) => s.file !== rel(target) && compareVersions(s.version, version) < 0).at(-1);
  const diff = previous ? diffSpecs(parseSpecText(readFileSync(resolve(WORKSPACE, previous.file), 'utf8')), doc) : null;
  return { file: rel(target), title, version: String(version), previous: previous ? { file: previous.file, version: previous.version } : null, diff };
}

/** Re-runs the generator(s) whose input is the given spec. */
export function generateClient(file) {
  const generators = detectGenerators().filter((g) => g.input === file);
  if (!generators.length) return Promise.reject(new Error(`No client generator is configured for ${file}`));
  const commands = [...new Set(generators.map((g) => g.command))];
  return new Promise((done) => {
    exec(commands.join(' && '), { cwd: WORKSPACE, timeout: GENERATE_TIMEOUT_MS, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      // eslint-disable-next-line no-control-regex -- strip ANSI colours from the generator's output
      const output = `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-15).join('\n');
      done({ ok: !err, command: commands.join(' && '), output });
    });
  });
}

// ---------------------------------------------------------------- runtime: matching, validation, simulation

const MAX_ISSUES = 50;
const MAX_REF_HOPS = 20;
const SIMULATED_DELAY_MS = 2000;
const docCache = new Map(); // absolute path → { mtimeMs, doc }

/** Parsed spec, re-read only when the file changed: the overlay validates every matched response. */
function loadDoc(file) {
  const abs = safeSpecPath(file);
  const { mtimeMs } = statSync(abs);
  const cached = docCache.get(abs);
  if (cached?.mtimeMs === mtimeMs) return cached.doc;
  const doc = parseSpecText(readFileSync(abs, 'utf8'));
  docCache.set(abs, { mtimeMs, doc });
  return doc;
}

const operationKey = (method, path) => `${method.toUpperCase()} ${path}`;

function findOperation(doc, operationId) {
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (op && (op.operationId === operationId || operationKey(method, path) === operationId)) return { method, path, op };
    }
  }
  throw Object.assign(new Error(`Operation ${operationId} not found`), { status: 404 });
}

/** Path prefixes the API is served under – the request path starts with one of them. */
function serverPaths(doc) {
  const urls = doc.basePath ? [doc.basePath] : (doc.servers ?? []).map((s) => s.url);
  return urls
    .filter((url) => typeof url === 'string' && !url.includes('{'))
    .map((url) => new URL(url, 'http://localhost').pathname.replace(/\/+$/, ''));
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `^(prefix)/customers/([^/]+)/?$` – any base prefix is allowed, the overlay prefers a known server path. */
function pathPattern(path) {
  const body = path
    .replace(/\/+$/, '')
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? '([^/]+)' : escapeRegex(part)))
    .join('');
  return `^(.*?)${body}/?$`;
}

/**
 * Every operation of every spec, for matching the app's requests in the browser. Specs a client is generated from
 * come first: when two versions define the same path, the generated one is what the app calls.
 */
export function operationIndex() {
  const { specs } = listSpecs();
  const usable = specs.filter((s) => !s.error);
  const ordered = [
    ...usable.filter((s) => s.generators.length),
    ...usable.filter((s) => !s.generators.length).sort((a, b) => compareVersions(b.version, a.version)),
  ];
  const operations = ordered.flatMap((spec) => {
    const doc = loadDoc(spec.file);
    const servers = serverPaths(doc);
    return operationsOf(doc).map((op) => ({
      spec: spec.file,
      title: spec.title,
      version: spec.version,
      active: spec.generators.length > 0,
      operationId: op.operationId ?? operationKey(op.method, op.path),
      method: op.method.toUpperCase(),
      path: op.path,
      pattern: pathPattern(op.path),
      // more literal segments = more specific: /customers/search beats /customers/{id}
      literals: op.path.split('/').filter((s) => s && !s.startsWith('{')).length,
      servers,
    }));
  });
  return { operations };
}

/** Follows local $refs; sibling keywords of a $ref (3.1, or `nullable` next to it) win over the target's. */
function deref(doc, schema) {
  let current = schema;
  for (let hops = 0; current?.$ref && hops < MAX_REF_HOPS; hops++) {
    const { $ref, ...siblings } = current;
    const target = resolveRef(doc, $ref);
    if (!target) return Object.keys(siblings).length ? siblings : null;
    current = { ...target, ...siblings };
  }
  return current;
}

const typesOf = (schema) => (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []);

function allowsNull(doc, schema) {
  if (!schema || schema === true) return true;
  if (schema.nullable === true || schema['x-nullable'] === true) return true;
  if (typesOf(schema).includes('null') || schema.enum?.includes(null)) return true;
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (alternatives) return alternatives.some((part) => allowsNull(doc, deref(doc, part)));
  if (schema.allOf) return schema.allOf.every((part) => allowsNull(doc, deref(doc, part)));
  return !schema.type && !schema.properties && !schema.items && !schema.enum;
}

/** allOf flattened into one schema: merged properties/required, the first value of every other keyword. */
function flattenAllOf(doc, schema, depth = 0) {
  if (!schema?.allOf || depth > MAX_REF_HOPS) return schema;
  const { allOf, ...own } = schema;
  const merged = { ...own, properties: { ...own.properties }, required: [...(own.required ?? [])], alternatives: [] };
  for (const raw of allOf) {
    const part = flattenAllOf(doc, deref(doc, raw), depth + 1);
    if (!part) continue;
    Object.assign(merged.properties, part.properties);
    merged.required.push(...(part.required ?? []));
    merged.alternatives.push(...(part.alternatives ?? []));
    if (part.oneOf || part.anyOf) merged.alternatives.push(part.oneOf ?? part.anyOf);
    for (const key of ['type', 'enum', 'format', 'items', 'additionalProperties', 'nullable']) {
      if (merged[key] === undefined && part[key] !== undefined) merged[key] = part[key];
    }
  }
  return merged;
}

const jsonType = (value) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;

function typeMatches(type, value) {
  const actual = jsonType(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return type === actual;
}

const FORMATS = {
  'date-time': (v) => /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/.test(v) && !Number.isNaN(Date.parse(v)),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
};

const childPath = (path, key) =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? (path ? `${path}.${key}` : key) : `${path}[${JSON.stringify(key)}]`;
const short = (value) => {
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
};

/** Collects issues; the same problem in every item of a list is reported once, with a count. */
function issueSink() {
  const byKey = new Map();
  return {
    byKey,
    get full() {
      return byKey.size >= MAX_ISSUES;
    },
    errors: () => [...byKey.values()].filter((i) => i.level === 'error').reduce((n, i) => n + i.count, 0),
    add(path, message, level = 'error') {
      const key = `${path.replace(/\[\d+\]/g, '[]')}\0${message}`;
      const existing = byKey.get(key);
      if (existing) existing.count++;
      else if (!this.full) byKey.set(key, { path, message, level, count: 1 });
    },
    merge(other) {
      for (const issue of other.byKey.values()) for (let i = 0; i < issue.count; i++) this.add(issue.path, issue.message, issue.level);
    },
  };
}

function validateValue(doc, raw, value, path, sink, strictUnknown = true) {
  if (sink.full || raw === undefined || raw === true) return;
  if (raw === false) return sink.add(path, 'not allowed by the spec');
  const schema = flattenAllOf(doc, deref(doc, raw));
  if (!schema) return;

  if (value === null) {
    if (!allowsNull(doc, schema)) sink.add(path, 'null, not nullable');
    return;
  }

  // oneOf/anyOf: lenient – the value passes if one branch fits; otherwise the closest branch's issues are reported
  for (const branches of [...(schema.alternatives ?? []), schema.oneOf ?? schema.anyOf].filter(Boolean)) {
    let best = null;
    for (const branch of branches) {
      const trial = issueSink();
      validateValue(doc, branch, value, path, trial, false);
      if (!best || trial.errors() < best.errors()) best = trial;
      if (!trial.errors()) break;
    }
    if (best?.errors()) sink.merge(best);
  }

  const types = typesOf(schema).filter((t) => t !== 'null');
  if (!types.length && schema.properties) types.push('object');
  if (!types.length && schema.items) types.push('array');
  if (types.length && !types.some((t) => typeMatches(t, value))) {
    return sink.add(path, `expected ${types.join(' or ')}, got ${jsonType(value) === 'integer' ? 'number' : jsonType(value)}`);
  }

  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    sink.add(path, `not one of ${schema.enum.filter((o) => o !== null).join('|')} (${short(value)})`);
  }
  if (typeof value === 'string' && FORMATS[schema.format] && !FORMATS[schema.format](value)) {
    sink.add(path, `expected ${schema.format}, got ${short(value)}`);
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateValue(doc, schema.items, item, `${path}[${i}]`, sink, strictUnknown));
  }

  if (jsonType(value) === 'object') {
    const properties = schema.properties ?? {};
    for (const name of new Set(schema.required ?? [])) {
      if (value[name] === undefined) sink.add(childPath(path, name), 'required, missing');
    }
    for (const [name, child] of Object.entries(value)) {
      if (properties[name]) validateValue(doc, properties[name], child, childPath(path, name), sink, strictUnknown);
      else if (schema.additionalProperties === false) sink.add(childPath(path, name), 'not in spec');
      else if (schema.additionalProperties && schema.additionalProperties !== true) {
        validateValue(doc, schema.additionalProperties, child, childPath(path, name), sink, strictUnknown);
      } else if (strictUnknown && schema.properties) sink.add(childPath(path, name), 'not in spec', 'info');
    }
  }
}

function responseFor(doc, op, status) {
  const responses = op.responses ?? {};
  const code = String(status);
  const key = [code, `${code[0]}XX`, `${code[0]}xx`, 'default'].find((k) => responses[k]);
  return key ? { status: key, response: deref(doc, responses[key]) } : null;
}

/** The JSON media type of a response (OpenAPI 3) or its schema (Swagger 2). */
function mediaOf(response) {
  if (!response) return null;
  if (!response.content) return response.schema ? { schema: response.schema, example: response.examples?.['application/json'] } : null;
  const type = Object.keys(response.content).find((t) => /json/i.test(t)) ?? Object.keys(response.content)[0];
  return type ? response.content[type] : null;
}

/**
 * Checks a response the app received against the spec – finds drift between backend, mock and spec.
 * Returns `[{ path, message, level: 'error' | 'info', count }]`; unknown fields are `info` unless the schema forbids
 * them (`additionalProperties: false`).
 */
export function validateResponse({ file, operationId, status, body }) {
  const doc = loadDoc(file);
  const { op } = findOperation(doc, operationId);
  const match = responseFor(doc, op, status);
  if (!match) return [{ path: '', message: `status ${status} is not documented`, level: 'error', count: 1 }];
  const media = mediaOf(match.response);
  if (!media?.schema) return [];
  if (body === undefined) return [{ path: '', message: 'empty body, the spec defines one', level: 'error', count: 1 }];
  const sink = issueSink();
  validateValue(doc, media.schema, body, '', sink);
  return [...sink.byKey.values()];
}

function exampleOf(doc, media) {
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  const first = Object.values(media.examples ?? {})[0];
  if (first !== undefined) return deref(doc, first)?.value;
  const schema = deref(doc, media.schema);
  return schema?.example;
}

const ERROR_TEXT = /^(message|title|detail|error|description)$/i;

/** A small value that fits the schema: required properties only (all, if none are required). */
function minimalValue(doc, raw, name = '', depth = 0) {
  const schema = flattenAllOf(doc, deref(doc, raw));
  if (!schema || depth > 4) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  const alternative = (schema.oneOf ?? schema.anyOf ?? schema.alternatives?.[0])?.[0];
  if (alternative && !schema.properties && !schema.type) return minimalValue(doc, alternative, name, depth + 1);
  const type = typesOf(schema).find((t) => t !== 'null') ?? (schema.properties ? 'object' : schema.items ? 'array' : null);
  if (type === 'object') {
    const properties = schema.properties ?? {};
    const names = schema.required?.length ? schema.required : Object.keys(properties);
    return Object.fromEntries(names.map((key) => [key, minimalValue(doc, properties[key], key, depth + 1)]));
  }
  if (type === 'array') return [];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'string') {
    if (schema.format === 'date-time') return new Date(0).toISOString();
    if (schema.format === 'date') return '1970-01-01';
    if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
    return ERROR_TEXT.test(name) ? 'Simulated error' : 'string';
  }
  return null;
}

const COUNT_FIELD = /^(total|count|size|length|totalCount|totalItems|totalElements|totalPages|numberOfElements)$/i;

/** The success response with its list(s) emptied: arrays → [], count-like integers → 0, the rest as in the example. */
function emptyBody(doc, media) {
  const schema = flattenAllOf(doc, deref(doc, media?.schema));
  if (!schema) return { empty: false };
  const types = typesOf(schema);
  if (types.includes('array') || (!types.length && schema.items)) return { empty: true, body: [] };
  const properties = schema.properties ?? {};
  const arrays = Object.keys(properties).filter((key) => {
    const prop = flattenAllOf(doc, deref(doc, properties[key]));
    return prop && (typesOf(prop).includes('array') || prop.items);
  });
  if (!arrays.length) return { empty: false };
  const example = exampleOf(doc, media);
  const body = { ...(jsonType(example) === 'object' ? example : minimalValue(doc, schema)) };
  for (const key of arrays) body[key] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const prop = deref(doc, raw);
    if (COUNT_FIELD.test(key) && typesOf(prop ?? {}).some((t) => t === 'integer' || t === 'number')) body[key] = 0;
  }
  return { empty: true, body };
}

const jsonHeaders = (body) => (body === undefined ? {} : { 'content-type': 'application/json' });

/**
 * A response the overlay answers a request with instead of the server, built from the spec.
 * `mode`: 'delay' | 'empty' | 'error-500' | 'error-4xx'. Returns `{ mode, status, body, headers, description }`;
 * `body` undefined means no body (e.g. 204), `delayMs` is set for 'delay'.
 */
export function simulatedResponse({ file, operationId, mode }) {
  if (mode === 'delay') return { mode, delayMs: SIMULATED_DELAY_MS };
  const doc = loadDoc(file);
  const { op } = findOperation(doc, operationId);
  const responses = Object.entries(op.responses ?? {});
  const response = (key) => deref(doc, op.responses[key]);

  if (mode === 'empty') {
    const success = responses.map(([key]) => key).find((key) => /^2/.test(key));
    const media = success ? mediaOf(response(success)) : null;
    const { empty, body } = emptyBody(doc, media);
    if (empty) return { mode, status: Number(success) || 200, body, headers: jsonHeaders(body), description: 'Empty list' };
    // No list to empty: "nothing there" is a 204 if the operation knows one, otherwise a null body.
    if (op.responses?.['204'] || !media) return { mode, status: 204, body: undefined, headers: {}, description: 'No content' };
    return { mode, status: Number(success) || 200, body: null, headers: jsonHeaders(null), description: 'Null body' };
  }

  if (mode === 'error-500' || mode === 'error-4xx') {
    const server = mode === 'error-500';
    const pattern = server ? /^5/ : /^4/;
    // explicit codes before 4XX/5XX ranges, then the default response
    const key =
      responses.map(([k]) => k).find((k) => pattern.test(k) && /^\d+$/.test(k)) ??
      responses.map(([k]) => k).find((k) => pattern.test(k)) ??
      (op.responses?.default ? 'default' : null);
    const status = key && /^\d+$/.test(key) ? Number(key) : server ? 500 : 400;
    const target = key ? response(key) : null;
    const media = mediaOf(target);
    let body = exampleOf(doc, media);
    if (body === undefined && media?.schema) body = minimalValue(doc, media.schema);
    if (body === undefined || body === null) body = { message: server ? 'Simulated server error' : 'Simulated client error' };
    const description = target?.description ?? (server ? 'Server error' : 'Client error');
    // documented: false – the spec defines no such response, the overlay invents a generic one
    return { mode, status, body, headers: jsonHeaders(body), description, documented: Boolean(key) };
  }

  throw new Error(`Unknown simulation mode ${mode}`);
}

// ---------------------------------------------------------------- impact of a new version

const FIELD_CONSTRAINTS = ['maxLength', 'minLength', 'pattern', 'format', 'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems'];
const MAX_FIELD_DEPTH = 3;

/**
 * Flattened fields of a schema: nested objects and array items as `a.b` (the paths a mapper reads), each with its
 * type, required/nullable and constraints. A $ref'd enum's values count as the field's own constraint.
 */
function fieldsOf(doc, schema) {
  const fields = new Map();
  const collect = (node, prefix, depth, seen) => {
    if (!node || depth > MAX_FIELD_DEPTH) return;
    if (node.$ref) {
      if (seen.has(node.$ref)) return;
      return collect(resolveRef(doc, node.$ref), prefix, depth, new Set([...seen, node.$ref]));
    }
    for (const part of node.allOf ?? []) collect(part, prefix, depth, seen);
    for (const [name, prop] of Object.entries(node.properties ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      const target = flattenAllOf(doc, deref(doc, prop)) ?? {};
      const constraints = {};
      for (const key of FIELD_CONSTRAINTS) if (target[key] !== undefined) constraints[key] = target[key];
      fields.set(path, {
        type: typeOf({ ...prop, nullable: undefined }),
        required: (node.required ?? []).includes(name),
        nullable: allowsNull(doc, target) && Boolean(target.type || target.enum || target.properties || target.items),
        constraints,
      });
      const items = target.type === 'array' ? flattenAllOf(doc, deref(doc, target.items)) : null;
      const child = items ?? target;
      if (child.type === 'object' || child.properties) collect(items ? target.items : prop, path, depth + 1, seen);
    }
  };
  collect(schema, '', 1, new Set());
  return fields;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const parentOf = (path) => path.split('.').slice(0, -1).join('.');

/**
 * Removed fields that reappear under another name with the same type next to them count as renamed – one candidate on
 * each side only, so the guess stays safe. Children of a renamed object follow their parent.
 */
function pairRenames(removed, added) {
  const renamed = [];
  const byDepth = (a, b) => a.path.split('.').length - b.path.split('.').length;
  for (const old of [...removed].sort(byDepth)) {
    if (!removed.includes(old)) continue;
    const moved = renamed.find((r) => old.path.startsWith(`${r.from}.`));
    let match = moved && added.find((a) => a.path === `${moved.to}${old.path.slice(moved.from.length)}`);
    if (!match) {
      // same parent and type; several of them only stay apart by identical constraints
      const sameType = (f) => parentOf(f.path) === parentOf(old.path) && f.type === old.type;
      const sameShape = (f) => sameType(f) && same(f.constraints, old.constraints);
      const pick = (test) => (added.filter(test).length === 1 && removed.filter(test).length === 1 ? added.find(test) : null);
      match = pick(sameType) ?? pick(sameShape);
      if (!match) continue;
    }
    renamed.push({ from: old.path, to: match.path, type: old.type });
    removed.splice(removed.indexOf(old), 1);
    added.splice(added.indexOf(match), 1);
  }
  return renamed;
}

function schemaFieldDiff(fromDoc, toDoc, name) {
  const [a, b] = [fieldsOf(fromDoc, schemasOf(fromDoc)[name]), fieldsOf(toDoc, schemasOf(toDoc)[name])];
  const removed = [...a].filter(([path]) => !b.has(path)).map(([path, f]) => ({ path, ...f }));
  const added = [...b].filter(([path]) => !a.has(path)).map(([path, f]) => ({ path, ...f }));
  const renamed = pairRenames(removed, added);
  for (const f of removed) delete f.constraints;
  const changed = [];
  for (const [path, before] of a) {
    const after = b.get(path);
    if (!after) continue;
    const change = { path };
    for (const key of ['type', 'required', 'nullable']) if (before[key] !== after[key]) change[key] = { from: before[key], to: after[key] };
    const constraints = {};
    for (const key of FIELD_CONSTRAINTS) {
      if (!same(before.constraints[key], after.constraints[key])) constraints[key] = { from: before.constraints[key] ?? null, to: after.constraints[key] ?? null };
    }
    if (Object.keys(constraints).length) change.constraints = constraints;
    if (Object.keys(change).length > 1) changed.push(change);
  }
  return { name, removed, added, renamed, changed };
}

function operationSignature(op) {
  return {
    http: operationKey(op.method, op.path),
    request: op.requestBody,
    response: op.responses.find((r) => r.status.startsWith('2'))?.type ?? null,
    parameters: op.parameters.filter((p) => p.in !== 'header' && p.in !== 'cookie'),
  };
}

/**
 * Field-level changes between two versions of one API, for mapping them onto the app's code: operations by
 * operationId (a new id on the same method and path is a rename), and for every schema in both versions its removed,
 * added, renamed and changed fields (type, required, nullable, constraints), nested fields as `a.b`.
 */
export function fieldDiff(fromDoc, toDoc) {
  const ops = (doc) => new Map(operationsOf(doc).map((op) => [op.operationId ?? operationKey(op.method, op.path), operationSignature(op)]));
  const [opsA, opsB] = [ops(fromDoc), ops(toDoc)];
  const byHttp = new Map([...opsB].map(([id, op]) => [op.http, id]));
  const operations = { removed: [], added: [], renamed: [], changed: [] };
  for (const [id, before] of opsA) {
    const after = opsB.get(id);
    if (!after) {
      const renamedTo = byHttp.get(before.http);
      if (renamedTo && !opsA.has(renamedTo)) operations.renamed.push({ from: id, to: renamedTo, http: before.http });
      else operations.removed.push({ operationId: id, http: before.http });
      continue;
    }
    const change = { operationId: id, http: after.http };
    for (const key of ['http', 'request', 'response']) if (before[key] !== after[key]) change[key] = { from: before[key], to: after[key] };
    const names = (op) => new Map(op.parameters.map((p) => [`${p.in} ${p.name}`, p]));
    const [pa, pb] = [names(before), names(after)];
    const addedParams = [...pb].filter(([key]) => !pa.has(key)).map(([, p]) => p);
    const removedParams = [...pa].filter(([key]) => !pb.has(key)).map(([, p]) => p);
    if (addedParams.length || removedParams.length) change.parameters = { added: addedParams, removed: removedParams };
    if (Object.keys(change).length > 2) operations.changed.push(change);
  }
  const renamedTargets = new Set(operations.renamed.map((r) => r.to));
  for (const [id, op] of opsB) if (!opsA.has(id) && !renamedTargets.has(id)) operations.added.push({ operationId: id, http: op.http });

  const [schemasA, schemasB] = [schemasOf(fromDoc), schemasOf(toDoc)];
  return {
    operations,
    schemas: {
      removed: Object.keys(schemasA).filter((n) => !schemasB[n]),
      added: Object.keys(schemasB).filter((n) => !schemasA[n]),
      changed: Object.keys(schemasA)
        .filter((n) => schemasB[n])
        .map((n) => schemaFieldDiff(fromDoc, toDoc, n))
        .filter((s) => s.removed.length || s.added.length || s.renamed.length || s.changed.length),
    },
  };
}

/**
 * What an adapter's impact() needs for two spec files of the API folder: both versions, the files of the same API
 * (same info.title, so the adapter only looks at code generated from it), the field-level diff and the structural one.
 */
export function impactInput({ from, to }) {
  if (!from || !to) throw new Error('Impact needs { from, to }: two spec files below the API folder');
  if (from === to) throw new Error('Pick two different versions');
  const [fromDoc, toDoc] = [loadDoc(from), loadDoc(to)];
  const info = (file, doc) => ({ file, title: doc.info?.title ?? file, version: String(doc.info?.version ?? '?') });
  const [a, b] = [info(from, fromDoc), info(to, toDoc)];
  const files = [...new Set([from, to, ...listSpecs().specs.filter((s) => !s.error && (s.title === a.title || s.title === b.title)).map((s) => s.file)])];
  return { from: a, to: b, files, changes: fieldDiff(fromDoc, toDoc), diff: diffSpecs(fromDoc, toDoc) };
}
