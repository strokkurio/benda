// Workspace-wide data-layer check behind `benda check` (contract: core src/adapter.mjs, `check()`). Applies the rules
// of the skill's data-layer.md to every component, store, mapper and form, reusing the lineage analysis.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { lineOf, parse, rel, resolveModule, typescript, unwrap, walk } from './ast.mjs';
import { analyseForms, levelsOf } from './forms.mjs';
import { analyseComponent, componentStores, generatorFor, storeLineage, templateSources } from './lineage.mjs';
import { templateBindings } from './template.mjs';

const IGNORED = new Set(['node_modules', 'dist', '.angular', '.git', 'coverage', 'out-tsc', 'tmp']);
// state signals of a store: everything else it exposes counts as data
const LOADING = new Set(['isLoading', 'status']);
const ERROR = new Set(['error', 'status']);
const STATE = new Set([...LOADING, ...ERROR, 'hasValue']);
const WRITABLE = new Set(['signal', 'model', 'input']);
const MATCHERS = new Set(['toEqual', 'toStrictEqual', 'toMatchObject', 'objectContaining', 'toHaveProperty']);

function* sourceFiles(dir, ignored) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // generated clients are never edited, so they are never checked either
      if (!ignored.has(entry.name) && !entry.name.startsWith('.') && !generatorFor(path))
        yield* sourceFiles(path, ignored);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.spec.ts')) {
      yield path;
    }
  }
}

/** Public store signals that carry data, i.e. neither loading/error state nor writable inputs like a filter. */
function dataSignals(store, file) {
  const t = typescript();
  const sf = parse(file);
  const writable = new Set();
  walk(sf, (node) => {
    if (!t.isPropertyDeclaration(node) || !node.initializer) return;
    const init = unwrap(node.initializer);
    if (t.isCallExpression(init) && WRITABLE.has(init.expression.getText(sf).split('.')[0]))
      writable.add(node.name.getText(sf));
  });
  return store.signals.filter((s) => !STATE.has(s) && !writable.has(s));
}

