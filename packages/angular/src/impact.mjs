// Impact of another version of an API on the app (contract: core src/adapter.mjs, `impact()`): the core diffs the
// two specs field by field, this module maps the diff onto the code generated from that API – read and write mappers,
// store calls and form controls – with the workspace scan of `benda check`.
import { join } from 'node:path';
import { lineOf, parse, resolveModule, typescript } from './ast.mjs';
import { scanWorkspace } from './check.mjs';
import { analyseForms } from './forms.mjs';
import { generatorFor, refreshGenerators } from './lineage.mjs';

const LEVELS = ['breaking', 'changed', 'new'];
// spec constraint → the validator kind the form analysis reports for it
const VALIDATOR_OF = {
  maxLength: 'maxLength',
  minLength: 'minLength',
  maximum: 'max',
  minimum: 'min',
  pattern: 'pattern',
};

const show = (value) => (value === null || value === undefined ? 'none' : JSON.stringify(value));
const within = (path, prefix) => path === prefix || path.startsWith(`${prefix}.`);

/** Lookups into the core's field diff, per schema name. */
function diffIndex(changes) {
  const schemas = new Map(changes.schemas.changed.map((s) => [s.name, s]));
  const removedSchemas = new Set(changes.schemas.removed);
  const empty = { removed: [], added: [], renamed: [], changed: [] };
  const of = (schema) => schemas.get(schema) ?? empty;
  return {
    removedSchema: (schema) => removedSchemas.has(schema),
    /** What happened to `path` (or the object containing it): { removed } | { renamed } | { changed } | null */
    field(schema, path) {
      const s = of(schema);
      const renamed = s.renamed.find((r) => within(path, r.from));
      if (renamed) return { renamed: { ...renamed, path: `${renamed.to}${path.slice(renamed.from.length)}` } };
      const removed = s.removed.find((r) => within(path, r.path));
      if (removed) return { removed };
      const changed = s.changed.find((c) => c.path === path);
      if (changed) return { changed };
      return null;
    },
    /** Changes below `path` (a mapper reading a whole object: its parts changed). */
    inside: (schema, path) => of(schema).changed.filter((c) => c.path.startsWith(`${path}.`)),
    added: (schema) => of(schema).added,
    becameRequired: (schema) => of(schema).changed.filter((c) => c.required?.to === true),
  };
}

/** Readable list of one field change: type, required, nullable and constraints. */
function describeChange(change) {
  const parts = [];
  if (change.type) parts.push(`type ${change.type.from} → ${change.type.to}`);
  if (change.required) parts.push(change.required.to ? 'now required' : 'now optional');
  if (change.nullable) parts.push(change.nullable.to ? 'now nullable' : 'no longer nullable');
  for (const [key, { from, to }] of Object.entries(change.constraints ?? {})) {
    if (key === 'enum' && Array.isArray(from) && Array.isArray(to)) {
      const added = to.filter((v) => !from.includes(v));
      const removed = from.filter((v) => !to.includes(v));
      parts.push(`enum ${[...added.map((v) => `+${v}`), ...removed.map((v) => `−${v}`)].join(' ') || 'reordered'}`);
    } else parts.push(`${key} ${show(from)} → ${show(to)}`);
  }
  return parts.join(', ');
}

/** Stricter or looser constraints do not matter to a reader; a new type, a possible gap or new enum values do. */
const relevantToReader = (c, field) =>
  c.type || c.required?.to === false || c.nullable?.to || (c.constraints?.enum && field.lookup);

const covered = (used, path) => [...used].some((u) => within(path, u) || within(u, path));

/** Named imports from generated client output: [{ name, line }] – the types a renamed or removed schema breaks. */
function generatedImports(file) {
  const t = typescript();
  const sf = parse(file);
  const found = [];
  for (const statement of sf.statements) {
    if (!t.isImportDeclaration(statement) || !t.isNamedImports(statement.importClause?.namedBindings ?? {})) continue;
    if (!generatorFor(resolveModule(file, statement.moduleSpecifier.text))) continue;
    for (const element of statement.importClause.namedBindings.elements)
      found.push({ name: (element.propertyName ?? element.name).text, line: lineOf(sf, element) });
  }
  return found;
}

