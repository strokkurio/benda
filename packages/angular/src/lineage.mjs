// Data lineage of a selected element: component → injected stores → generated API client calls → OpenAPI
// operations → read and write mappers → field-by-field mapping, plus template bindings and forms.
// Static analysis with the workspace's own TypeScript compiler API – no dependency of Benda.
// The shape is the contract with the overlay, documented in the core's src/adapter.mjs.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  declarationOf,
  enclosingMember,
  functionOf,
  importsOf,
  initAst,
  isFunctionLike,
  isPublic,
  lineOf,
  nameOf,
  parse,
  rel,
  typeReference,
  typescript,
  unwrap,
  walk,
} from './ast.mjs';
import { analyseForms } from './forms.mjs';
import { attr, resolveAt, scanTemplate, templateBindings } from './template.mjs';

// Set once by createLineage(): one adapter (and so one workspace) per bridge process.
let WORKSPACE, detectGenerators, parseSpecText, specDetail, findComponent;

/** `api` is the core's OpenAPI index, `findComponent` the adapter's source index lookup. */
export function createLineage({ workspace, api, findComponent: find }) {
  WORKSPACE = workspace;
  initAst(workspace);
  ({ detectGenerators, parseSpecText, specDetail } = api);
  findComponent = find;
  return lineage;
}

const RESOURCE_FUNCTIONS = new Set(['rxResource', 'resource', 'httpResource', 'toSignal']);
const SIGNAL_FUNCTIONS = new Set(['signal', 'computed', 'linkedSignal', 'toSignal', 'input', 'model']);
const RESOURCE_SIGNALS = new Set(['value', 'isLoading', 'error', 'status', 'hasValue']);

// ---------------------------------------------------------------- generated clients

// Generator configs are read once per lineage() call, not once per type lookup.
let outputs = null;

function generatedOutputs() {
  outputs ??= detectGenerators()
    .filter((g) => g.output && g.input)
    .map((g) => {
      const output = resolve(WORKSPACE, g.output);
      return { ...g, dir: output.endsWith('.ts') ? dirname(output) : output };
    });
  return outputs;
}

/** Re-reads the generator configs on next use: a long-running bridge sees a client switched to another version. */
function refreshGenerators() {
  outputs = null;
}

const generatorFor = (file) => file && generatedOutputs().find((g) => file.startsWith(g.dir + sep) || file === g.dir);

/** Where the type an annotation refers to is declared, and whether that is generated client output. */
function typeOrigin(sf, typeNode) {
  const ref = typeReference(typeNode);
  if (!ref) return null;
  const local = ref.typeName.getText(sf).split('.')[0];
  const imported = importsOf(sf).get(local);
  const file = imported ? imported.file : sf.fileName;
  return {
    name: imported?.imported ?? local,
    text: typeNode.getText(sf),
    file,
    generated: Boolean(generatorFor(file)),
  };
}

// ---------------------------------------------------------------- spec helpers

const specCache = new Map(); // file → { mtimeMs, doc }

function specDoc(specFile) {
  const file = resolve(WORKSPACE, specFile);
  const mtimeMs = statSync(file).mtimeMs;
  const hit = specCache.get(file);
  if (hit?.mtimeMs === mtimeMs) return hit.doc;
  const doc = parseSpecText(readFileSync(file, 'utf8'));
  specCache.set(file, { mtimeMs, doc });
  return doc;
}

function resolveRef(doc, ref) {
  return ref?.startsWith('#/')
    ? ref
        .slice(2)
        .split('/')
        .reduce((node, key) => node?.[key], doc)
    : null;
}

const CONSTRAINTS = [
  'maxLength',
  'minLength',
  'pattern',
  'format',
  'enum',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
];

function constraintsOf(doc, prop) {
  const constraints = {};
  const target = prop.$ref ? resolveRef(doc, prop.$ref) : null;
  for (const source of [target, ...(prop.allOf ?? []).map((p) => (p.$ref ? resolveRef(doc, p.$ref) : p)), prop]) {
    for (const key of CONSTRAINTS) if (source?.[key] !== undefined) constraints[key] = source[key];
  }
  return constraints;
}

