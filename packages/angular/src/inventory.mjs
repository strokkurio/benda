// Technical inventory of an Angular workspace for the Inventory (contract: core src/adapter.mjs, `inventory()`):
// applications and libraries from angular.json, routes, components, directives, pipes, stores, services, mappers,
// models, guards, resolvers, interceptors and generated API clients – each with its file, its logical group (the
// feature folder) and its relations. Static, with the workspace's own TypeScript compiler; results are cached per
// file until it changes.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { importsOf, lineOf, nameOf, parse, rel, resolveModule, typescript, unwrap, walk } from './ast.mjs';
import { analyseForms } from './forms.mjs';
import { analyseComponent, componentStores, generatedOutputs, generatorFor, storeLineage } from './lineage.mjs';
import { scanTemplate } from './template.mjs';

// `create`: what the Inventory asks for before an agent creates one (contract: core src/adapter.mjs). Name,
// project and folder are always asked; `dataAccess` adds the spec, its operations and the components to bind.
const NAME = (placeholder) => ({ id: 'name', label: 'Name', type: 'text', placeholder, required: true });
const KINDS = [
  { id: 'application', label: 'Application', plural: 'Applications', icon: '▣' },
  { id: 'library', label: 'Library', plural: 'Libraries', icon: '▤' },
  {
    id: 'route', label: 'Route', plural: 'Routes', icon: '↳',
    create: { fields: [{ id: 'name', label: 'Path', type: 'text', placeholder: 'e.g. orders/:id', required: true }, { id: 'component', label: 'Component', type: 'item', kind: 'component' }] },
  },
  {
    id: 'component', label: 'Component', plural: 'Components', icon: '◇',
    create: { fields: [NAME('e.g. OrderSummary'), { id: 'selector', label: 'Selector', type: 'text', placeholder: 'optional – from the project prefix' }, { id: 'route', label: 'Route path', type: 'text', placeholder: 'optional, e.g. orders/:id' }] },
  },
  { id: 'directive', label: 'Directive', plural: 'Directives', icon: '◈', create: { fields: [NAME('e.g. AutoFocus'), { id: 'selector', label: 'Selector', type: 'text', placeholder: 'optional, e.g. [appAutoFocus]' }] } },
  { id: 'pipe', label: 'Pipe', plural: 'Pipes', icon: '⏐', create: { fields: [NAME('e.g. Currency')] } },
  { id: 'store', label: 'Store', plural: 'Stores', icon: '◆', create: { dataAccess: true, fields: [NAME('the entity, e.g. Order')] } },
  { id: 'service', label: 'Service', plural: 'Services', icon: '●', create: { fields: [NAME('e.g. Clipboard')] } },
  { id: 'mapper', label: 'Mapper', plural: 'Mappers', icon: 'ƒ' },
  { id: 'model', label: 'Model', plural: 'Models', icon: '▭' },
  {
    id: 'guard', label: 'Guard', plural: 'Guards', icon: '⛨',
    create: { fields: [NAME('e.g. auth'), { id: 'type', label: 'Type', type: 'select', options: ['CanActivateFn', 'CanMatchFn', 'CanDeactivateFn', 'CanActivateChildFn'] }] },
  },
  { id: 'resolver', label: 'Resolver', plural: 'Resolvers', icon: '⇢', create: { fields: [NAME('e.g. order')] } },
  { id: 'interceptor', label: 'Interceptor', plural: 'Interceptors', icon: '⇄', create: { fields: [NAME('e.g. auth')] } },
  { id: 'api-client', label: 'API client', plural: 'API clients', icon: '⇅' },
];

