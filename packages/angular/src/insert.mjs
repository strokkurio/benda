// Direct insertion of a catalog component for the overlay's Components tab (contract: core src/adapter.mjs,
// `insert()`): the snippet goes before, after or into the element it was dropped on, the component's class into the
// standalone component's `imports` and its import into the .ts file. No agent is involved, so it writes only when the
// element and the places for the imports are unambiguous; otherwise it refuses with the reason and the overlay hands
// the drop to an agent.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { initAst, nameOf, typescript, unwrap } from './ast.mjs';
import { VOID, scanTemplate } from './template.mjs';

const POSITIONS = new Set(['before', 'after', 'inside']);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MODULE = /^[^'"`\s\\]+$/;
// only plain attributes can be compared with the DOM – bindings ([x], (x), *x, #x) have no fixed value there
const STATIC_ATTR = /^[a-zA-Z][\w:.-]*$/;
// property and event bindings, interpolation, structural directives and control flow name fields of the host component
const BINDING = /\[[^\]\s]+\]\s*=|\([^)\s]+\)\s*=|\{\{|\*\w+\s*=|@(if|for|switch|defer)\b/;

/** An error the overlay shows as the reason a drop went to an agent instead. */
const refuse = (message) => Object.assign(new Error(message), { status: 409 });

/**
 * The template element the DOM element comes from: every static class of the template element must be on the DOM
 * element, matching static attributes and the element's own text decide between the rest. A tie is no match – a
 * guess would write into the wrong place.
 */
export function findTemplateElement(scan, element) {
  const domClasses = new Set(element.classes ?? []);
  const attributes = element.attributes ?? {};
  const ownText = element.ownText?.slice(0, 40);
  const scored = scan.elements
    .filter((e) => e.tag === element.tag)
    .map((e) => {
      const statics = e.attrs.filter((a) => a.value !== null && STATIC_ATTR.test(a.name));
      const classes = statics.find((a) => a.name === 'class')?.value.split(/\s+/).filter(Boolean) ?? [];
      if (classes.some((c) => !domClasses.has(c))) return null;
      let score = classes.length * 2;
      for (const a of statics) if (a.name !== 'class' && attributes[a.name.toLowerCase()] === a.value) score += 2;
      const inner = e.close === null ? '' : scan.text.slice(e.end, e.close);
      if (ownText && inner.includes(ownText)) score += 6;
      return { e, score };
    })
    .filter(Boolean);
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  if (!top.length) throw refuse(`No <${element.tag}> with these classes found in the template`);
  if (top.length > 1) throw refuse(`${top.length} <${element.tag}> elements in the template match the dropped-on element (lines ${top.map((s) => scan.lineAt(s.e.start)).join(', ')})`);
  return top[0].e;
}

/** Where the snippet goes in the template text and what is inserted there, indented like its neighbours. */
export function placeSnippet(scan, target, position, snippet) {
  const text = scan.text;
  const lineStart = (at) => text.lastIndexOf('\n', at - 1) + 1;
  const indent = text.slice(lineStart(target.start)).match(/^[ \t]*/)[0];
  const block = (prefix) => snippet.trim().split('\n').map((line, i) => (i ? prefix + line : line)).join('\n');
  const selfClosing = text[target.end - 2] === '/';
  const leaf = target.close === null && (VOID.has(target.tag) || selfClosing);
  if (target.close === null && !leaf) throw refuse(`<${target.tag}> at line ${target.line} has no closing tag`);
  if (position === 'before') return { at: target.start, text: `${block(indent)}\n${indent}` };
  const end = leaf ? target.end : text.indexOf('>', target.close) + 1;
  if (position === 'after') return { at: end, text: `\n${indent}${block(indent)}` };
  if (leaf) throw refuse(`<${target.tag}> cannot contain elements`);
  // a closing tag on a line of its own gets the child on the line above it, one level deeper
  if (/^[ \t]*$/.test(text.slice(lineStart(target.close), target.close))) {
    const child = indent + (indent.includes('\t') ? '\t' : '  ');
    return { at: lineStart(target.close), text: `${child}${block(child)}\n` };
  }
  return { at: target.close, text: block(indent) };
}

/** Angular before 19 treats a component without `standalone` as part of an NgModule. */
function standaloneByDefault(workspace) {
  try {
    const file = createRequire(join(workspace, 'package.json')).resolve('@angular/core/package.json');
    return Number(JSON.parse(readFileSync(file, 'utf8')).version.split('.')[0]) >= 19;
  } catch {
    return true;
  }
}

export function createInsert({ workspace }) {
  initAst(workspace);
  const rel = (file) => relative(workspace, file).split(sep).join('/');

  /** { item, position, component: { name, snippet, import? } } → { file, line, files } */
  return function insert({ item, position, component }) {
    if (!POSITIONS.has(position)) throw new Error(`Unknown position "${position}" (before, after, inside)`);
    const snippet = String(component?.snippet ?? '').trim();
    const tag = snippet.match(/^<([a-zA-Z][\w-]*)/)?.[1];
    if (!tag) throw new Error(`The snippet of "${component?.name}" does not start with an element`);
    // written as is, they would not compile: the fields they read only an agent can add
    if (BINDING.test(snippet)) throw refuse(`${component.name} binds to fields the component does not have yet`);
    const imported = component.import;
    if (imported && (!IDENTIFIER.test(imported.name ?? '') || !MODULE.test(imported.from ?? ''))) {
      throw new Error(`Invalid import of "${component.name}": ${JSON.stringify(imported)}`);
    }
    const owner = item?.owner?.name?.replace(/^_+/, '');
    if (!owner || !item.source?.file) throw refuse('The element is not declared in a component of this workspace');

    const t = typescript();
    const tsFile = join(workspace, item.source.file);
    const files = new Map(); // absolute file → { text, mtimeMs, edits: [{ at, text }] }
    const open = (file) => {
      if (!files.has(file)) {
        const mtimeMs = statSync(file).mtimeMs;
        files.set(file, { text: readFileSync(file, 'utf8'), mtimeMs, edits: [] });
      }
      return files.get(file);
    };
    const ts = open(tsFile);
    const sf = t.createSourceFile(tsFile, ts.text, t.ScriptTarget.Latest, true);
    const cls = sf.statements.find((s) => t.isClassDeclaration(s) && s.name?.text === owner);
    const config = cls?.modifiers
      ?.filter((m) => t.isDecorator(m) && t.isCallExpression(m.expression) && m.expression.expression.getText(sf) === 'Component')
      .map((m) => m.expression.arguments[0])
      .find((arg) => arg && t.isObjectLiteralExpression(arg));
    if (!config) throw refuse(`No @Component class ${owner} in ${item.source.file}`);
    const prop = (key) => config.properties.find((p) => t.isPropertyAssignment(p) && nameOf(p.name) === key);

    const standalone = prop('standalone')?.initializer.kind;
    if (standalone === t.SyntaxKind.FalseKeyword || (standalone === undefined && !standaloneByDefault(workspace))) {
      throw refuse(`${owner} belongs to an NgModule – its imports are declared there`);
    }

    // the template: its file, its text and where that text starts in the file
    let template;
    const inline = prop('template') && unwrap(prop('template').initializer);
    const url = prop('templateUrl')?.initializer;
    if (inline) {
      if (!t.isNoSubstitutionTemplateLiteral(inline) && !t.isTemplateExpression(inline)) throw refuse(`The inline template of ${owner} is no template literal`);
      if (/`|\$\{/.test(snippet)) throw refuse('The snippet contains ` or ${, which would end the inline template');
      const base = inline.getStart(sf) + 1;
      template = { file: tsFile, base, text: ts.text.slice(base, inline.end - 1) };
    } else if (url && t.isStringLiteralLike(url)) {
      const file = resolve(dirname(tsFile), url.text);
      template = { file, base: 0, text: open(file).text };
    } else {
      throw refuse(`No template found for ${owner}`);
    }
    const scan = scanTemplate(template.text);
    const place = placeSnippet(scan, findTemplateElement(scan, item.element ?? {}), position, snippet);
    open(template.file).edits.push({ at: template.base + place.at, text: place.text });

    // imports: the Angular class of the component, or the schema that allows a custom element
    const quote = sf.statements.find(t.isImportDeclaration)?.moduleSpecifier.getText(sf)[0] ?? "'";
    const addImport = (name, from) => {
      const declarations = sf.statements.filter(t.isImportDeclaration);
      const named = (d) => (d.importClause?.namedBindings && t.isNamedImports(d.importClause.namedBindings) ? d.importClause.namedBindings : null);
      const same = declarations.find((d) => d.moduleSpecifier.text === from && named(d));
      if (same && named(same).elements.some((e) => e.name.text === name)) return;
      if (declarations.some((d) => named(d)?.elements.some((e) => e.name.text === name))) throw refuse(`${name} is already imported from another module`);
      if (same) {
        const last = named(same).elements.at(-1);
        ts.edits.push(last ? { at: last.end, text: `, ${name}` } : { at: named(same).getStart(sf) + 1, text: ` ${name} ` });
        return;
      }
      const last = declarations.at(-1);
      const line = `import { ${name} } from ${quote}${from}${quote};`;
      ts.edits.push(last ? { at: last.end, text: `\n${line}` } : { at: 0, text: `${line}\n` });
    };
    const addToArray = (key, name) => {
      const property = prop(key);
      if (!property) {
        const first = config.properties[0];
        const indent = ts.text.slice(ts.text.lastIndexOf('\n', first.getStart(sf)) + 1, first.getStart(sf));
        ts.edits.push({ at: first.getStart(sf), text: `${key}: [${name}],${/^\s*$/.test(indent) ? `\n${indent}` : ' '}` });
        return;
      }
      const array = unwrap(property.initializer);
      if (!t.isArrayLiteralExpression(array)) throw refuse(`\`${key}\` of ${owner} is no array literal`);
      if (array.elements.some((e) => e.getText(sf) === name)) return;
      const last = array.elements.at(-1);
      ts.edits.push(last ? { at: last.end, text: `, ${name}` } : { at: array.getStart(sf) + 1, text: name });
    };
    if (imported) {
      addImport(imported.name, imported.from);
      addToArray('imports', imported.name);
    } else if (tag.includes('-')) {
      addImport('CUSTOM_ELEMENTS_SCHEMA', '@angular/core');
      addToArray('schemas', 'CUSTOM_ELEMENTS_SCHEMA');
    }

    // an agent or the editor may have saved one of the files since it was read
    for (const [file, entry] of files) {
      if (statSync(file).mtimeMs !== entry.mtimeMs) throw refuse(`${rel(file)} changed while inserting – drop again`);
    }
    for (const [file, entry] of files) {
      if (!entry.edits.length) continue;
      const text = entry.edits.sort((a, b) => b.at - a.at).reduce((out, edit) => out.slice(0, edit.at) + edit.text + out.slice(edit.at), entry.text);
      writeFileSync(file, text);
    }
    const before = files.get(template.file).edits.filter((e) => e.at < template.base + place.at).reduce((n, e) => n + e.text.split('\n').length - 1, 0);
    const lead = place.text.length - place.text.trimStart().length;
    const line = (files.get(template.file).text.slice(0, template.base + place.at) + place.text.slice(0, lead)).split('\n').length + before;
    return { file: rel(template.file), line, files: [...files].filter(([, e]) => e.edits.length).map(([file]) => rel(file)) };
  };
}
