// TypeScript helpers shared by the lineage and forms analysis. Uses the workspace's own compiler API, so Benda
// has no dependency on TypeScript and parses with the version the project builds with.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Set once by initAst(): one adapter (and so one workspace) per bridge process.
let WORKSPACE, workspaceRequire, ts, compilerOptions;
const parsed = new Map(); // file → { mtimeMs, sf }

export function initAst(workspace) {
  WORKSPACE = workspace;
  workspaceRequire = createRequire(join(workspace, 'package.json'));
  ts = undefined;
  compilerOptions = undefined;
  parsed.clear();
}

export function typescript() {
  ts ??= workspaceRequire('typescript');
  return ts;
}

export const rel = (file) => relative(WORKSPACE, file).split(sep).join('/');

/** Parsed source file, cached until the file changes: one selection analyses the same store and mappers often. */
export function parse(file) {
  const mtimeMs = statSync(file).mtimeMs;
  const hit = parsed.get(file);
  if (hit?.mtimeMs === mtimeMs) return hit.sf;
  const t = typescript();
  const sf = t.createSourceFile(file, readFileSync(file, 'utf8'), t.ScriptTarget.Latest, true);
  parsed.set(file, { mtimeMs, sf });
  return sf;
}

/** Pre-order walk; `visit` returning false skips the node's children. */
export function walk(node, visit) {
  if (visit(node) === false) return;
  typescript().forEachChild(node, (child) => {
    walk(child, visit);
  });
}