/** Flattened schema fields incl. one level of nested objects, e.g. totalAmount.value, with their constraints. */
function dtoFields(specFile, schemaName) {
  const doc = specDoc(specFile);
  const schemas = doc.components?.schemas ?? doc.definitions ?? {};
  const fields = [];
  const collect = (schema, prefix, depth, seen) => {
    if (!schema || depth > 2) return;
    if (schema.$ref) {
      if (seen.has(schema.$ref)) return;
      return collect(resolveRef(doc, schema.$ref), prefix, depth, new Set([...seen, schema.$ref]));
    }
    for (const part of schema.allOf ?? []) collect(part, prefix, depth, seen);
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      const path = prefix ? `${prefix}.${name}` : name;
      const target = prop.$ref ? resolveRef(doc, prop.$ref) : prop;
      const isObject = target?.type === 'object' || target?.properties || target?.allOf;
      const type = prop.$ref
        ? prop.$ref.split('/').pop()
        : prop.type === 'array'
          ? `${prop.items?.$ref?.split('/').pop() ?? prop.items?.type ?? 'any'}[]`
          : `${prop.type ?? 'object'}${prop.format ? ` (${prop.format})` : ''}`;
      fields.push({
        path,
        type: target?.enum ? `${type}: ${target.enum.join(' | ')}` : `${type}${prop.nullable ? ' | null' : ''}`,
        required: (schema.required ?? []).includes(name),
        object: Boolean(isObject),
        constraints: constraintsOf(doc, prop),
      });
      if (isObject) collect(target, path, depth + 1, seen);
    }
  };
  collect(schemas[schemaName], '', 1, new Set());
  return fields;
}

const covers = (used, path) =>
  used.has(path) || [...used].some((u) => u.startsWith(`${path}.`) || path.startsWith(`${u}.`));

// ---------------------------------------------------------------- mapper analysis