/** `@api/*` or anything resolving into generated client output, imported by a component. */
function clientImports(sf, file) {
  const t = typescript();
  const found = [];
  for (const statement of sf.statements) {
    if (!(t.isImportDeclaration(statement) || t.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
    const specifier = statement.moduleSpecifier.text;
    const target = resolveModule(file, specifier);
    if (specifier.startsWith('@api/') || (target && generatorFor(target)))
      found.push({ specifier, line: lineOf(sf, statement) });
  }
  return found;
}

const TEST_BLOCKS = new Set(['it', 'test', 'fit']);

/**
 * Names a spec reads (`customer.name`) and asserts as object keys (`toEqual({ city })`), per mapper: only the test
 * blocks that call the mapper count, so another mapper's assertions in the same file do not cover its fields.
 */
function specCoverage(file) {
  const t = typescript();
  const sf = parse(file);
  const scan = (root) => {
    const names = new Set();
    const called = new Set();
    walk(root, (node) => {
      if (t.isPropertyAccessExpression(node)) names.add(node.name.text);
      if (!t.isCallExpression(node)) return;
      const callee = node.expression;
      if (t.isIdentifier(callee)) called.add(callee.text);
      if (!t.isPropertyAccessExpression(callee) || !MATCHERS.has(callee.name.text)) return;
      for (const arg of node.arguments) {
        if (t.isStringLiteralLike(arg)) names.add(arg.text.split('.').pop());
        walk(arg, (n) => {
          if ((t.isPropertyAssignment(n) || t.isShorthandPropertyAssignment(n)) && n.name)
            names.add(n.name.getText(sf).replace(/['"]/g, ''));
        });
      }
    });
    return { names, called };
  };
  const blocks = [];
  walk(sf, (node) => {
    if (!t.isCallExpression(node)) return;
    const callee = node.expression.getText(sf).split('.')[0];
    if (!TEST_BLOCKS.has(callee)) return;
    blocks.push(scan(node));
    return false;
  });
  if (!blocks.length) blocks.push(scan(sf));
  const called = new Set(blocks.flatMap((b) => [...b.called]));
  const covered = (mapper) => new Set(blocks.filter((b) => b.called.has(mapper)).flatMap((b) => [...b.names]));
  return { called, covered };
}

/**
 * The workspace as `benda check` and the spec impact see it: its source files without generated clients, every
 * component with its stores and their lineage, then the stores no component injects. Lineages are computed once per
 * store file. `failed(file, error)` receives what could not be analysed; the generators run lazily in that order.
 */
export function scanWorkspace({ workspace, stateDir, failed }) {
  const ignored = new Set([...IGNORED, basename(stateDir)]);
  const files = [...sourceFiles(workspace, ignored)];
  const lineages = new Map(); // store file → storeLineage
  const lineageOf = (store) => {
    if (!lineages.has(store.file)) lineages.set(store.file, storeLineage(store));
    return lineages.get(store.file);
  };

  /** Components that could be analysed: { file, relFile, analysis, stores, details: [{ property, store, lineage }] } */
  function* components() {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('@Component')) continue;
      let analysis;
      let stores;
      try {
        analysis = analyseComponent(file);
        if (!analysis.cls) continue;
        stores = componentStores(analysis);
      } catch (error) {
        failed(rel(file), error);
        continue;
      }
      const details = [];
      for (const { property, store } of stores) {
        try {
          details.push({ property, store, lineage: lineageOf(store) });
        } catch (error) {
          failed(store.file, error);
        }
      }
      yield { file, relFile: rel(file), analysis, stores, details };
    }
  }

  /** Adds the lineage of stores no component injects; call after components() is consumed. */
  function remainingStores() {
    for (const file of files) {
      if (lineages.has(rel(file))) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes('@Component') || !/\binject\s*\(|constructor\s*\(/.test(text)) continue;
      try {
        const [found] = componentStores({ injected: [{ property: null, file }] });
        if (found) lineageOf(found.store);
      } catch (error) {
        failed(rel(file), error);
      }
    }
  }

  return { files, lineages, components, remainingStores };
}

/** createCheck() is called after createLineage(), which initialises the shared TypeScript helpers. */
export function createCheck({ workspace, stateDir }) {
  return function check() {
    const findings = [];
    const add = (level, rule, file, line, message, fix) =>
      findings.push({ level, rule, file, line: line ?? 1, message, ...(fix && { fix }) });
    const failed = (file, error) =>
      add('warning', 'analysis-failed', file, 1, `could not be analysed: ${error.message}`);

    const { files, lineages, components: scanned, remainingStores } = scanWorkspace({ workspace, stateDir, failed });
    const mapperModules = new Map(); // file → Map(name → { mapper, kind })
    for (const file of files) {
      if (/\.mapper\.ts$/.test(file) && !mapperModules.has(rel(file))) mapperModules.set(rel(file), new Map());
    }
    let components = 0;
    let forms = 0;

    for (const { file, relFile, analysis, stores, details } of scanned()) {
      components++;

      for (const { specifier, line } of clientImports(analysis.sf, file)) {
        add(
          'error',
          'component-imports-api',
          relFile,
          line,
          `component imports ${specifier} – components inject a store and never use the generated client or its DTOs`,
          'Move the API access into a store (data-access/<entity>-store.ts) and map DTOs to a UI model in a mapper.',
        );
      }

      if (analysis.template && stores.length) {
        const bindings = templateBindings(analysis.template, templateSources(analysis, stores));
        for (const { property, store } of stores) {
          if (!property) continue;
          const data = new Set(dataSignals(store, join(workspace, store.file)));
          const own = bindings.filter((b) => b.store === store.name);
          const hasLoading = store.signals.some((s) => LOADING.has(s));
          const hasError = store.signals.some((s) => ERROR.has(s));
          if (!hasLoading && !hasError) continue;
          // data reads in the template and in class code (computed views, handlers)
          const reads = own
            .filter((b) => data.has(b.storeSignal))
            .map((b) => ({ signal: b.storeSignal, line: b.line }));
          const source = analysis.sf.text;
          for (const m of source.matchAll(new RegExp(`this\\.${property}\\.(\\w+)\\(`, 'g'))) {
            if (data.has(m[1]))
              reads.push({
                signal: m[1],
                line: analysis.sf.getLineAndCharacterOfPosition(m.index).line + 1,
                code: true,
              });
          }
          if (!reads.length) continue;
          const missing = [
            hasLoading && !own.some((b) => LOADING.has(b.storeSignal)) && 'isLoading',
            hasError && !own.some((b) => ERROR.has(b.storeSignal)) && 'error',
          ].filter(Boolean);
          if (!missing.length) continue;
          const first = reads.find((r) => !r.code) ?? reads[0];
          add(
            'warning',
            'states-not-rendered',
            first.code ? relFile : analysis.template.file,
            first.line,
            `reads ${store.name}.${[...new Set(reads.map((r) => r.signal))].join('/')} but the template never renders ${missing.map((s) => `${store.name}.${s}`).join(' or ')}`,
            missing
              .map((s) =>
                s === 'isLoading' ? `show a loading state from ${property}.isLoading()` : `show ${property}.error()`,
              )
              .join(' and ')
              .replace(/^s/, 'S') + '.',
          );
        }
      }

      try {
        for (const form of analyseForms({ analysis, file: relFile, stores: details, selected: null })) {
          forms++;
          for (const control of form.controls) {
            const required = Boolean(control.spec?.required);
            let level = null;
            // the status shows the worst issue only; a differing validator stays an error next to a missing one
            if (control.status === 'differs' || levelsOf(control).includes('differs')) level = 'error';
            else if (control.status === 'missing')
              level = control.issues.some((i) => i.includes('is required by the API')) ? 'error' : 'warning';
            else if (control.status === 'missing-control') level = required ? 'error' : 'warning';
            else if (control.status === 'extra') level = 'info';
            if (!level) continue;
            add(
              level,
              'form-validation',
              relFile,
              control.line ?? form.line,
              `${form.name}.${control.name ?? control.apiField}: ${control.issues.join('; ')}`,
              control.status === 'missing-control'
                ? `Add a control for ${control.apiField} or set it in ${form.submit?.mapper?.name ?? 'the write mapper'}.`
                : 'Align the validators with the spec schema (required, maxLength, pattern, format).',
            );
          }
        }
      } catch (error) {
        failed(relFile, error);
      }
    }

    // stores no component injects are checked as well
    remainingStores();

    const gaps = new Set();
    for (const lineage of lineages.values()) {
      for (const op of lineage.operations) {
        if (op.http || !op.spec) continue;
        add(
          'error',
          'operation-unknown',
          lineage.file,
          op.line,
          `${lineage.name} calls ${op.method}, which matches no operationId in ${op.spec}`,
          'Regenerate the client from the current spec or call an existing operation.',
        );
      }
      for (const mapper of lineage.mappers) {
        const module = mapperModules.get(mapper.file) ?? new Map();
        module.set(mapper.name, { mapper, key: 'model' });
        mapperModules.set(mapper.file, module);
      }
      const byMapper = new Map(); // mapper name → { mapper, operations }
      for (const write of lineage.writes) {
        if (!write.mapper) {
          if (write.requestType && /^\w+$/.test(write.requestType))
            add(
              'warning',
              'write-input-gap',
              lineage.file,
              write.line,
              `${write.operation} sends a ${write.requestType} built without a write mapper`,
              `Add a pure toXInput(draft): ${write.requestType} mapper and call it in ${lineage.name}.${write.storeMethod}.`,
            );
          continue;
        }
        const module = mapperModules.get(write.mapper.file) ?? new Map();
        module.set(write.mapper.name, { mapper: write.mapper, key: 'dto' });
        mapperModules.set(write.mapper.file, module);
        const entry = byMapper.get(write.mapper.name) ?? { mapper: write.mapper, operations: [] };
        entry.operations.push(write.operation);
        byMapper.set(write.mapper.name, entry);
      }
      for (const { mapper, operations } of byMapper.values()) {
        const fields = lineage.inputFields.filter((f) => f.schema === mapper.dtoType);
        const unmapped = new Set(fields.filter((f) => !f.mapped).map((f) => f.path));
        for (const f of fields) {
          // an unset optional object is reported once, not once per field inside it
          const ancestors = f.path
            .split('.')
            .map((_, i, parts) => parts.slice(0, i).join('.'))
            .filter(Boolean);
          if (f.mapped || ancestors.some((a) => unmapped.has(a))) continue;
          const key = `${mapper.file}|${mapper.name}|${f.schema}|${f.path}`;
          if (gaps.has(key)) continue;
          gaps.add(key);
          add(
            f.required ? 'error' : 'info',
            'write-input-gap',
            mapper.file,
            mapper.line,
            f.required
              ? `${mapper.name} does not set ${f.path}, required by ${f.schema} – ${operations.join('/')} requests are invalid`
              : `${mapper.name} does not set ${f.path} (optional in ${f.schema}, used by ${operations.join('/')})`,
            `Map ${f.path} in ${mapper.name}${f.required ? '' : ' if the UI should write it'}.`,
          );
        }
      }
    }

    for (const [file, mappers] of mapperModules) {
      const spec = file.replace(/\.ts$/, '.spec.ts');
      const names = [...mappers.keys()];
      const firstLine = Math.min(...[...mappers.values()].map((m) => m.mapper.line), Infinity);
      const line = Number.isFinite(firstLine) ? firstLine : 1;
      if (!existsSync(join(workspace, spec))) {
        add(
          'info',
          'mapper-untested',
          file,
          line,
          `no unit test: ${basename(spec)} is missing${names.length ? ` (mappers ${names.join(', ')})` : ''}`,
          `Add ${basename(spec)} with one expectation per mapped field.`,
        );
        continue;
      }
      let coverage;
      try {
        coverage = specCoverage(join(workspace, spec));
      } catch (error) {
        failed(spec, error);
        continue;
      }
      for (const { mapper, key } of mappers.values()) {
        if (!coverage.called.has(mapper.name)) {
          add('info', 'mapper-untested', file, mapper.line, `${mapper.name} is never called in ${basename(spec)}`);
          continue;
        }
        const covered = coverage.covered(mapper.name);
        const untested = [
          ...new Set(mapper.fields.map((f) => f[key]).filter((path) => !covered.has(path.split('.').pop()))),
        ];
        if (untested.length)
          add(
            'info',
            'mapper-untested',
            file,
            mapper.line,
            `${mapper.name}: ${untested.join(', ')} not checked in ${basename(spec)}`,
            `Assert ${untested.join(', ')} in the ${mapper.name} test.`,
          );
      }
    }

    findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return {
      findings,
      stats: {
        files: files.length,
        components,
        stores: lineages.size,
        mappers: [...mapperModules.values()].reduce((n, m) => n + m.size, 0),
        forms,
      },
    };
  };
}