export const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Strips parentheses, `as`, `satisfies`, `!` and `<T>x` around an expression. */
export function unwrap(node) {
  const t = typescript();
  while (
    node &&
    (t.isParenthesizedExpression(node) ||
      t.isAsExpression(node) ||
      t.isSatisfiesExpression?.(node) ||
      t.isNonNullExpression(node) ||
      t.isTypeAssertionExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

export function isFunctionLike(node) {
  const t = typescript();
  return Boolean(
    node &&
    (t.isArrowFunction(node) ||
      t.isFunctionExpression(node) ||
      t.isFunctionDeclaration(node) ||
      t.isMethodDeclaration(node)),
  );
}

/** Name of a property, method or binding element, without quotes. */
export function nameOf(node) {
  const t = typescript();
  if (!node) return null;
  if (t.isIdentifier(node) || t.isPrivateIdentifier(node) || t.isStringLiteral(node) || t.isNumericLiteral(node)) {
    return node.text;
  }
  return node.getText().replace(/['"]/g, '');
}

// ---------------------------------------------------------------- module resolution

/** The workspace's compiler options – TypeScript follows `extends`, so paths in a tsconfig.base.json (Nx) count too. */
function options() {
  if (compilerOptions) return compilerOptions;
  const t = typescript();
  const file = ['tsconfig.json', 'tsconfig.base.json'].map((name) => join(WORKSPACE, name)).find(existsSync);
  const host = { ...t.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
  compilerOptions = (file && t.getParsedCommandLineOfConfigFile(file, {}, host)?.options) || {};
  return compilerOptions;
}

const matchesPath = (specifier, pattern) => (pattern.endsWith('*') ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern);

export function resolveModule(fromFile, specifier) {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fromFile), specifier);
    return [`${base}.ts`, join(base, 'index.ts'), base].find((f) => existsSync(f) && f.endsWith('.ts')) ?? null;
  }
  const { paths = {}, baseUrl } = options();
  // packages like @angular/core are never workspace sources – skip TypeScript's node_modules lookup for them
  if (!baseUrl && !Object.keys(paths).some((pattern) => matchesPath(specifier, pattern))) return null;
  const t = typescript();
  // TypeScript's own rules: exact match before wildcard, longest prefix, every target in turn
  const found = t.resolveModuleName(specifier, fromFile, options(), t.sys).resolvedModule;
  if (!found || found.isExternalLibraryImport || !/\.tsx?$/.test(found.resolvedFileName) || found.resolvedFileName.endsWith('.d.ts')) return null;
  return resolve(found.resolvedFileName);
}

/** local name → { module, imported, file } (file only for workspace sources) */
export function importsOf(sf) {
  const t = typescript();
  const map = new Map();
  for (const statement of sf.statements) {
    if (!t.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue;
    const module = statement.moduleSpecifier.text;
    const bindings = statement.importClause.namedBindings;
    if (!t.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      const file = resolveModule(sf.fileName, module);
      // through a barrel (index.ts with `export * from`) to the file that declares it, e.g. the store itself
      map.set(element.name.text, { module, imported, file: (file && exportedDeclaration(file, imported)?.sf.fileName) || file });
    }
  }
  return map;
}

// ---------------------------------------------------------------- declarations

/** Top-level declaration `name` of a module: function, `const x = () => …`, interface, type alias or variable. */
function localDeclaration(sf, name) {
  const t = typescript();
  for (const statement of sf.statements) {
    if (
      (t.isFunctionDeclaration(statement) ||
        t.isInterfaceDeclaration(statement) ||
        t.isTypeAliasDeclaration(statement) ||
        t.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return statement;
    }
    if (t.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (d) => t.isIdentifier(d.name) && d.name.text === name,
      );
      if (declaration) return declaration;
    }
  }
  return null;
}

/** Declaration exported as `name` by a module, following `export … from` re-exports (barrel files). */
export function exportedDeclaration(file, name, depth = 0) {
  const t = typescript();
  if (!file || depth > 3) return null;
  const sf = parse(file);
  const local = localDeclaration(sf, name);
  if (local) return { sf, node: local };
  for (const statement of sf.statements) {
    if (!t.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
    const target = resolveModule(sf.fileName, statement.moduleSpecifier.text);
    if (!statement.exportClause) {
      const found = exportedDeclaration(target, name, depth + 1);
      if (found) return found;
    } else if (t.isNamedExports(statement.exportClause)) {
      const element = statement.exportClause.elements.find((e) => e.name.text === name);
      if (element) return exportedDeclaration(target, (element.propertyName ?? element.name).text, depth + 1);
    }
  }
  return null;
}

/** Declaration a local name refers to in `sf`: declared in the module itself or imported from a workspace module. */
export function declarationOf(sf, name) {
  const local = localDeclaration(sf, name);
  if (local) return { sf, node: local, name };
  const imported = importsOf(sf).get(name);
  if (!imported?.file) return null;
  const found = exportedDeclaration(imported.file, imported.imported);
  return found && { ...found, name: imported.imported };
}

/** The function behind a declaration: a function declaration or a variable initialised with an arrow/function. */
export function functionOf(node) {
  const t = typescript();
  if (!node) return null;
  if (t.isFunctionDeclaration(node)) return node;
  if (t.isVariableDeclaration(node)) {
    const init = unwrap(node.initializer);
    if (init && (t.isArrowFunction(init) || t.isFunctionExpression(init))) return init;
  }
  return null;
}

/** Referenced type of an annotation: `X`, `X[]`, `X | null`, `Readonly<X>`, `Partial<X>` → node of X. */
export function typeReference(typeNode) {
  const t = typescript();
  if (!typeNode) return null;
  if (t.isArrayTypeNode(typeNode)) return typeReference(typeNode.elementType);
  if (t.isUnionTypeNode(typeNode)) {
    for (const part of typeNode.types) {
      const found = typeReference(part);
      if (found) return found;
    }
    return null;
  }
  if (t.isParenthesizedTypeNode?.(typeNode)) return typeReference(typeNode.type);
  if (!t.isTypeReferenceNode(typeNode)) return null;
  const name = typeNode.typeName.getText();
  if (
    /^(Readonly|Partial|Required|Array|ReadonlyArray|Pick|Omit|NonNullable|Promise|Observable)$/.test(name) &&
    typeNode.typeArguments?.[0]
  ) {
    return typeReference(typeNode.typeArguments[0]);
  }
  return typeNode;
}

/** Name of the class a node belongs to and the member (method or property) it sits in. */
export function enclosingMember(node) {
  const t = typescript();
  for (let p = node.parent; p; p = p.parent) {
    if (
      (t.isMethodDeclaration(p) || t.isPropertyDeclaration(p) || t.isGetAccessor(p) || t.isConstructorDeclaration(p)) &&
      t.isClassLike(p.parent)
    ) {
      return t.isConstructorDeclaration(p) ? 'constructor' : nameOf(p.name);
    }
  }
  return null;
}

/** Public: not `private`/`protected` and no `#name`. */
export function isPublic(member) {
  const t = typescript();
  if (t.isPrivateIdentifier(member.name)) return false;
  return !(member.modifiers ?? []).some(
    (m) => m.kind === t.SyntaxKind.PrivateKeyword || m.kind === t.SyntaxKind.ProtectedKeyword,
  );
}