/** `impact({ from, to, files, changes })`, see the contract in core src/adapter.mjs. */
export function createImpact({ workspace, stateDir }) {
  return function impact({ from, to, files, changes }) {
    if (!changes) throw new Error('impact() needs the field diff of the two versions (changes)');
    refreshGenerators();
    const failures = [];
    const scan = scanWorkspace({
      workspace,
      stateDir,
      failed: (file, error) => failures.push({ file, error: error.message }),
    });
    const family = new Set(files ?? [from.file, to.file]);
    const index = diffIndex(changes);
    const toVersion = to.version;

    const items = [];
    const seen = new Set();
    const add = (item) => {
      const key = `${item.kind}|${item.file}|${item.line}|${item.symbol}|${item.field}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ schema: null, field: null, ...item });
    };

    // components first: their forms need the component analysis; the scan collects the stores on the way
    const forms = [];
    for (const { relFile, analysis, details } of scan.components()) {
      // a store over two APIs counts for each of them
      const own = details.filter((d) => d.lineage.specs.some((s) => family.has(s.file)));
      if (!own.length) continue;
      try {
        for (const form of analyseForms({ analysis, file: relFile, stores: own, selected: null }))
          if (form.submit) forms.push({ form, details: own });
      } catch (error) {
        failures.push({ file: relFile, error: error.message });
      }
    }
    scan.remainingStores();
    const stores = [...scan.lineages.values()].filter((l) => l.specs.some((s) => family.has(s.file)));

    const readMappers = new Map();
    const writeMappers = new Map();
    for (const store of stores) {
      for (const mapper of store.mappers) readMappers.set(`${mapper.file}|${mapper.name}`, mapper);
      for (const write of store.writes) {
        if (!write.mapper) continue;
        const entry = writeMappers.get(`${write.mapper.file}|${write.mapper.name}`) ?? {
          mapper: write.mapper,
          operations: [],
        };
        entry.operations.push(write.operation);
        writeMappers.set(`${write.mapper.file}|${write.mapper.name}`, entry);
      }
    }

    // store calls: the generated client's method is the operationId
    const renamedOps = new Map(changes.operations.renamed.map((r) => [r.from, r]));
    const removedOps = new Map(changes.operations.removed.map((r) => [r.operationId, r]));
    const changedOps = new Map(changes.operations.changed.map((c) => [c.operationId, c]));
    for (const store of stores) {
      for (const op of store.operations) {
        const symbol = `${store.name}.${op.method}`;
        const base = { kind: 'operation', file: store.file, line: op.line, symbol };
        if (removedOps.has(op.method)) {
          add({
            ...base,
            level: 'breaking',
            message: `${removedOps.get(op.method).http} no longer exists in ${toVersion}`,
            fix: `Remove the call from ${store.name}${op.storeMethod ? `.${op.storeMethod}` : ''} or move it to a replacing operation.`,
          });
        } else if (renamedOps.has(op.method)) {
          const r = renamedOps.get(op.method);
          add({
            ...base,
            level: 'breaking',
            message: `${r.http} is called ${r.to} in ${toVersion}, so the generated client method changes`,
            fix: `Call ${r.to} in ${store.name}${op.storeMethod ? `.${op.storeMethod}` : ''}.`,
          });
        } else if (changedOps.has(op.method)) {
          const c = changedOps.get(op.method);
          const required = (c.parameters?.added ?? []).filter((p) => p.required);
          const parts = [
            c.http && `path ${c.http.from} → ${c.http.to}`,
            c.request && `request ${c.request.from ?? 'none'} → ${c.request.to ?? 'none'}`,
            c.response && `response ${c.response.from ?? 'none'} → ${c.response.to ?? 'none'}`,
            ...(c.parameters?.added ?? []).map((p) => `+${p.required ? 'required ' : ''}${p.in} parameter ${p.name}`),
            ...(c.parameters?.removed ?? []).map((p) => `−${p.in} parameter ${p.name}`),
          ].filter(Boolean);
          add({
            ...base,
            level: required.length || c.request || c.response ? 'breaking' : 'changed',
            message: parts.join(', '),
            fix: required.length
              ? `Pass ${required.map((p) => p.name).join(', ')} in ${store.name}${op.storeMethod ? `.${op.storeMethod}` : ''}.`
              : `Check the call in ${store.name}${op.storeMethod ? `.${op.storeMethod}` : ''} and the mapper of its ${op.role === 'read' ? 'response' : 'request'}.`,
          });
        }
      }
    }

    // read mappers: every DTO path a model field reads
    for (const mapper of readMappers.values()) {
      const schema = mapper.dtoType;
      if (!schema) continue;
      if (index.removedSchema(schema)) {
        add({
          level: 'breaking',
          kind: 'mapper-field',
          file: mapper.file,
          line: mapper.line,
          symbol: mapper.name,
          schema,
          message: `maps ${schema}, which ${toVersion} no longer defines`,
          fix: `Map ${mapper.name} from the schema that replaces ${schema}.`,
        });
        continue;
      }
      for (const f of mapper.fields) {
        const at = {
          file: f.file ?? mapper.file,
          line: f.line,
          symbol: `${f.nested ?? mapper.name}.${f.model}`,
          schema,
        };
        for (const source of f.source) {
          const hit = index.field(schema, source);
          if (hit?.removed) {
            add({
              ...at,
              level: 'breaking',
              kind: 'mapper-field',
              field: source,
              message: `reads ${schema}.${source}, which ${toVersion} removes`,
              fix: `Drop ${f.model} from the model or fill it from another field.`,
            });
          } else if (hit?.renamed) {
            add({
              ...at,
              level: 'breaking',
              kind: 'mapper-field',
              field: source,
              message: `reads ${schema}.${source}, renamed to ${hit.renamed.path} in ${toVersion} (same type)`,
              fix: `Read ${hit.renamed.path} in ${mapper.name}.`,
            });
          } else if (hit?.changed && relevantToReader(hit.changed, f)) {
            const c = hit.changed;
            const lookup = c.constraints?.enum && f.lookup;
            add({
              ...at,
              level: 'changed',
              kind: 'mapper-field',
              field: source,
              message: `reads ${schema}.${source}: ${describeChange(c)}`,
              fix: lookup
                ? `Update the lookup table in ${mapper.name} for the changed enum values.`
                : c.type
                  ? `Check the conversion of ${f.model}${f.conversion ? ` (${f.conversion})` : ''}.`
                  : `Handle a missing or null ${source} in ${f.model}.`,
            });
          }
          for (const c of index.inside(schema, source)) {
            add({
              ...at,
              level: 'changed',
              kind: 'mapper-field',
              field: c.path,
              message: `takes ${schema}.${source} as a whole; ${c.path}: ${describeChange(c)}`,
              fix: `Check that ${f.model} still fits ${schema}.${source}.`,
            });
          }
        }
      }
      // new fields the mapper does not read yet: an added object is offered once, not once per field inside it
      const used = new Set(mapper.fields.flatMap((f) => f.source));
      const added = index.added(schema);
      const addedPaths = new Set(added.map((a) => a.path));
      for (const a of added) {
        if (covered(used, a.path) || [...addedPaths].some((p) => a.path.startsWith(`${p}.`))) continue;
        add({
          level: 'new',
          kind: 'new-field',
          file: mapper.file,
          line: mapper.line,
          symbol: mapper.name,
          schema,
          field: a.path,
          message: `${schema}.${a.path} (${a.type}${a.nullable ? ' | null' : ''}) is new in ${toVersion} and not mapped`,
          fix: `+ Map: add ${a.path} to the model and map it in ${mapper.name}.`,
        });
      }
    }

    // write mappers: every request field they set, and request fields they would have to set
    for (const { mapper, operations } of writeMappers.values()) {
      const schema = mapper.dtoType;
      if (!schema) continue;
      const used = operations.join('/');
      if (index.removedSchema(schema)) {
        add({
          level: 'breaking',
          kind: 'write-field',
          file: mapper.file,
          line: mapper.line,
          symbol: mapper.name,
          schema,
          message: `builds ${schema}, which ${toVersion} no longer defines (${used})`,
          fix: `Build the request body ${toVersion} expects in ${mapper.name}.`,
        });
        continue;
      }
      for (const f of mapper.fields) {
        const at = {
          kind: 'write-field',
          file: f.file ?? mapper.file,
          line: f.line,
          symbol: `${mapper.name}.${f.dto}`,
          schema,
          field: f.dto,
        };
        const hit = index.field(schema, f.dto);
        if (hit?.removed) {
          add({
            ...at,
            level: 'breaking',
            message: `sets ${schema}.${f.dto}, which ${toVersion} removes (${used})`,
            fix: `Stop setting ${f.dto} in ${mapper.name}.`,
          });
        } else if (hit?.renamed) {
          add({
            ...at,
            level: 'breaking',
            message: `sets ${schema}.${f.dto}, renamed to ${hit.renamed.path} in ${toVersion} (same type)`,
            fix: `Set ${hit.renamed.path} in ${mapper.name}.`,
          });
        } else if (hit?.changed?.type || hit?.changed?.constraints?.enum) {
          add({
            ...at,
            level: 'changed',
            message: `sets ${schema}.${f.dto}: ${describeChange(hit.changed)}`,
            fix: `Check the value ${mapper.name} writes to ${f.dto}${f.conversion ? ` (${f.conversion})` : ''}.`,
          });
        }
      }
      const set = new Set(mapper.fields.map((f) => f.dto));
      const required = [
        ...index
          .added(schema)
          .filter((a) => a.required)
          .map((a) => ({ path: a.path, type: a.type, why: 'new and required' })),
        ...index.becameRequired(schema).map((c) => ({ path: c.path, why: 'required now' })),
      ];
      for (const r of required) {
        if (covered(set, r.path)) continue;
        add({
          level: 'breaking',
          kind: 'write-field',
          file: mapper.file,
          line: mapper.line,
          symbol: mapper.name,
          schema,
          field: r.path,
          message: `${schema}.${r.path} is ${r.why} in ${toVersion}; ${mapper.name} does not set it – ${used} requests become invalid`,
          fix: `Set ${r.path} in ${mapper.name} (and add a form control for it).`,
        });
      }
      const addedPaths = new Set(index.added(schema).map((a) => a.path));
      for (const a of index.added(schema)) {
        if (a.required || covered(set, a.path) || [...addedPaths].some((p) => a.path.startsWith(`${p}.`))) continue;
        add({
          level: 'new',
          kind: 'new-field',
          file: mapper.file,
          line: mapper.line,
          symbol: mapper.name,
          schema,
          field: a.path,
          message: `${schema}.${a.path} (optional, ${a.type}) is new in ${toVersion} and not written by ${mapper.name}`,
          fix: `+ Map on write: set ${a.path} in ${mapper.name} if the UI should edit it.`,
        });
      }
    }

    // form controls: the request field each control ends up in
    for (const { form, details } of forms) {
      const detail = details.find((d) => d.lineage.name === form.submit.store);
      const write = detail?.lineage.writes.find(
        (w) => w.storeMethod === form.submit.method && w.operation === form.submit.operation,
      );
      const schema = write?.mapper?.dtoType ?? form.submit.requestType;
      if (!schema || !/^\w+$/.test(schema)) continue;
      for (const control of form.controls) {
        if (!control.name || !control.apiField) continue;
        const at = {
          kind: 'form-control',
          file: form.file,
          line: control.line ?? form.line,
          symbol: `${form.name}.${control.name}`,
          schema,
          field: control.apiField,
        };
        const hit = index.field(schema, control.apiField);
        if (hit?.removed) {
          add({
            ...at,
            level: 'breaking',
            message: `is sent as ${schema}.${control.apiField}, which ${toVersion} removes`,
            fix: 'Remove the control or send its value elsewhere.',
          });
        } else if (hit?.renamed) {
          add({
            ...at,
            level: 'breaking',
            message: `is sent as ${schema}.${control.apiField}, renamed to ${hit.renamed.path} in ${toVersion}`,
            fix: `Write ${hit.renamed.path} in ${form.submit.mapper?.name ?? 'the write mapper'}.`,
          });
        } else if (hit?.changed) {
          const c = hit.changed;
          const has = (kind) => control.validators.some((v) => v.kind === kind && !v.native);
          const validators = Object.entries(c.constraints ?? {})
            .filter(
              ([key]) =>
                VALIDATOR_OF[key] ||
                (key === 'format' && (c.constraints.format.to === 'email' || has('email'))) ||
                key === 'enum',
            )
            .map(([key, { to: value }]) =>
              key === 'enum'
                ? `options ${show(value)}`
                : key === 'format'
                  ? `email ${value === 'email' ? 'validator' : 'validator removed'}`
                  : `${VALIDATOR_OF[key]} ${show(value)}`,
            );
          if (c.required?.to === true && !has('required')) validators.unshift('required');
          if (c.required?.to === false && has('required')) validators.unshift('required only if the UI wants it');
          if (!validators.length && !c.type) continue;
          add({
            ...at,
            level: 'changed',
            message: `${schema}.${control.apiField}: ${describeChange(c)}`,
            fix: validators.length
              ? `Align the validators: ${validators.join(', ')}.`
              : "Check the control's value type.",
          });
        }
      }
    }

    // generated types the stores and mappers import: a schema the new version drops no longer compiles
    const removedSchemas = new Set(changes.schemas.removed);
    const sources = new Set([
      ...stores.map((s) => s.file),
      ...[...readMappers.values()].flatMap((m) => [m.file, ...m.fields.map((f) => f.file).filter(Boolean)]),
      ...[...writeMappers.values()].map((w) => w.mapper.file),
    ]);
    for (const file of removedSchemas.size ? sources : []) {
      try {
        for (const { name, line } of generatedImports(join(workspace, file))) {
          if (!removedSchemas.has(name)) continue;
          add({
            level: 'breaking',
            kind: 'schema-import',
            file,
            line,
            symbol: `import ${name}`,
            schema: name,
            message: `${toVersion} no longer defines ${name}`,
            fix: `Replace ${name} and everything typed with it.`,
          });
        }
      } catch (error) {
        failures.push({ file, error: error.message });
      }
    }

    items.sort(
      (a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.file.localeCompare(b.file) || a.line - b.line,
    );
    const count = (level) => items.filter((i) => i.level === level).length;
    return {
      items,
      summary: {
        breaking: count('breaking'),
        changed: count('changed'),
        new: count('new'),
        stores: stores.length,
        mappers: readMappers.size + writeMappers.size,
        forms: forms.length,
        // the versions the workspace's clients are generated from, so the overlay can say which code was checked
        generated: [...new Set(stores.flatMap((s) => s.specs.map((spec) => spec.file)).filter((file) => family.has(file)))],
        ...(failures.length && { failures }),
      },
    };
  };
}