/** `STATUS[dto.state]` → the table behind STATUS, incl. a reversed one built with Object.fromEntries(Object.entries(X)…). */
function lookupTable(sf, name, depth = 0) {
  const t = typescript();
  let table = null;
  walk(sf, (node) => {
    if (table || !t.isVariableDeclaration(node) || node.name.getText(sf) !== name || !node.initializer) return;
    const init = unwrap(node.initializer);
    if (t.isObjectLiteralExpression(init)) {
      table = init.properties
        .filter(t.isPropertyAssignment)
        .map((p) => `${p.name.getText(sf).replace(/['"]/g, '')} → ${p.initializer.getText(sf).replace(/['"]/g, '')}`);
      return;
    }
    const reversed = init
      .getText(sf)
      .match(
        /^Object\.fromEntries\(\s*Object\.entries\((\w+)\)\s*\.map\(\s*\(\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*\)\s*=>\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]/,
      );
    if (reversed && depth === 0 && reversed[2] === reversed[5] && reversed[3] === reversed[4]) {
      table = lookupTable(sf, reversed[1], 1)?.map((row) => row.split(' → ').reverse().join(' → ')) ?? null;
    }
  });
  return table;
}

/** Local names a parameter binds, with the path they stand for: `dto` → '', `{ a, b: { c } }` → a, b.c */
function rootsOf(nameNode, prefix = '', roots = new Map()) {
  const t = typescript();
  if (t.isIdentifier(nameNode)) roots.set(nameNode.text, prefix);
  else if (t.isObjectBindingPattern(nameNode)) {
    for (const element of nameNode.elements) {
      const key = nameOf(element.propertyName ?? element.name);
      rootsOf(element.name, prefix ? `${prefix}.${key}` : key, roots);
    }
  }
  return roots;
}

/** Path of an access chain rooted in a parameter: dto.totalAmount?.value → 'totalAmount.value'; else null. */
function pathOf(node, roots) {
  const t = typescript();
  node = unwrap(node);
  if (t.isIdentifier(node)) return roots.has(node.text) ? roots.get(node.text) : null;
  if (
    t.isPropertyAccessExpression(node) ||
    (t.isElementAccessExpression(node) && t.isStringLiteralLike(node.argumentExpression))
  ) {
    const base = pathOf(node.expression, roots);
    const name = t.isPropertyAccessExpression(node) ? node.name.text : node.argumentExpression.text;
    return base === null ? null : base ? `${base}.${name}` : name;
  }
  return null;
}

/** Parameter paths an expression reads; a method call on a field counts as reading the field. */
function sourcePaths(init, roots) {
  const t = typescript();
  const paths = new Set();
  walk(init, (node) => {
    const parent = node.parent;
    if (
      t.isIdentifier(node) &&
      ((t.isPropertyAccessExpression(parent) && parent.name === node) ||
        (t.isPropertyAssignment(parent) && parent.name === node))
    )
      return;
    let path = pathOf(node, roots);
    if (path === null) return;
    if (t.isPropertyAccessExpression(node) && t.isCallExpression(parent) && parent.expression === node)
      path = pathOf(node.expression, roots);
    if (path) paths.add(path);
    return false;
  });
  return [...paths];
}

/** Object literals a function returns: expression bodies, every `return`, a returned local variable, both ternary branches. */
function returnedObjects(fn) {
  const t = typescript();
  const objects = [];
  const locals = new Map();
  const add = (expr) => {
    expr = unwrap(expr);
    if (!expr) return;
    if (t.isObjectLiteralExpression(expr)) objects.push(expr);
    else if (t.isConditionalExpression(expr)) [expr.whenTrue, expr.whenFalse].forEach(add);
    else if (t.isIdentifier(expr) && locals.has(expr.text)) add(locals.get(expr.text));
  };
  if (!t.isBlock(fn.body)) {
    add(fn.body);
    return objects;
  }
  const returns = [];
  walk(fn.body, (node) => {
    if (node !== fn.body && isFunctionLike(node)) return false;
    if (t.isVariableDeclaration(node) && t.isIdentifier(node.name) && node.initializer)
      locals.set(node.name.text, node.initializer);
    if (t.isReturnStatement(node) && node.expression) returns.push(node.expression);
  });
  returns.forEach(add);
  return objects;
}

/** A function a name resolves to in `sf` (local, imported, re-exported), or null. */
function resolveFunction(sf, name) {
  const found = declarationOf(sf, name);
  const fn = found && functionOf(found.node);
  if (!fn || generatorFor(found.sf.fileName)) return null;
  return { sf: found.sf, fn, name: found.name, declaration: found.node };
}

/**
 * Mapper direction by type: a parameter typed with a generated DTO makes a read mapper, a generated return type a
 * write mapper. Unannotated functions fall back to the naming convention toX(dto) / toXInput(draft).
 */
function mapperRole({ sf, fn, name }) {
  const param = fn.parameters?.[0];
  if (!param) return null;
  const paramType = typeOrigin(sf, param.type);
  const returnType = typeOrigin(sf, fn.type);
  if (paramType?.generated) return { role: 'read', by: 'type', paramType, returnType };
  if (returnType?.generated) return { role: 'write', by: 'type', paramType, returnType };
  if (param.type || fn.type || !/^to[A-Z]/.test(name)) return null;
  return {
    role: /(Input|Request|Body|Payload|Command)$/.test(name) ? 'write' : 'read',
    by: 'name',
    paramType,
    returnType,
  };
}

/** `toAddress(dto.address)` or `dto.lines.map(toLine)` inside a field initialiser: the nested mapper and its prefix. */
function nestedMapper(sf, init, roots, self) {
  const t = typescript();
  let found = null;
  walk(init, (node) => {
    if (found || !t.isCallExpression(node)) return;
    let callee = null;
    let prefix = null;
    if (t.isIdentifier(node.expression) && node.arguments[0]) {
      callee = node.expression.text;
      prefix = pathOf(node.arguments[0], roots);
    } else if (
      t.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'map' &&
      node.arguments[0] &&
      t.isIdentifier(node.arguments[0])
    ) {
      callee = node.arguments[0].text;
      prefix = pathOf(node.expression.expression, roots);
    }
    if (!callee || callee === self || prefix === null) return;
    const resolved = resolveFunction(sf, callee);
    if (resolved && returnedObjects(resolved.fn).length) found = { resolved, prefix };
  });
  return found;
}

/** Field table of a mapper: [{ key, source: [param paths], conversion, lookup, line }]; nested mappers one level deep. */
function mapperFields({ sf, fn, name }, depth = 0) {
  const t = typescript();
  const param = fn.parameters[0];
  const roots = rootsOf(param.name);
  const paramName = t.isIdentifier(param.name) ? param.name.text : null;
  const fields = [];
  const byKey = new Map();
  for (const literal of returnedObjects(fn)) {
    for (const p of literal.properties) {
      if (!t.isPropertyAssignment(p) && !t.isShorthandPropertyAssignment(p)) continue;
      const key = nameOf(p.name);
      const init = t.isPropertyAssignment(p) ? p.initializer : p.name;
      const source = sourcePaths(init, roots);
      const expr = init.getText(sf);
      const plain = pathOf(init, roots) !== null && source.length === 1;
      const existing = byKey.get(key);
      if (existing) {
        // the same key in several returned literals: one row with all sources, described by a branch that reads one
        if (!existing.source.length && source.length)
          Object.assign(existing, {
            conversion: plain ? null : paramName ? expr.replaceAll(`${paramName}.`, '') : expr,
            line: lineOf(sf, p),
          });
        existing.source = [...new Set([...existing.source, ...source])];
        continue;
      }
      let lookup = null;
      walk(init, (node) => {
        if (!lookup && t.isElementAccessExpression(node) && t.isIdentifier(node.expression))
          lookup = lookupTable(sf, node.expression.text);
      });
      const field = {
        key,
        source,
        conversion: plain ? null : paramName ? expr.replaceAll(`${paramName}.`, '') : expr,
        lookup,
        line: lineOf(sf, p),
      };
      byKey.set(key, field);
      fields.push(field);

      const nested = depth === 0 ? nestedMapper(sf, init, roots, name) : null;
      if (!nested) continue;
      field.mapper = {
        name: nested.resolved.name,
        file: rel(nested.resolved.sf.fileName),
        line: lineOf(nested.resolved.sf, nested.resolved.declaration),
      };
      for (const child of mapperFields(nested.resolved, depth + 1)) {
        fields.push({
          ...child,
          key: `${key}.${child.key}`,
          source: child.source.map((s) => (nested.prefix ? `${nested.prefix}.${s}` : s)),
          file: field.mapper.file,
          nested: field.mapper.name,
        });
      }
    }
  }
  return fields;
}

/** Read mapper: { name, file, line, dtoType, dtoFile, modelType, detectedBy, fields: [{ model, source: [DTO paths], … }] } */
function readMapper(resolved, role) {
  const { sf, fn, name, declaration } = resolved;
  return {
    name,
    file: rel(sf.fileName),
    line: lineOf(sf, declaration),
    dtoType: role.paramType?.name ?? null,
    dtoFile: role.paramType?.file ?? null,
    modelType: fn.type?.getText(sf) ?? null,
    detectedBy: role.by,
    fields: mapperFields(resolved).map(({ key, ...f }) => ({ model: key, ...f })),
  };
}

/** Write mapper: { name, file, line, draftType, dtoType, dtoFile, detectedBy, fields: [{ dto, source: [draft paths], … }] } */
function writeMapper(resolved, role) {
  const { sf, name, declaration } = resolved;
  return {
    name,
    file: rel(sf.fileName),
    line: lineOf(sf, declaration),
    draftType: role.paramType?.text ?? null,
    dtoType: role.returnType?.name ?? null,
    dtoFile: role.returnType?.file ?? null,
    detectedBy: role.by,
    fields: mapperFields(resolved).map(({ key, ...f }) => ({ dto: key, ...f })),
  };
}

// ---------------------------------------------------------------- store analysis

/** Class properties assigned from `inject(X)` or constructor parameter properties: [{ property, name, file, local }] */
function injections(sf) {
  const t = typescript();
  const imports = importsOf(sf);
  const found = [];
  const add = (property, local) => {
    const imported = imports.get(local);
    if (imported?.file) found.push({ property, name: imported.imported, file: imported.file });
  };
  walk(sf, (node) => {
    if (t.isCallExpression(node) && node.expression.getText(sf) === 'inject' && node.arguments[0]) {
      const target = node.arguments[0].getText(sf);
      const holder = node.parent;
      add(t.isPropertyDeclaration(holder) && holder.initializer === node ? nameOf(holder.name) : null, target);
    }
    if (
      t.isParameter(node) &&
      t.isConstructorDeclaration(node.parent) &&
      node.type &&
      t.isTypeReferenceNode(node.type) &&
      node.modifiers?.length
    ) {
      add(nameOf(node.name), node.type.typeName.getText(sf));
    }
  });
  return found;
}

const storeCache = new Map(); // file → { mtimeMs, store }

function analyseStore(file) {
  const mtimeMs = statSync(file).mtimeMs;
  const hit = storeCache.get(file);
  // the input counts too: a client switched to another spec version keeps its output folder
  const generators = generatedOutputs()
    .map((g) => `${g.input}>${g.dir}`)
    .join('|');
  if (hit?.mtimeMs === mtimeMs && hit.outputs === generators) return hit.store;
  const store = analyseStoreFile(file);
  storeCache.set(file, { mtimeMs, outputs: generators, store });
  return store;
}

function analyseStoreFile(file) {
  const t = typescript();
  const sf = parse(file);
  const imports = importsOf(sf);
  const api = new Map(); // property name → { service, file, generator }
  for (const injected of injections(sf)) {
    const generator = generatorFor(injected.file);
    if (generator && injected.property)
      api.set(injected.property, { service: injected.name, file: rel(injected.file), generator });
  }
  if (!api.size) return null;

  // mappers by type: every local or workspace function the store references
  const mappers = new Map(); // local name → { role, read|write mapper }
  const candidates = new Set();
  walk(sf, (node) => {
    if (!t.isIdentifier(node) || candidates.has(node.text)) return;
    const parent = node.parent;
    if ((t.isPropertyAccessExpression(parent) && parent.name === node) || t.isImportSpecifier(parent)) return;
    const imported = imports.get(node.text);
    if (
      imported
        ? imported.file && !generatorFor(imported.file)
        : t.isCallExpression(parent) || t.isCallExpression(parent?.parent)
    )
      candidates.add(node.text);
  });
  for (const local of candidates) {
    const resolved = resolveFunction(sf, local);
    const role = resolved && mapperRole(resolved);
    if (!role || !returnedObjects(resolved.fn).length) continue;
    mappers.set(local, {
      role: role.role,
      mapper: role.role === 'read' ? readMapper(resolved, role) : writeMapper(resolved, role),
    });
  }
  const mapperIn = (node, role) => {
    let found = null;
    const locals = new Map();
    for (let p = node.parent; p && !locals.size; p = p.parent) {
      if (!isFunctionLike(p)) continue;
      walk(p, (n) => {
        if (t.isVariableDeclaration(n) && t.isIdentifier(n.name) && n.initializer)
          locals.set(n.name.text, n.initializer);
      });
    }
    const followed = new Set();
    const visit = (n) => {
      if (found) return false;
      // `this.filter` in `const filter = this.filter()` is a property, not the local – following it never ends
      if (!t.isIdentifier(n) || (t.isPropertyAccessExpression(n.parent) && n.parent.name === n)) return;
      if (mappers.get(n.text)?.role === role) found = mappers.get(n.text).mapper;
      else if (locals.has(n.text) && !followed.has(n.text)) {
        followed.add(n.text);
        walk(locals.get(n.text), visit);
      }
    };
    for (const arg of node.arguments) walk(arg, visit);
    return found;
  };

  const calls = [];
  walk(sf, (node) => {
    if (!t.isCallExpression(node) || !t.isPropertyAccessExpression(node.expression)) return;
    const target = node.expression.expression;
    if (
      !t.isPropertyAccessExpression(target) ||
      target.expression.kind !== t.SyntaxKind.ThisKeyword ||
      !api.has(target.name.text)
    )
      return;
    let read = false;
    for (let p = node.parent; p; p = p.parent) {
      if (t.isCallExpression(p) && RESOURCE_FUNCTIONS.has(p.expression.getText(sf))) read = true;
    }
    const role = read ? 'read' : 'write';
    calls.push({
      method: node.expression.name.text,
      client: api.get(target.name.text),
      role,
      line: lineOf(sf, node),
      storeMethod: enclosingMember(node),
      writeMapper: role === 'write' ? mapperIn(node, 'write') : null,
    });
  });

  let cls = null;
  walk(sf, (node) => {
    if (!cls && t.isClassDeclaration(node)) cls = node;
  });
  const signals = [];
  const resources = new Set();
  for (const member of cls?.members ?? []) {
    if (!t.isPropertyDeclaration(member) || !member.initializer) continue;
    const init = unwrap(member.initializer);
    const callee = t.isCallExpression(init) ? init.expression.getText(sf).split('.')[0] : null;
    if (callee && RESOURCE_FUNCTIONS.has(callee)) resources.add(nameOf(member.name));
    const isSignal =
      (callee && (SIGNAL_FUNCTIONS.has(callee) || RESOURCE_FUNCTIONS.has(callee))) ||
      (t.isPropertyAccessExpression(init) &&
        RESOURCE_SIGNALS.has(init.name.text) &&
        resources.has(init.expression.getText(sf).replace(/^this\./, '')));
    if (!isSignal || !isPublic(member)) continue;
    signals.push(nameOf(member.name));
  }
  return {
    name: cls?.name?.text ?? null,
    file: rel(file),
    calls,
    readMappers: [...mappers.values()].filter((m) => m.role === 'read').map((m) => m.mapper),
    signals,
  };
}

/** Everything the overlay shows for one store. */
function storeLineage(store) {
  // every call is looked up in the spec of its own client: a store may use two APIs
  const specs = new Map(); // spec file → specDetail
  const specOf = (call) => {
    const input = call.client.generator?.input;
    if (input && !specs.has(input)) specs.set(input, specDetail(input));
    return input ? specs.get(input) : null;
  };
  const findOp = (spec, method) =>
    spec?.operations.find((o) => o.operationId === method || o.operationId?.toLowerCase() === method.toLowerCase());
  const operations = store.calls.map((call) => {
    const callSpec = specOf(call);
    const op = findOp(callSpec, call.method);
    return {
      method: call.method,
      // outside a resource the HTTP method decides: `firstValueFrom(this.api.listCustomers())` still reads
      role: call.role === 'read' || (op && /^(get|head)$/i.test(op.method)) ? 'read' : 'write',
      line: call.line,
      http: op ? `${op.method.toUpperCase()} ${op.path}` : null,
      responseType: op?.responses.find((r) => r.status.startsWith('2'))?.type ?? null,
      requestType: op?.requestBody ?? null,
      storeMethod: call.storeMethod,
      spec: callSpec?.file ?? null,
    };
  });
  const writes = store.calls
    .map((call, i) => ({ call, op: operations[i] }))
    .filter(({ op }) => op.role === 'write')
    .map(({ call, op }) => ({
      operation: call.method,
      storeMethod: call.storeMethod,
      line: call.line,
      http: op.http,
      requestType: op.requestType,
      mapper: call.writeMapper,
      spec: op.spec,
    }));
  // the store's spec is the one it reads from (its read mapper's DTO lives there), else its first one
  const spec = specs.get(operations.find((op) => op.role === 'read')?.spec) ?? [...specs.values()][0] ?? null;

  // typed read mappers first: the name fallback only fills in when no mapper carries type information
  const readMappers = [...store.readMappers].sort(
    (a, b) => (a.detectedBy === 'type' ? 0 : 1) - (b.detectedBy === 'type' ? 0 : 1),
  );
  const mapper = readMappers[0] ?? null;
  const info = (s) => ({ file: s.file, title: s.title, version: s.version });
  const specInfo = spec && info(spec);
  let fields = [];
  if (mapper?.dtoType && specInfo) {
    const used = new Set(mapper.fields.flatMap((f) => f.source));
    fields = dtoFields(specInfo.file, mapper.dtoType).map((f) => ({ ...f, mapped: covers(used, f.path) }));
  }

  // input schemas: the request bodies of the write operations (in their own spec), mapped = set by a write mapper
  const inputFields = [];
  const schemas = new Map(); // "spec file\0schema" → { file, schema, used }
  for (const write of writes) {
    const schema =
      write.mapper?.dtoType ?? (write.requestType && /^\w+$/.test(write.requestType) ? write.requestType : null);
    if (!schema || !write.spec) continue;
    const key = `${write.spec}\0${schema}`;
    if (!schemas.has(key)) schemas.set(key, { file: write.spec, schema, used: new Set() });
    for (const f of write.mapper?.fields ?? []) schemas.get(key).used.add(f.dto);
  }
  for (const { file, schema, used } of schemas.values()) {
    for (const f of dtoFields(file, schema)) inputFields.push({ ...f, schema, mapped: covers(used, f.path) });
  }
  return {
    name: store.name,
    file: store.file,
    operations,
    mapper,
    mappers: readMappers,
    writes,
    dtoFields: fields,
    inputFields,
    spec: specInfo,
    specs: [...specs.values()].map(info),
    signals: store.signals,
  };
}

// ---------------------------------------------------------------- component analysis

function inlineTemplate(sf, cls) {
  const t = typescript();
  for (const decorator of cls?.modifiers ?? []) {
    if (!t.isDecorator(decorator) || !t.isCallExpression(decorator.expression)) continue;
    const config = decorator.expression.arguments[0];
    if (!config || !t.isObjectLiteralExpression(config)) continue;
    for (const p of config.properties) {
      if (!t.isPropertyAssignment(p)) continue;
      const key = nameOf(p.name);
      const value = unwrap(p.initializer);
      if (key === 'template' && (t.isStringLiteralLike(value) || t.isTemplateExpression(value))) {
        const text = t.isTemplateExpression(value) ? value.getText(sf).slice(1, -1) : value.text;
        return { text, file: rel(sf.fileName), startLine: lineOf(sf, value) };
      }
      if (key === 'templateUrl' && t.isStringLiteralLike(value)) {
        const file = resolve(dirname(sf.fileName), value.text);
        try {
          return { text: readFileSync(file, 'utf8'), file: rel(file), startLine: 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function analyseComponent(file) {
  const t = typescript();
  const sf = parse(file);
  const injected = injections(sf);
  const columns = [];
  let cls = null;
  walk(sf, (node) => {
    if (
      !cls &&
      t.isClassDeclaration(node) &&
      node.modifiers?.some((m) => t.isDecorator(m) && m.expression.getText(sf).startsWith('Component'))
    )
      cls = node;
    // AG Grid style column definitions: { field: 'x', headerName: 'Label' }
    if (t.isObjectLiteralExpression(node)) {
      const props = Object.fromEntries(
        node.properties.filter(t.isPropertyAssignment).map((p) => [p.name.getText(sf), p.initializer]),
      );
      if (props.field && t.isStringLiteral(props.field)) {
        columns.push({
          field: props.field.text,
          label: props.headerName && t.isStringLiteral(props.headerName) ? props.headerName.text : props.field.text,
          line: lineOf(sf, node),
        });
      }
    }
  });
  const inputs = [];
  const properties = new Map();
  for (const member of cls?.members ?? []) {
    if (!t.isPropertyDeclaration(member)) continue;
    const name = nameOf(member.name);
    properties.set(name, member);
    const callee =
      member.initializer && t.isCallExpression(unwrap(member.initializer))
        ? unwrap(member.initializer).expression.getText(sf)
        : '';
    const decorated = member.modifiers?.some((m) => t.isDecorator(m) && /^Input\b/.test(m.expression.getText(sf)));
    if (decorated || /^(input|input\.required|model|model\.required)$/.test(callee)) inputs.push(name);
  }
  const renderer = cls?.members.some((m) => t.isMethodDeclaration(m) && nameOf(m.name) === 'agInit');
  const template = inlineTemplate(sf, cls);
  return {
    sf,
    cls,
    injected,
    columns,
    inputs,
    properties,
    receivesData: inputs.length > 0 || Boolean(renderer),
    template: template && scanTemplate(template.text, template.startLine, template.file),
  };
}

/** Store signal sources of a component's template: store properties and component signals derived from them. */
function templateSources(analysis, stores) {
  const sources = { stores: new Map(), derived: new Map() };
  for (const { property, store } of stores) {
    if (property) sources.stores.set(property, { store: store.name, signals: store.signals });
  }
  const sf = analysis.sf;
  for (const [name, member] of analysis.properties) {
    if (!member.initializer || sources.stores.has(name)) continue;
    // aliases and computed views of a store signal; `signal(this.store.x())` only copies the initial value
    const text = member.initializer.getText(sf);
    if (!/^(this\.\w+\.\w+$|(computed|linkedSignal|toSignal)\b)/.test(text)) continue;
    for (const [property, { store, signals }] of sources.stores) {
      const m = text.match(new RegExp(`this\\.${property}\\.(\\w+)\\b`));
      if (m && signals.includes(m[1])) {
        sources.derived.set(name, { store, storeSignal: m[1], path: '' });
        break;
      }
    }
  }
  return sources;
}

// ---------------------------------------------------------------- public API

/** Field from the DOM: the browser adapter's (AG Grid col-id around el), else a col-id / data-field attribute. */
function attributeField(item) {
  const attrs = item.element?.attributes ?? {};
  return item.field ?? attrs['col-id'] ?? attrs['data-field'] ?? attrs['field'] ?? null;
}

/** Field from the element's template line: `{{ x.name }}`, `{{ format(c.since) }}`, `{{ c.segment ?? '–' }}`. */
function interpolationField(item) {
  for (const hit of item.source?.templateHits ?? []) {
    const line = hit.text ?? '';
    const exact = line.match(/\{\{[^}]*?\.(\w+)\s*(?:\(\))?\s*\}\}/)?.[1];
    if (exact) return exact;
    for (const [, expr] of line.matchAll(/\{\{([^}]*)\}\}/g)) {
      const m = expr.match(/\b\w+(?:\(\))?\??\.(\w+)(?!\s*\()/);
      if (m) return m[1];
    }
  }
  return null;
}

/** Innermost component of the chain that exists in the workspace sources. */
function viewComponent(item) {
  // the chain has selectors only; the owner's project decides when several apps use the same selector
  const owner = findComponent(item.owner);
  for (const selector of [...(item.componentChain ?? [])].reverse()) {
    const component = findComponent({ selector, project: owner?.project });
    if (component) return component;
  }
  return owner ?? null;
}

/** Components outside the view component, innermost first. */
function outerComponents(item, view) {
  const chain = [...(item.componentChain ?? [])].reverse();
  const at = chain.findIndex((selector) => view.selectors.includes(selector));
  return chain
    .slice(at + 1)
    .map((selector) => findComponent({ selector, project: view.project }))
    .filter((c) => c && c.file !== view.file);
}

function componentStores(analysis) {
  const stores = [];
  const seen = new Set();
  for (const candidate of analysis.injected) {
    if (seen.has(candidate.file)) continue;
    seen.add(candidate.file);
    const store = analyseStore(candidate.file);
    if (store) stores.push({ property: candidate.property, store });
  }
  return stores;
}

const summary = (component) => ({ name: component.className, file: component.file, selector: component.selectors[0] });

/** Inputs of `view` bound in the data component's template to a store signal: `[customer]="c"` → { customer: … }. */
function inputSources(view, viewAnalysis, data, sources) {
  const derived = new Map();
  const scan = data.template;
  if (!scan) return derived;
  for (const element of scan.elements) {
    if (!view.selectors.includes(element.tag)) continue;
    for (const input of viewAnalysis.inputs) {
      const bound = attr(element, `[${input}]`);
      if (!bound?.bound || !bound.value) continue;
      const source = resolveAt(scan, sources, bound.value, element.start);
      if (source) derived.set(input, source);
    }
  }
  return derived;
}

function lineage(item) {
  outputs = null;
  const view = viewComponent(item);
  if (!view)
    return {
      component: null,
      field: attributeField(item) ?? interpolationField(item),
      store: null,
      stores: [],
      bindings: [],
      forms: [],
      control: null,
    };
  const viewAnalysis = analyseComponent(join(WORKSPACE, view.file));

  // data passed in from outside (inputs, AG Grid cell renderers): the store sits in a component further out
  let component = view;
  let analysis = viewAnalysis;
  let stores = componentStores(viewAnalysis);
  if (!stores.length && viewAnalysis.receivesData) {
    for (const outer of outerComponents(item, view)) {
      const outerAnalysis = analyseComponent(join(WORKSPACE, outer.file));
      const outerStores = componentStores(outerAnalysis);
      if (!outerStores.length) continue;
      [component, analysis, stores] = [outer, outerAnalysis, outerStores];
      break;
    }
  }
  const details = stores.map(({ property, store }) => ({ property, store, lineage: storeLineage(store) }));

  const sources = templateSources(analysis, stores);
  const bindings = analysis.template ? templateBindings(analysis.template, sources) : [];
  // AG Grid: the columns read the fields of the signal bound to [rowData]
  for (const element of analysis.template?.elements ?? []) {
    const rowData = attr(element, '[rowData]');
    const source = rowData?.value && resolveAt(analysis.template, sources, rowData.value, element.start);
    if (!source) continue;
    for (const column of analysis.columns) {
      bindings.push({
        store: source.store,
        storeSignal: source.storeSignal,
        field: [source.path, column.field].filter(Boolean).join('.'),
        line: column.line,
        file: component.file,
        column: column.label,
      });
    }
  }
  let viewBindings = [];
  if (component !== view && viewAnalysis.template) {
    const derived = inputSources(view, viewAnalysis, analysis, sources);
    if (derived.size) viewBindings = templateBindings(viewAnalysis.template, { stores: new Map(), derived });
  }
  const allBindings = [...bindings, ...viewBindings];

  // the selected element's field: DOM attribute, else a binding on its template line, else the interpolation
  const viewTemplateFile = viewAnalysis.template?.file;
  const lineBinding = (item.source?.templateHits ?? [])
    .map((hit) => allBindings.find((b) => b.line === hit.line && b.file === viewTemplateFile && b.field))
    .find(Boolean);
  // forms are an addition to the data lineage: an unexpected form setup must not cost the rest of the tab
  let forms = [];
  try {
    forms = analyseForms({
      analysis: viewAnalysis,
      file: view.file,
      stores: component === view ? details : [],
      selected: item,
    });
  } catch (error) {
    console.warn(`[benda] form analysis of ${view.file} failed: ${error.message}`);
  }
  const selectedForm = forms.find((f) => f.controls.some((c) => c.selected));
  const selectedControl = selectedForm?.controls.find((c) => c.selected);

  // AG Grid: the cell's col-id is the column's path in the row (`customer.name` when rows wrap the model)
  const attribute = attributeField(item);
  const binding =
    lineBinding ??
    (attribute && allBindings.find((b) => b.column && (b.field === attribute || b.field.endsWith(`.${attribute}`)))) ??
    null;
  // nested model fields (amount.value) where the read mapper has them, else the last segment as before
  const modelFields = new Set((details[0]?.lineage.mapper?.fields ?? []).map((f) => f.model));
  const bound = attribute ?? lineBinding?.field;
  const boundField = bound && (modelFields.has(bound) ? bound : bound.split('.').pop());
  const field = boundField ?? interpolationField(item) ?? selectedControl?.draftField ?? null;

  const first = details[0]?.lineage ?? null;
  return {
    component: summary(component),
    ...(component !== view && { view: { ...summary(view), inputs: viewAnalysis.inputs } }),
    field,
    binding: binding
      ? { store: binding.store, storeSignal: binding.storeSignal, field: binding.field, line: binding.line, file: binding.file }
      : null,
    shown: analysis.columns.map(({ field: f, label }) => ({ field: f, label })),
    store: first && { name: first.name, file: first.file },
    operations: first?.operations ?? [],
    mapper: first?.mapper ?? null,
    dtoFields: first?.dtoFields ?? [],
    spec: first?.spec ?? null,
    writes: first?.writes ?? [],
    inputFields: first?.inputFields ?? [],
    stores: details.map((d) => ({ ...d.lineage, property: d.property })),
    bindings: allBindings.map(({ file, ...b }) => ({ ...b, file })),
    forms,
    control: selectedControl ? { form: selectedForm.name, name: selectedControl.name } : null,
  };
}

// Building blocks for the workspace-wide data-layer check (check.mjs) and the spec impact (impact.mjs).
export { analyseComponent, componentStores, generatedOutputs, generatorFor, refreshGenerators, storeLineage, templateSources };
