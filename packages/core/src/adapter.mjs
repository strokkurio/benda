// Framework adapters. The core knows no framework; everything framework-specific comes from the adapter named in
// benda.config.json (`"adapter": "@strokkur/benda-angular"`), resolved from the project's own node_modules.
//
// A Node adapter is a module exporting `createAdapter(ctx)` under the subpath `<package>/adapter`:
//
//   ctx = {
//     workspace,   project root (absolute)
//     stateDir,    Benda's runtime state (.benda/), to keep out of source scans
//     readConfig,  () => benda.config.json merged with defaults, read on every call
//     api,         the core's OpenAPI index: { detectGenerators, parseSpecText, specDetail }
//   }
//
//   createAdapter(ctx) → {
//     name,                          e.g. "angular"
//     browserModule,                 absolute path of the browser adapter; the bridge serves it as /adapter.js
//     enrichItem(item) → item,       adds source locations (`source`, `hostSource`) to a selection item
//     devServers?(apps) → [{ label, args }],   dev servers for `benda dev`, run as `node ...args`
//     lineage?(item) → lineage,      optional capability: data lineage for the Data tab (shape below)
//     check?() → { findings, stats },   optional capability: static check of the whole workspace for `benda check`
//     impact?(input) → { items, summary },   optional capability: what another version of an API means for the code
//     inventory?() → { kinds, items, failed, places },   optional capability: the workspace's building blocks (Inventory)
//     itemDetail?(id) → { item, sections },     optional, with inventory: details of one item for the Inventory
//     insert?(input) → { file, line, files },   optional capability: writes a catalog component into the source
//   }
//
// Direct insertion from the overlay's Components tab (POST /components/insert), without an agent:
//
//   input = { item, position: 'before'|'after'|'inside', component: { name, snippet, import?: { name, from } } }
//           item is a selection item enriched by enrichItem (the element the component was dropped on); snippet and
//           import come from the catalog (.benda/components.json), never from the browser
//   result: the template file and line of the inserted snippet, and every file written (template, imports)
//   Throw an error with `status: 409` when the snippet binds to fields the host component would need, or the place is
//   ambiguous (the element matches several template elements, the imports live elsewhere): the overlay shows the
//   message and hands the drop to an agent. Write nothing then.
//
// Building blocks for the Inventory (GET /inventory). The adapter decides which kinds of building blocks there are; the
// page and the context block only render them:
//
//   kinds = [{ id, label, plural, icon, create? }]   e.g. { id: 'component', label: 'Component', plural: 'Components', icon: '◇' }
//     create = { fields: [{ id, label, type: 'text'|'select'|'item', placeholder?, options?, kind?, required? }],
//                dataAccess? }   kinds the page can create; `name` is the first field, project and folder are always
//                                asked; `item` picks an item of `kind`; dataAccess adds a spec, operations, components
//   items = [{
//     id,                            stable, e.g. 'component:projects/shell/src/app/home/home.ts#Home'
//     kind, name, file, line,        file workspace-relative, line 1-based or null
//     project, group,                the project (application, library) and the logical group within it (feature folder)
//     summary,                       one line, e.g. a selector or the operations of a store
//     relations: [{ type, target?, label? }],   target: another item's id; label: for targets that are no item
//   }]                                         (an API operation); types: uses, injects, routes-to, guarded-by, reads, writes
//   failed = [{ file, error }]       files that could not be analysed
//   places = [{ project, group, folder, prefix? }]   where new items go: each project's base folder (group '') and its
//                                    groups' folders; prefix e.g. a selector prefix
//   sections = [{ title, columns?, rows?, items?, text? }]   rows without columns are label/value pairs
//
//   findings = [{ level: 'error'|'warning'|'info', rule, file, line, message, fix? }]   file workspace-relative
//   stats    = { <what>: count }   what was checked, e.g. { components: 12, stores: 3 }; the CLI adds durationMs
//   `benda check` runs without the bridge and exits 1 when a finding reaches --level (default error).
//
// Impact of a new spec version (POST /specs/impact, the overlay's API tab). The core diffs the two specs, the
// adapter maps the diff onto the code generated from that API (and nothing else):
//
//   input = {
//     from, to: { file, title, version },   the two spec files, workspace-relative; `to` is the version to move to
//     files: [spec file],            every version of that API: only code generated from one of them is affected
//     changes: {                     field-level diff from → to
//       operations: { removed: [{ operationId, http }], added: [{ operationId, http }],
//                     renamed: [{ from, to, http }],   same method and path, new operationId
//                     changed: [{ operationId, http, request?, response?: { from, to }, parameters?: { added, removed } }] },
//       schemas: { removed: [name], added: [name], changed: [{ name,
//                  removed: [{ path, type, required, nullable }], added: [{ path, type, required, nullable, constraints }],
//                  renamed: [{ from, to, type }],   a removed field next to exactly one new one of the same type
//                  changed: [{ path, type?, required?, nullable?, constraints?: { <key>: { from, to } } }] }] },
//     },                             paths include nested objects and array items: 'totalAmount.value', 'items.id'
//   }
//   items   = [{ level: 'breaking'|'changed'|'new', kind, file, line, symbol, schema, field, message, fix? }]
//             kind: 'mapper-field' | 'write-field' | 'form-control' | 'operation' | 'new-field' | 'schema-import';
//             symbol names the code ('toCustomer.revenue', 'CustomerStore.listCustomers', 'form.city')
//   summary = { breaking, changed, new, stores, mappers, forms, generated: [spec files the clients use], failures? }
//
// The lineage is plain JSON; the overlay renders it without framework knowledge. Paths are workspace-relative
// (except the absolute dtoFile), lines 1-based. Nullable or empty where the adapter finds nothing:
//
//   lineage = {
//     component: { name, file, selector },   the component holding the data (with the store)
//     view?: { name, file, selector, inputs },   the selected element's own component, if the data comes from outside
//     field,                         model field the element shows ('name', 'amount.value')
//     binding: { store, storeSignal, field, line },   the store read on the element's template line
//     shown: [{ field, label }],     fields the component displays (e.g. grid columns)
//     store, operations, mapper, dtoFields, spec, writes, inputFields,   the first store's lineage (see stores[])
//     stores: [{
//       name, file, property, signals: [public signal names], spec: { file, title, version },
//       operations: [{ method, role: 'read'|'write', line, http, responseType, requestType, storeMethod }],
//       mapper: readMapper, mappers: [readMapper],
//       writes: [{ operation, storeMethod, line, http, requestType, mapper: writeMapper }],
//       dtoFields:   [{ path, type, required, object, constraints, mapped }],           read DTO, mapped = read
//       inputFields: [{ path, type, required, object, constraints, schema, mapped }],   request body, mapped = written
//     }],
//     bindings: [{ store, storeSignal, field, line, file, column? }],   template reads of store signals
//     forms: [{
//       name, kind: 'reactive'|'signal', file, line, templateFile, templateLine, model?,
//       submit: { store, method, operation, http, requestType, mapper: { name, file, line }, line } | null,
//       controls: [{
//         name, line, templateLine, validators: [{ kind, value, source: 'code'|'template', line, native?, when? }],
//         draftField, apiField, conversion, spec: { required, type, maxLength, minLength, pattern, format, enum,
//         minimum, maximum } | null, status: 'ok'|'missing'|'differs'|'extra'|'unmapped'|'missing-control',
//         issues: [text], selected,
//         fixes?: [{ kind, value, call }],   the validators the spec asks for, `call` in the form's own syntax
//                                            ('Validators.maxLength(120)'); tasks quote it, without it they name
//                                            the validator neutrally ('a maxLength 120 validator')
//       }],   'missing-control' rows (name null) are request fields no control writes
//     }],
//     control: { form, name } | null,   the selected element's form control
//   }
//   readMapper  = { name, file, line, dtoType, dtoFile, modelType, detectedBy: 'type'|'name',
//                   fields: [{ model, source: [DTO paths], conversion, lookup, line, mapper?, nested?, file? }] }
//   writeMapper = { name, file, line, draftType, dtoType, dtoFile, detectedBy,
//                   fields: [{ dto, source: [draft paths], conversion, lookup, line }] }
//   constraints = { maxLength, minLength, pattern, format, enum, minimum, maximum, … } as in the spec
//
// The browser adapter (default export of `browserModule`) is described in overlay/dom-adapter.js.
// Adapters receive the core's API through `ctx` instead of importing it, so they work from a `file:` link, where
// the adapter's real path has no node_modules that would resolve the core.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { detectGenerators, parseSpecText, specDetail } from './api-index.mjs';
import { CONFIG_NAME, OVERLAY_DIR, STATE_DIR, WORKSPACE, readConfig } from './lib.mjs';

/** No framework: plain DOM data, no source locations. Used when benda.config.json names no adapter. */
const DOM_ADAPTER = {
  name: 'dom',
  browserModule: join(OVERLAY_DIR, 'dom-adapter.js'),
  enrichItem: (item) => item,
};

let loaded;

export function loadAdapter() {
  loaded ??= load();
  return loaded;
}

async function load() {
  const name = readConfig().adapter;
  if (!name) return DOM_ADAPTER;
  let file;
  try {
    file = createRequire(join(WORKSPACE, 'package.json')).resolve(`${name}/adapter`);
  } catch {
    throw new Error(`Adapter "${name}" from ${CONFIG_NAME} is not installed in ${WORKSPACE}`);
  }
  const { createAdapter } = await import(pathToFileURL(file).href);
  return createAdapter({ workspace: WORKSPACE, stateDir: STATE_DIR, readConfig, api: { detectGenerators, parseSpecText, specDetail } });
}