const IGNORED = new Set(['node_modules', 'dist', '.angular', '.git', 'coverage', 'out-tsc', 'tmp']);
const FUNCTION_KINDS = {
  CanActivateFn: 'guard', CanActivateChildFn: 'guard', CanMatchFn: 'guard', CanDeactivateFn: 'guard',
  ResolveFn: 'resolver', HttpInterceptorFn: 'interceptor',
};
const RESOURCE_CALL = /\b(rxResource|resource|httpResource)\s*\(/;

const itemId = (kind, file, name) => `${kind}:${file}#${name}`;

export function createInventory({ workspace, stateDir }) {
  const ignored = new Set([...IGNORED, basename(stateDir)]);
  const fileCache = new Map(); // absolute file → { mtimeMs, entries }

  /** Projects from angular.json, longest root first, so a file belongs to the innermost one. */
  function projects() {
    let config = {};
    try {
      config = JSON.parse(readFileSync(join(workspace, 'angular.json'), 'utf8')).projects ?? {};
    } catch {
      /* not an Angular CLI workspace – projects come from the folder layout alone */
    }
    return Object.entries(config)
      .map(([name, p]) => ({ name, type: p.projectType ?? 'application', root: p.root ?? '', sourceRoot: p.sourceRoot ?? join(p.root ?? '', 'src'), prefix: p.prefix ?? null }))
      .sort((a, b) => b.root.length - a.root.length);
  }

  /** Project and logical group (feature folder below src/app, else the first folder below the root) of a file. */
  function placeOf(file, list) {
    // root "" is the project `ng new` creates; the list is sorted so that it comes last
    const project = list.find((p) => p.root === '' || file === p.root || file.startsWith(`${p.root}/`));
    if (!project) {
      const parts = file.split('/');
      const inContainer = ['projects', 'apps', 'libs'].includes(parts[0]);
      const atTop = !inContainer && parts[0] === 'src';
      const name = inContainer ? parts[1] : atTop ? basename(workspace) : parts[0];
      let rest = parts.slice(inContainer ? 2 : atTop ? 0 : 1, -1);
      // apps/shop/src/app/orders/… → group "orders", not "src"
      while (rest[0] === 'src' || rest[0] === 'app') rest = rest.slice(1);
      return { project: name, group: rest[0] ?? '' };
    }
    const app = `${project.sourceRoot}/app/`;
    const below = file.startsWith(app) ? file.slice(app.length) : file.slice(project.root ? project.root.length + 1 : 0);
    const folders = below.split('/').slice(0, -1);
    return { project: project.name, group: file.startsWith(app) ? (folders[0] ?? '') : (folders.filter((f) => f !== 'src' && f !== 'lib')[0] ?? '') };
  }

  function* sourceFiles(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // a generated client is one item, not its hundred model files
        if (!ignored.has(entry.name) && !entry.name.startsWith('.') && !generatorFor(path)) yield* sourceFiles(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.spec.ts')) {
        yield path;
      }
    }
  }

  // ---------------------------------------------------------------- per-file analysis

  function decoratorOf(sf, cls) {
    const t = typescript();
    for (const modifier of cls.modifiers ?? []) {
      if (!t.isDecorator(modifier)) continue;
      const call = t.isCallExpression(modifier.expression) ? modifier.expression : null;
      const name = (call ? call.expression : modifier.expression).getText(sf);
      const arg = call?.arguments[0] && unwrap(call.arguments[0]);
      const config = new Map();
      if (arg && t.isObjectLiteralExpression(arg)) for (const p of arg.properties) if (t.isPropertyAssignment(p)) config.set(nameOf(p.name), unwrap(p.initializer));
      return { name, config };
    }
    return null;
  }

  /** `inject(X)` and constructor parameters → { name, file } of what the class gets injected. */
  function injectionsOf(sf, cls, imports) {
    const t = typescript();
    const found = [];
    const add = (local) => {
      const imported = imports.get(local);
      if (imported?.file) found.push({ name: imported.imported, file: rel(imported.file) });
    };
    walk(cls, (node) => {
      if (t.isCallExpression(node) && node.expression.getText(sf) === 'inject' && node.arguments[0]) add(node.arguments[0].getText(sf));
      if (t.isParameter(node) && t.isConstructorDeclaration(node.parent) && node.type && t.isTypeReferenceNode(node.type)) add(node.type.typeName.getText(sf));
    });
    return found;
  }

  function signalMembers(sf, cls) {
    const t = typescript();
    const inputs = [];
    const outputs = [];
    for (const member of cls.members) {
      if (!t.isPropertyDeclaration(member)) continue;
      const name = nameOf(member.name);
      const init = member.initializer && unwrap(member.initializer);
      const callee = init && t.isCallExpression(init) ? init.expression.getText(sf) : '';
      const decorators = (member.modifiers ?? []).filter(t.isDecorator).map((d) => d.expression.getText(sf));
      if (/^(input|model)(\.required)?$/.test(callee) || decorators.some((d) => /^Input\b/.test(d))) inputs.push(name);
      if (/^(output|outputFromObservable)$/.test(callee) || decorators.some((d) => /^Output\b/.test(d)) || callee === 'model') outputs.push(name);
    }
    return { inputs, outputs };
  }

  function templateOf(sf, config) {
    const t = typescript();
    const inline = config.get('template');
    if (inline && (t.isStringLiteralLike(inline) || t.isTemplateExpression(inline))) {
      return { file: rel(sf.fileName), text: t.isTemplateExpression(inline) ? inline.getText(sf).slice(1, -1) : inline.text, inline: true };
    }
    const url = config.get('templateUrl');
    if (url && t.isStringLiteralLike(url)) {
      const file = resolve(dirname(sf.fileName), url.text);
      try {
        return { file: rel(file), text: readFileSync(file, 'utf8'), inline: false };
      } catch {
        return { file: rel(file), text: '', inline: false };
      }
    }
    return null;
  }

  /** `() => import('./x').then((m) => m.X)` → { file, name }; a call with a string argument → { remote }. */
  function lazyTarget(sf, node) {
    const t = typescript();
    let target = null;
    walk(node, (n) => {
      if (target) return false;
      if (t.isCallExpression(n) && n.expression.kind === t.SyntaxKind.ImportKeyword && t.isStringLiteralLike(n.arguments[0])) {
        const file = resolveModule(sf.fileName, n.arguments[0].text);
        let name = null;
        walk(node, (m) => {
          if (!name && t.isPropertyAccessExpression(m) && t.isIdentifier(m.expression) && m.parent && !t.isCallExpression(m.parent)) name = m.name.text;
        });
        target = { file: file && rel(file), name };
      }
    });
    if (target) return target;
    // federation helpers: loadRemoteModule('mfe-x', './routes'), remoteRoutes('mfe-x'), loadRemote('mfe-x/routes')
    walk(node, (n) => {
      if (target) return false;
      if (t.isCallExpression(n)) {
        const literal = n.arguments.find((a) => t.isStringLiteralLike(a));
        const remoteName = literal ?? n.arguments.map(unwrap).find(t.isObjectLiteralExpression)?.properties
          .find((p) => t.isPropertyAssignment(p) && nameOf(p.name) === 'remoteName')?.initializer;
        if (remoteName && t.isStringLiteralLike(remoteName)) target = { remote: remoteName.text.split('/')[0] };
      }
    });
    return target;
  }

  /** Route objects of an array literal, flattened with their full path. */
  function routesOf(sf, array, imports, prefix, out) {
    const t = typescript();
    for (const element of array.elements) {
      const route = unwrap(element);
      if (!t.isObjectLiteralExpression(route)) continue;
      const props = new Map(route.properties.filter(t.isPropertyAssignment).map((p) => [nameOf(p.name), unwrap(p.initializer)]));
      const path = props.get('path');
      const segment = path && t.isStringLiteralLike(path) ? path.text : '';
      const full = `/${[prefix, segment].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
      const entry = { path: full, line: lineOf(sf, route), target: null, guards: [] };
      const component = props.get('component');
      if (component && t.isIdentifier(component)) {
        const imported = imports.get(component.text);
        entry.target = { kind: 'component', name: imported?.imported ?? component.text, file: imported?.file ? rel(imported.file) : rel(sf.fileName) };
      }
      for (const key of ['loadComponent', 'loadChildren']) {
        if (!props.get(key)) continue;
        const lazy = lazyTarget(sf, props.get(key));
        if (lazy) entry.target = { kind: lazy.remote ? 'remote' : key === 'loadComponent' ? 'component' : 'routes', ...lazy };
      }
      const redirect = props.get('redirectTo');
      if (redirect && t.isStringLiteralLike(redirect)) entry.target = { kind: 'redirect', to: redirect.text };
      for (const key of ['canActivate', 'canActivateChild', 'canMatch', 'canDeactivate', 'resolve']) {
        const value = props.get(key);
        if (!value) continue;
        const names = t.isArrayLiteralExpression(value) ? value.elements : t.isObjectLiteralExpression(value) ? value.properties.map((p) => p.initializer) : [];
        for (const n of names) {
          const local = n && unwrap(n);
          if (!local || !t.isIdentifier(local)) continue;
          const imported = imports.get(local.text);
          entry.guards.push({ name: imported?.imported ?? local.text, file: imported?.file ? rel(imported.file) : rel(sf.fileName) });
        }
      }
      const children = props.get('children');
      if (children && t.isArrayLiteralExpression(children)) routesOf(sf, children, imports, full, out);
      else if (children && t.isIdentifier(children)) {
        const imported = imports.get(children.text);
        if (imported?.file) entry.target = { kind: 'routes', file: rel(imported.file), name: imported.imported };
      }
      if (segment || entry.target) out.push(entry);
    }
    return out;
  }

  /** What one file declares: [{ kind, name, line, summary, detail, refs: [{ type, name, file }] }]. */
  function analyseFile(file) {
    const t = typescript();
    const sf = parse(file);
    const relFile = rel(file);
    const imports = importsOf(sf);
    const text = sf.text;
    const entries = [];
    // every imported workspace declaration may be an item – resolved against the inventory later
    const importRefs = [...imports.values()].filter((i) => i.file).map((i) => ({ type: 'uses', name: i.imported, file: rel(i.file) }));

    for (const statement of sf.statements) {
      if (t.isClassDeclaration(statement) && statement.name) {
        const decorator = decoratorOf(sf, statement);
        if (!decorator) continue;
        const name = statement.name.text;
        const injects = injectionsOf(sf, statement, imports).map((i) => ({ type: 'injects', ...i }));
        const line = lineOf(sf, statement);
        const literal = (key) => {
          const v = decorator.config.get(key);
          return v && t.isStringLiteralLike(v) ? v.text : null;
        };
        if (decorator.name === 'Component' || decorator.name === 'Directive') {
          const { inputs, outputs } = signalMembers(sf, statement);
          const template = decorator.name === 'Component' ? templateOf(sf, decorator.config) : null;
          const tags = template ? [...new Set(scanTemplate(template.text).elements.map((e) => e.tag).filter((tag) => tag.includes('-')))] : [];
          entries.push({
            kind: decorator.name.toLowerCase(),
            name,
            line,
            summary: literal('selector') ?? '',
            detail: { selector: literal('selector'), inputs, outputs, template: template && { file: template.file, inline: template.inline }, tags },
            refs: [...injects, ...importRefs, ...tags.map((tag) => ({ type: 'uses', selector: tag }))],
          });
        } else if (decorator.name === 'Pipe') {
          entries.push({ kind: 'pipe', name, line, summary: literal('name') ?? '', detail: { pipeName: literal('name') }, refs: [...injects, ...importRefs] });
        } else if (decorator.name === 'Injectable' || decorator.name === 'Service') {
          let isStore = /[-.]store\.ts$/.test(relFile) || RESOURCE_CALL.test(statement.getText(sf));
          try {
            isStore ||= componentStores({ injected: [{ property: null, file }] }).length > 0;
          } catch {
            /* not analysable as a store – stays a service */
          }
          entries.push({ kind: isStore ? 'store' : 'service', name, line, summary: literal('providedIn') ? `providedIn: ${literal('providedIn')}` : '', detail: {}, refs: [...injects, ...importRefs] });
        }
        continue;
      }
      // functional guards, resolvers and interceptors: `export const authGuard: CanActivateFn = …`
      if (t.isVariableStatement(statement) && statement.modifiers?.some((m) => m.kind === t.SyntaxKind.ExportKeyword)) {
        for (const decl of statement.declarationList.declarations) {
          const type = decl.type && t.isTypeReferenceNode(decl.type) ? decl.type.typeName.getText(sf) : '';
          const name = nameOf(decl.name);
          if (FUNCTION_KINDS[type]) entries.push({ kind: FUNCTION_KINDS[type], name, line: lineOf(sf, decl), summary: type, detail: {}, refs: importRefs });
          const init = decl.initializer && unwrap(decl.initializer);
          if (init && t.isArrayLiteralExpression(init) && (/^Routes?\b|Route\[\]/.test(type) || /routes$/i.test(name) || relFile.endsWith('.routes.ts'))) {
            for (const route of routesOf(sf, init, imports, '', [])) {
              entries.push({
                kind: 'route',
                name: route.path,
                line: route.line,
                summary: describeTarget(route.target),
                detail: { target: route.target, guards: route.guards, routes: name },
                refs: [
                  ...(route.target?.file && route.target.name ? [{ type: 'routes-to', name: route.target.name, file: route.target.file }] : []),
                  ...(route.target?.kind === 'routes' && route.target.file ? [{ type: 'routes-to', routesFile: route.target.file }] : []),
                  ...(route.target?.remote ? [{ type: 'routes-to', project: route.target.remote }] : []),
                  ...route.guards.map((g) => ({ type: 'guarded-by', ...g })),
                ],
              });
            }
          }
        }
      }
    }

    // file-level items: mappers and models by the data-layer naming convention
    const exportedFunctions = [];
    const exportedTypes = [];
    for (const statement of sf.statements) {
      const exported = statement.modifiers?.some((m) => m.kind === t.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (t.isFunctionDeclaration(statement) && statement.name) exportedFunctions.push(statement.name.text);
      if (t.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) if (d.initializer && /Function|Arrow/.test(t.SyntaxKind[unwrap(d.initializer).kind])) exportedFunctions.push(nameOf(d.name));
      if ((t.isInterfaceDeclaration(statement) || t.isTypeAliasDeclaration(statement)) && statement.name) exportedTypes.push(statement.name.text);
    }
    const stem = basename(relFile, '.ts');
    if (/\.mapper$|-mapper$|\.mappers$/.test(stem) && exportedFunctions.length) {
      entries.push({ kind: 'mapper', name: stem, line: 1, summary: exportedFunctions.join(', '), detail: { functions: exportedFunctions }, refs: importRefs, declares: exportedFunctions });
    }
    if (/\.model$|\.models$|-model$/.test(stem) && exportedTypes.length) {
      entries.push({ kind: 'model', name: stem, line: 1, summary: exportedTypes.join(', '), detail: { types: exportedTypes }, refs: importRefs, declares: exportedTypes });
    }
    return entries;
  }

  function describeTarget(target) {
    if (!target) return '';
    if (target.kind === 'redirect') return `redirect → /${target.to.replace(/^\//, '')}`;
    if (target.kind === 'remote') return `remote ${target.remote}`;
    if (target.kind === 'routes') return `children from ${target.file ?? '?'}`;
    return target.name ?? target.file ?? '';
  }

  function entriesOf(file) {
    const mtimeMs = statSync(file).mtimeMs;
    const hit = fileCache.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.entries;
    let entries;
    try {
      entries = analyseFile(file);
    } catch (error) {
      entries = [{ kind: 'error', error: error.message }];
    }
    fileCache.set(file, { mtimeMs, entries });
    return entries;
  }

  // ---------------------------------------------------------------- the whole workspace

  function inventory() {
    const list = projects();
    const items = [];
    const failed = [];
    for (const project of list) {
      items.push({
        id: itemId(project.type === 'library' ? 'library' : 'application', project.root, project.name),
        kind: project.type === 'library' ? 'library' : 'application',
        name: project.name,
        file: project.root,
        line: null,
        project: project.name,
        group: '',
        summary: project.sourceRoot,
        relations: [],
      });
    }
    for (const generator of generatedOutputs()) {
      const dir = rel(generator.dir);
      const service = (() => {
        try {
          return readdirSync(generator.dir).find((f) => /\.service\.ts$/.test(f));
        } catch {
          return null;
        }
      })();
      const place = placeOf(dir + '/x.ts', list);
      items.push({
        id: itemId('api-client', dir, basename(dir)),
        kind: 'api-client',
        name: basename(dir),
        file: service ? `${dir}/${service}` : dir,
        line: null,
        ...place,
        summary: `generated from ${generator.input}`,
        detail: { spec: generator.input, generator: generator.name ?? generator.kind ?? null, dir },
        relations: [],
      });
    }

    const files = [];
    for (const root of ['projects', 'apps', 'libs', 'src']) {
      if (existsSync(join(workspace, root))) files.push(...sourceFiles(join(workspace, root)));
    }
    const raw = [];
    for (const file of files) {
      const relFile = rel(file);
      for (const entry of entriesOf(file)) {
        if (entry.kind === 'error') {
          failed.push({ file: relFile, error: entry.error });
          continue;
        }
        raw.push({ ...entry, file: relFile, ...placeOf(relFile, list) });
      }
    }

    // resolve references: class name + file, a mapper/model file, a selector, a project name
    const byFileName = new Map();
    const byFile = new Map();
    const bySelector = new Map();
    for (const entry of raw) {
      entry.id = itemId(entry.kind, entry.file, entry.name);
      byFileName.set(`${entry.file}#${entry.name}`, entry);
      for (const declared of entry.declares ?? []) byFileName.set(`${entry.file}#${declared}`, entry);
      if (!byFile.has(entry.file)) byFile.set(entry.file, []);
      byFile.get(entry.file).push(entry);
      for (const selector of (entry.detail?.selector ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-z][\w-]*$/.test(s))) bySelector.set(selector, entry);
    }
    const clientByDir = items.filter((i) => i.kind === 'api-client');
    const projectItem = new Map(items.filter((i) => i.kind === 'application' || i.kind === 'library').map((i) => [i.name, i]));

    for (const entry of raw) {
      const relations = new Map();
      const add = (type, target, label = null) => {
        if (!target || target === entry.id) return;
        const key = `${type} ${target}`;
        if (!relations.has(key)) relations.set(key, { type, target, ...(label ? { label } : {}) });
      };
      for (const ref of entry.refs ?? []) {
        if (ref.selector) add('uses', bySelector.get(ref.selector)?.id);
        else if (ref.project) add(ref.type, projectItem.get(ref.project)?.id, ref.project);
        else if (ref.routesFile) {
          for (const route of byFile.get(ref.routesFile) ?? []) if (route.kind === 'route') add(ref.type, route.id);
        } else if (ref.file) {
          const target = byFileName.get(`${ref.file}#${ref.name}`);
          if (target) add(target.kind === 'store' || target.kind === 'service' ? (ref.type === 'uses' ? 'injects' : ref.type) : ref.type, target.id);
          else {
            const client = clientByDir.find((c) => ref.file.startsWith(`${c.detail.dir}/`));
            if (client) add(ref.type === 'injects' ? 'injects' : 'uses', client.id);
          }
        }
      }
      // a store's API calls: the operations it reads and writes
      if (entry.kind === 'store') {
        try {
          const [found] = componentStores({ injected: [{ property: null, file: join(workspace, entry.file) }] });
          if (found) {
            const lineage = storeLineage(found.store);
            for (const op of lineage.operations) relations.set(`${op.role}s ${op.method}`, { type: op.role === 'write' ? 'writes' : 'reads', label: op.http ?? op.method });
            entry.summary = [entry.summary, lineage.spec ? `${lineage.spec.title} ${lineage.spec.version}` : ''].filter(Boolean).join(' · ');
          }
        } catch (error) {
          failed.push({ file: entry.file, error: error.message });
        }
      }
      // injecting a class implies importing it – keep the stronger relation only
      const injected = new Set([...relations.values()].filter((r) => r.type === 'injects').map((r) => r.target));
      const { refs, declares, ...item } = entry;
      items.push({ ...item, relations: [...relations.values()].filter((r) => r.type !== 'uses' || !injected.has(r.target)) });
    }
    return { kinds: KINDS, items, failed, places: placesOf(list, items) };
  }

  /**
   * Where new building blocks can go: each project's app folder and its feature folders (the groups), with the
   * project's selector prefix. A new folder goes next to the existing ones.
   */
  function placesOf(list, items) {
    const places = [];
    for (const project of list) {
      const app = existsSync(join(workspace, project.sourceRoot, 'app')) ? `${project.sourceRoot}/app` : project.sourceRoot;
      places.push({ project: project.name, group: '', folder: app, prefix: project.prefix });
      const groups = new Set(items.filter((i) => i.project === project.name && i.group).map((i) => i.group));
      for (const group of [...groups].sort()) {
        places.push({ project: project.name, group, folder: existsSync(join(workspace, app, group)) ? `${app}/${group}` : dirname(items.find((i) => i.project === project.name && i.group === group).file), prefix: project.prefix });
      }
    }
    return places;
  }

  // ---------------------------------------------------------------- details of one item

  /** Generic sections for the page: { title, columns?, rows?, items?, text? }. */
  function itemDetail(id) {
    const { items } = inventory();
    const item = items.find((i) => i.id === id);
    if (!item) throw Object.assign(new Error(`Unknown item "${id}"`), { status: 404 });
    const sections = [];
    const d = item.detail ?? {};
    if (item.kind === 'component' || item.kind === 'directive') {
      sections.push({
        title: 'Overview',
        rows: [
          ['Selector', d.selector ?? '–'],
          ['Inputs', d.inputs?.join(', ') || '–'],
          ['Outputs', d.outputs?.join(', ') || '–'],
          ...(d.template ? [['Template', d.template.inline ? 'inline' : d.template.file]] : []),
        ],
      });
    }
    if (item.kind === 'store' || item.kind === 'component') {
      const storeFiles = item.kind === 'store'
        ? [join(workspace, item.file)]
        : item.relations.filter((r) => r.type === 'injects').map((r) => items.find((i) => i.id === r.target)).filter((i) => i?.kind === 'store').map((i) => join(workspace, i.file));
      for (const file of storeFiles) {
        try {
          const [found] = componentStores({ injected: [{ property: null, file }] });
          if (!found) continue;
          const lineage = storeLineage(found.store);
          sections.push({
            title: `Data · ${lineage.name}${lineage.spec ? ` (${lineage.spec.title} ${lineage.spec.version})` : ''}`,
            columns: ['Role', 'Operation', 'HTTP', 'Store method', 'Mapper'],
            rows: lineage.operations.map((op) => [
              op.role,
              op.method,
              op.http ?? '–',
              op.storeMethod ?? '–',
              op.role === 'write'
                ? (lineage.writes.find((w) => w.operation === op.method)?.mapper?.name ?? '–')
                : (lineage.mapper?.name ?? '–'),
            ]),
          });
          if (item.kind === 'store' && lineage.signals?.length) sections.push({ title: 'Signals', items: lineage.signals });
        } catch (error) {
          sections.push({ title: 'Data', text: `Could not be analysed: ${error.message}` });
        }
      }
    }
    if (item.kind === 'component') sections.push(...formSections(item));
    if (item.kind === 'mapper') sections.push({ title: 'Functions', items: d.functions ?? [] });
    if (item.kind === 'model') sections.push({ title: 'Types', items: d.types ?? [] });
    if (item.kind === 'route') {
      sections.push({
        title: 'Route',
        rows: [
          ['Path', item.name],
          ['Target', describeTarget(d.target) || '–'],
          ['Guards', d.guards?.map((g) => g.name).join(', ') || '–'],
          ['Defined in', `${item.file}:${item.line} (${d.routes})`],
        ],
      });
    }
    if (item.kind === 'api-client') sections.push({ title: 'Generated', rows: [['Spec', d.spec], ['Output', d.dir], ['Generator', d.generator ?? '–']] });
    return { item, sections };
  }

  /** The component's forms as `benda check` sees them: each control's API field, validators and status. */
  function formSections(item) {
    const file = join(workspace, item.file);
    if (!readFileSync(file, 'utf8').includes('Form')) return [];
    try {
      const analysis = analyseComponent(file);
      const details = componentStores(analysis).map(({ property, store }) => ({ property, store, lineage: storeLineage(store) }));
      return analyseForms({ analysis, file: item.file, stores: details, selected: null }).map((form) => ({
        title: `Form · ${form.name} (${form.kind === 'signal' ? 'Signal Forms' : 'Reactive Forms'})`,
        text: form.submit
          ? `Submit → ${form.submit.store}.${form.submit.method} → ${form.submit.operation}${form.submit.http ? ` (${form.submit.http})` : ''}${form.submit.mapper ? ` via ${form.submit.mapper.name}` : ''}`
          : 'No API write – the submit reaches no store write.',
        columns: ['Control', 'API field', 'Validators', 'Status', 'Issues'],
        rows: form.controls.map((c) => [
          c.name ?? '–',
          c.apiField ?? '–',
          c.validators.map((v) => (v.value === undefined || v.value === null ? v.kind : `${v.kind} ${v.value}`)).join(', ') || '–',
          c.status,
          c.issues.join('; ') || '–',
        ]),
      }));
    } catch (error) {
      return [{ title: 'Forms', text: `Could not be analysed: ${error.message}` }];
    }
  }

  return { inventory, itemDetail };
}
