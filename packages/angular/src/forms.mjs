// Static form lineage: Reactive Forms and Signal Forms of a component, their validators (code and template), the
// store write the submit handler triggers and, through the write mapper, the request field and its spec constraints.
import {
  declarationOf,
  enclosingMember,
  importsOf,
  lineOf,
  nameOf,
  typeReference,
  typescript,
  unwrap,
  walk,
} from './ast.mjs';
import { attr, descendants, isInside, locateElement } from './template.mjs';

const SIGNAL_FORMS = '@angular/forms/signals';
const SIGNAL_VALIDATORS = new Set([
  'required',
  'maxLength',
  'minLength',
  'pattern',
  'email',
  'min',
  'max',
  'validate',
  'validateAsync',
  'validateTree',
  'validateHttp',
  'validateStandardSchema',
]);
const FIELD_BINDINGS = ['[formField]', '[field]', '[control]'];

// ---------------------------------------------------------------- validators

const literalValue = (node, depth = 0) => {
  const t = typescript();
  node = unwrap(node);
  if (!node) return null;
  // `Validators.maxLength(NAME_MAX)`: the value of a constant, declared in the file or imported
  if (t.isIdentifier(node) && depth < 3) {
    const declared = declarationOf(node.getSourceFile(), node.text)?.node;
    const init = declared && t.isVariableDeclaration(declared) ? unwrap(declared.initializer) : null;
    const literal = init && (t.isNumericLiteral(init) || t.isStringLiteralLike(init) || t.isPrefixUnaryExpression(init) || t.isIdentifier(init));
    if (literal) return literalValue(init, depth + 1);
  }
  if (t.isNumericLiteral(node)) return Number(node.text);
  if (t.isPrefixUnaryExpression(node) && t.isNumericLiteral(node.operand)) return -Number(node.operand.text);
  if (t.isStringLiteralLike(node)) return node.text;
  if (t.isRegularExpressionLiteral(node)) return node.text;
  return node.getText();
};

/** `Validators.required`, `[Validators.maxLength(120), …]`, `{ validators: [...] }`, `Validators.compose([...])` */
function reactiveValidators(sf, node, out = []) {
  const t = typescript();
  node = unwrap(node);
  if (!node) return out;
  if (t.isArrayLiteralExpression(node)) node.elements.forEach((e) => reactiveValidators(sf, e, out));
  else if (t.isObjectLiteralExpression(node)) {
    const validators = node.properties.find((p) => t.isPropertyAssignment(p) && nameOf(p.name) === 'validators');
    if (validators) reactiveValidators(sf, validators.initializer, out);
  } else {
    const callee = t.isCallExpression(node) ? node.expression.getText(sf) : node.getText(sf);
    const kind = callee.match(/^Validators\.(\w+)$/)?.[1];
    if (kind === 'compose' && t.isCallExpression(node)) return reactiveValidators(sf, node.arguments[0], out);
    if (kind === 'nullValidator') return out;
    out.push({
      kind: kind === 'requiredTrue' ? 'required' : (kind ?? 'custom'),
      value: kind && t.isCallExpression(node) ? literalValue(node.arguments[0]) : kind ? null : node.getText(sf),
      source: 'code',
      line: lineOf(sf, node),
    });
  }
  return out;
}

/** Validator directives Angular attaches to a reactive control's element (`required`, `maxlength="120"` …). */
function templateValidators(element) {
  if (!element) return [];
  const out = [];
  const add = (kind, a, value = a.value) => {
    if (a.bound && /^(false|null|undefined)$/.test(a.value ?? '')) return;
    out.push({
      kind,
      value: value !== null && /^\d+$/.test(value) ? Number(value) : value,
      source: 'template',
      line: a.line,
    });
  };
  const required = attr(element, 'required');
  if (required) add('required', required, null);
  for (const [name, kind] of [
    ['maxlength', 'maxLength'],
    ['minlength', 'minLength'],
    ['pattern', 'pattern'],
  ]) {
    const a = attr(element, name);
    if (a) add(kind, a);
  }
  const email = attr(element, 'email');
  if (email) add('email', email, null);
  const type = attr(element, 'type')?.value;
  // Angular's min/max directives only apply to number inputs; type=email alone is the browser's check, which
  // Angular switches off with novalidate
  for (const [name, kind] of [
    ['min', 'min'],
    ['max', 'max'],
  ]) {
    const a = attr(element, name);
    if (a && type === 'number') add(kind, a);
  }
  if (type === 'email' && !email)
    out.push({ kind: 'email', value: null, source: 'template', line: attr(element, 'type').line, native: true });
  return out;
}

// ---------------------------------------------------------------- form definitions

/** Controls of `fb.group({...})` / `new FormGroup({...})`, nested groups with a path prefix. */
function reactiveControls(sf, literal, prefix = '') {
  const t = typescript();
  const controls = [];
  for (const p of literal.properties) {
    if (!t.isPropertyAssignment(p) && !t.isShorthandPropertyAssignment(p)) continue;
    const name = prefix + nameOf(p.name);
    const init = unwrap(t.isPropertyAssignment(p) ? p.initializer : p.name);
    const control = { name, line: lineOf(sf, p), initial: null, validators: [] };
    const call = t.isCallExpression(init) || t.isNewExpression(init) ? init : null;
    const callee = call ? call.expression.getText(sf) : '';
    if (
      call &&
      /(^|\.)(group)$|^FormGroup$/.test(callee) &&
      call.arguments?.[0] &&
      t.isObjectLiteralExpression(unwrap(call.arguments[0]))
    ) {
      controls.push(...reactiveControls(sf, unwrap(call.arguments[0]), `${name}.`));
      continue;
    }
    if (t.isArrayLiteralExpression(init)) {
      control.initial = init.elements[0] ? literalValue(init.elements[0]) : null;
      control.validators = reactiveValidators(sf, init.elements[1]);
    } else if (call && /(^|\.)(control|array)$|^Form(Control|Array)$/.test(callee)) {
      control.initial = call.arguments?.[0] ? literalValue(call.arguments[0]) : null;
      control.validators = reactiveValidators(sf, call.arguments?.[1]);
      if (/array$/i.test(callee)) control.array = true;
    } else control.initial = literalValue(init);
    controls.push(control);
  }
  return controls;
}

/** Property names of the model behind a signal form: from `signal<T>(…)`'s type or the initial object literal. */
function modelFields(sf, cls, modelExpr) {
  const t = typescript();
  const property = modelExpr.getText(sf).match(/^this\.(\w+)$/)?.[1];
  const member = property && cls.members.find((m) => t.isPropertyDeclaration(m) && nameOf(m.name) === property);
  const init = member?.initializer && unwrap(member.initializer);
  if (!init || !t.isCallExpression(init)) return [];
  const fromType = (typeNode) => {
    const ref = typeReference(typeNode);
    const found = ref && declarationOf(sf, ref.typeName.getText(sf));
    const members =
      found &&
      (t.isInterfaceDeclaration(found.node)
        ? found.node.members
        : t.isTypeAliasDeclaration(found.node) && t.isTypeLiteralNode(found.node.type)
          ? found.node.type.members
          : null);
    return (members ?? [])
      .filter((m) => m.name)
      .map((m) => ({
        name: nameOf(m.name),
        line: lineOf(found.sf, m),
        file: found.sf === sf ? null : found.sf.fileName,
      }));
  };
  const typed = fromType(init.typeArguments?.[0]);
  if (typed.length) return typed;
  let literal = unwrap(init.arguments[0]);
  if (literal && t.isCallExpression(literal) && t.isIdentifier(literal.expression)) {
    const found = declarationOf(sf, literal.expression.text);
    const fn = found && (t.isFunctionDeclaration(found.node) ? found.node : unwrap(found.node.initializer));
    const body = fn?.body && (t.isBlock(fn.body) ? fn.body.statements.find(t.isReturnStatement)?.expression : fn.body);
    literal = body && unwrap(body);
  }
  if (!literal || !t.isObjectLiteralExpression(literal)) return [];
  return literal.properties
    .filter((p) => p.name)
    .map((p) => ({ name: nameOf(p.name), line: lineOf(literal.getSourceFile(), p) }));
}

/**
 * Validators of a Signal Forms schema function: required(p.x), maxLength(p.x, 120), … → path → validators, plus the
 * name of the schema's path parameter, which fix suggestions must reuse.
 */
function signalValidators(sf, schemaNode) {
  const t = typescript();
  const imports = importsOf(sf);
  let fn = unwrap(schemaNode);
  if (fn && t.isIdentifier(fn)) {
    // a schema declared separately: const orderSchema = schema<Order>((p) => { … })
    const found = declarationOf(sf, fn.text);
    const init = found?.node.initializer && unwrap(found.node.initializer);
    fn = init && t.isCallExpression(init) ? unwrap(init.arguments[0]) : init;
  }
  const byPath = new Map();
  if (!fn || !(t.isArrowFunction(fn) || t.isFunctionExpression(fn)) || !fn.parameters[0]) return { byPath, root: null };
  const root = fn.parameters[0].name.getText(sf);
  walk(fn.body, (node) => {
    if (!t.isCallExpression(node) || !t.isIdentifier(node.expression)) return;
    const imported = imports.get(node.expression.text);
    if (imported?.module !== SIGNAL_FORMS || !SIGNAL_VALIDATORS.has(imported.imported) || !node.arguments[0]) return;
    const path = node.arguments[0].getText(sf).replace(/\?/g, '');
    if (path !== root && !path.startsWith(`${root}.`)) return;
    const kind = imported.imported.startsWith('validate') ? 'custom' : imported.imported;
    const option = node.arguments[1];
    const value =
      kind === 'custom'
        ? (option?.getText(sf) ?? null)
        : ['required', 'email'].includes(kind)
          ? null
          : literalValue(option);
    const conditional = kind === 'required' && option && /\bwhen\b/.test(option.getText(sf));
    const name = path.slice(root.length + 1) || '(form)';
    const list = byPath.get(name) ?? [];
    list.push({
      kind,
      value,
      source: 'code',
      line: lineOf(sf, node),
      ...(conditional && { when: option.getText(sf) }),
    });
    byPath.set(name, list);
  });
  return { byPath, root };
}

/** Forms declared as class properties or assigned in methods: `form = this.fb.group(…)`, `order = form(this.model, …)`. */
function formDefinitions(sf, cls) {
  const t = typescript();
  const imports = importsOf(sf);
  const definitions = [];
  const consider = (name, expr, line) => {
    expr = unwrap(expr);
    if (!expr || !(t.isCallExpression(expr) || t.isNewExpression(expr))) return;
    const callee = expr.expression.getText(sf);
    const args = expr.arguments ?? [];
    if (
      t.isCallExpression(expr) &&
      t.isIdentifier(expr.expression) &&
      imports.get(callee)?.module === SIGNAL_FORMS &&
      imports.get(callee).imported === 'form' &&
      args[0]
    ) {
      const { byPath: validators, root } = signalValidators(sf, args[1]);
      const fields = modelFields(sf, cls, args[0]);
      const names = [
        ...new Set([...fields.map((f) => f.name), ...[...validators.keys()].filter((k) => k !== '(form)')]),
      ];
      definitions.push({
        name,
        kind: 'signal',
        line,
        model: args[0].getText(sf).replace(/^this\./, ''),
        schemaParam: root,
        validatorNames: new Map(
          [...imports]
            .filter(([, i]) => i.module === SIGNAL_FORMS && SIGNAL_VALIDATORS.has(i.imported))
            .map(([local, i]) => [i.imported, local]),
        ),
        controls: names.map((n) => {
          const field = fields.find((f) => f.name === n && !f.file);
          return {
            name: n,
            line: validators.get(n)?.[0]?.line ?? field?.line ?? line,
            initial: null,
            validators: validators.get(n) ?? [],
          };
        }),
      });
      return;
    }
    if (
      (/(^|\.)group$/.test(callee) && /\b(fb|formBuilder|builder|FormBuilder)\b|inject\(/i.test(callee)) ||
      callee === 'FormGroup'
    ) {
      const literal = unwrap(args[0]);
      if (literal && t.isObjectLiteralExpression(literal)) {
        definitions.push({
          name,
          kind: 'reactive',
          line,
          controls: reactiveControls(sf, literal),
          nonNullable: /nonNullable/.test(callee) || nonNullableBuilder(sf, cls, callee),
        });
      }
      return;
    }
    if ((/(^|\.)control$/.test(callee) && /\b(fb|formBuilder|builder)\b/i.test(callee)) || callee === 'FormControl') {
      definitions.push({
        name,
        kind: 'reactive',
        line,
        standalone: true,
        controls: [
          { name, line, initial: args[0] ? literalValue(args[0]) : null, validators: reactiveValidators(sf, args[1]) },
        ],
      });
    }
  };
  for (const member of cls.members) {
    if (t.isPropertyDeclaration(member) && member.initializer)
      consider(nameOf(member.name), member.initializer, lineOf(sf, member));
  }
  walk(cls, (node) => {
    if (!t.isBinaryExpression(node) || node.operatorToken.kind !== t.SyntaxKind.EqualsToken) return;
    const m = node.left.getText(sf).match(/^this\.(\w+)$/);
    if (m && !definitions.some((d) => d.name === m[1])) consider(m[1], node.right, lineOf(sf, node));
  });
  return definitions;
}

/** `this.fb.group` where fb = inject(NonNullableFormBuilder) */
function nonNullableBuilder(sf, cls, callee) {
  const t = typescript();
  const property = callee.match(/^this\.(\w+)\./)?.[1];
  const member = property && cls.members.find((m) => t.isPropertyDeclaration(m) && nameOf(m.name) === property);
  return Boolean(
    member?.initializer?.getText(sf).includes('NonNullableFormBuilder') ||
    member?.type?.getText(sf).includes('NonNullableFormBuilder'),
  );
}

// ---------------------------------------------------------------- template links

/** The template elements of the form and its controls. */
function linkTemplate(scan, form) {
  const elements = new Map();
  if (!scan) return { formElement: null, elements };
  if (form.kind === 'reactive') {
    const formElement = form.standalone
      ? null
      : scan.elements.find((e) => attr(e, '[formGroup]')?.value?.trim() === form.name);
    if (form.standalone) {
      const element = scan.elements.find((e) => attr(e, '[formControl]')?.value?.trim() === form.name);
      if (element) elements.set(form.name, element);
      return {
        formElement: element ? (scan.elements.find((e) => e.tag === 'form' && isInside(element, e)) ?? null) : null,
        elements,
      };
    }
    for (const element of formElement ? descendants(scan, formElement) : []) {
      const a = attr(element, 'formControlName');
      if (!a?.value) continue;
      const name = a.bound ? a.value.replace(/^\s*['"]|['"]\s*$/g, '') : a.value;
      const groups = [];
      for (let p = element.parent; p && p !== formElement; p = p.parent) {
        const group = attr(p, 'formGroupName')?.value;
        if (group) groups.unshift(group.replace(/^\s*['"]|['"]\s*$/g, ''));
      }
      elements.set([...groups, name].join('.'), element);
    }
    return { formElement, elements };
  }
  for (const element of scan.elements) {
    for (const binding of FIELD_BINDINGS) {
      const value = attr(element, binding)?.value?.trim();
      if (value?.startsWith(`${form.name}.`))
        elements.set(value.slice(form.name.length + 1).replace(/\?/g, ''), element);
    }
  }
  const first = elements.values().next().value;
  const formElement = first ? (scan.elements.find((e) => e.tag === 'form' && isInside(first, e)) ?? null) : null;
  return { formElement, elements };
}

/** A select whose options all carry a value cannot be emptied by the user. */
const alwaysFilled = (scan, element) =>
  element?.tag === 'select' &&
  descendants(scan, element)
    .filter((e) => e.tag === 'option')
    .every((o) => (attr(o, 'value')?.value ?? '') !== '' || attr(o, '[value]'));

// ---------------------------------------------------------------- submit path

/** Handler of the form's (ngSubmit)/(submit), else the methods that call submit(this.form, …) or reference the form. */
function submitHandlers(sf, cls, form, formElement, scan) {
  const t = typescript();
  const names = new Set();
  const handler = (a) => a?.value?.match(/^\s*(\w+)\s*\(/)?.[1];
  for (const event of ['(ngSubmit)', '(submit)']) {
    const name = formElement && handler(attr(formElement, event));
    if (name) names.add(name);
  }
  if (!names.size && scan) {
    for (const element of scan.elements) {
      if (element.tag === 'button' && attr(element, 'type')?.value === 'submit' && handler(attr(element, '(click)')))
        names.add(handler(attr(element, '(click)')));
    }
  }
  if (!names.size) {
    walk(cls, (node) => {
      if (
        t.isCallExpression(node) &&
        t.isIdentifier(node.expression) &&
        node.expression.text === 'submit' &&
        node.arguments[0]?.getText(sf) === `this.${form.name}`
      ) {
        const member = enclosingMember(node);
        if (member) names.add(member);
      }
    });
  }
  return [...names];
}

/** Calls `this.<store>.<method>(…)` in the handler and in the component methods it calls (one level). */
function storeCalls(sf, cls, handlerNames, storeProperties) {
  const t = typescript();
  const methods = new Map(
    cls.members.filter((m) => t.isMethodDeclaration(m) && m.body).map((m) => [nameOf(m.name), m]),
  );
  const queue = handlerNames.filter((n) => methods.has(n));
  const visited = new Set();
  const calls = [];
  for (let depth = 0; depth < 2 && queue.length; depth++) {
    for (const name of queue.splice(0)) {
      if (visited.has(name)) continue;
      visited.add(name);
      const method = methods.get(name);
      walk(method.body, (node) => {
        if (!t.isCallExpression(node) || !t.isPropertyAccessExpression(node.expression)) return;
        const target = node.expression.expression;
        if (
          t.isPropertyAccessExpression(target) &&
          target.expression.kind === t.SyntaxKind.ThisKeyword &&
          storeProperties.has(target.name.text)
        ) {
          calls.push({ property: target.name.text, method: node.expression.name.text, node, handler: method });
        } else if (target.kind === t.SyntaxKind.ThisKeyword && methods.has(node.expression.name.text)) {
          queue.push(node.expression.name.text);
        }
      });
    }
  }
  return calls;
}

/** Which control feeds which draft field of the store call's argument: control name → draft key. */
function draftKeys(sf, call, form) {
  const t = typescript();
  const formValue = new RegExp(
    `^this\\.(?:${form.name}(?:\\.getRawValue\\(\\)|\\.value|\\(\\)\\.value\\(\\))${form.model ? `|${form.model}\\(\\)` : ''})$`,
  );
  // destructured form values in the handler: const { name, city } = this.form.getRawValue()
  const locals = new Map();
  walk(call.handler.body, (node) => {
    if (
      !t.isVariableDeclaration(node) ||
      !node.initializer ||
      !formValue.test(unwrap(node.initializer).getText(sf).replace(/\s+/g, ''))
    )
      return;
    if (t.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements)
        locals.set(nameOf(element.name), nameOf(element.propertyName ?? element.name));
    } else if (t.isIdentifier(node.name)) locals.set(node.name.text, '*');
  });
  const controlOf = (expr) => {
    expr = unwrap(expr);
    // `this.form.value.name ?? ''`: the fallback is not a source
    while (
      expr &&
      t.isBinaryExpression(expr) &&
      [t.SyntaxKind.QuestionQuestionToken, t.SyntaxKind.BarBarToken].includes(expr.operatorToken.kind)
    )
      expr = unwrap(expr.left);
    if (!expr) return null;
    const text = expr.getText(sf).replace(/\s+|\?/g, '');
    if (t.isIdentifier(expr) && locals.has(expr.text)) return locals.get(expr.text);
    const local = text.match(/^(\w+)\.(\w+)$/);
    if (local && locals.get(local[1]) === '*') return local[2];
    const m =
      text.match(
        new RegExp(
          `^this\\.${form.name}\\.(?:controls\\.(\\w+)|get\\(['"]([\\w.]+)['"]\\))(?:\\.value|\\.getRawValue\\(\\))?$`,
        ),
      ) ??
      text.match(new RegExp(`^this\\.${form.name}\\.(?:value|getRawValue\\(\\))\\.(\\w+)$`)) ??
      text.match(new RegExp(`^this\\.${form.name}\\.(\\w+)\\(\\)\\.value\\(\\)$`)) ??
      (form.model ? text.match(new RegExp(`^this\\.${form.model}\\(\\)\\.(\\w+)$`)) : null);
    return m ? (m[1] ?? m[2]) : null;
  };
  const keys = new Map();
  const arg = unwrap(call.node.arguments.at(-1));
  if (!arg) return keys;
  const whole =
    (t.isIdentifier(arg) && locals.get(arg.text) === '*') || formValue.test(arg.getText(sf).replace(/\s+/g, ''));
  if (whole) {
    for (const control of form.controls) keys.set(control.name, control.name);
  } else if (t.isObjectLiteralExpression(arg)) {
    for (const p of arg.properties) {
      if (t.isSpreadAssignment(p)) {
        if (
          formValue.test(p.expression.getText(sf).replace(/\s+/g, '')) ||
          (t.isIdentifier(p.expression) && locals.get(p.expression.text) === '*')
        ) {
          for (const control of form.controls) if (!keys.has(control.name)) keys.set(control.name, control.name);
        }
        continue;
      }
      const control = controlOf(t.isShorthandPropertyAssignment(p) ? p.name : p.initializer);
      if (control) keys.set(control, nameOf(p.name));
    }
  }
  return keys;
}

// ---------------------------------------------------------------- spec comparison

const SPEC_KEYS = ['maxLength', 'minLength', 'pattern', 'format', 'enum', 'minimum', 'maximum'];
const normalisePattern = (p) =>
  String(p ?? '')
    .replace(/^\/(.*)\/[a-z]*$/, '$1')
    .replace(/^\^|\$$/g, '');

function compare(control, spec, element, scan) {
  const issues = [];
  const levels = [];
  const has = (kind) => control.validators.filter((v) => v.kind === kind && !v.native);
  const valueOf = (kind) =>
    has(kind)
      .map((v) => v.value)
      .find((v) => v !== null && v !== undefined);
  const flag = (level, text) => {
    levels.push(level);
    issues.push(text);
  };
  const field = control.apiField;

  if (spec.required && !has('required').length && !alwaysFilled(scan, element))
    flag('missing', `${field} is required by the API; the control has no required validator`);
  if (!spec.required && has('required').length && !has('required').some((v) => v.when))
    flag('extra', `required in the form, optional in the API`);

  for (const [kind, key, looser] of [
    ['maxLength', 'maxLength', (f, s) => f > s],
    ['minLength', 'minLength', (f, s) => f < s],
    ['max', 'maximum', (f, s) => f > s],
    ['min', 'minimum', (f, s) => f < s],
  ]) {
    const form = valueOf(kind);
    const api = spec[key];
    if (api !== undefined && form === undefined)
      flag('missing', `API ${key} ${api}; the control has no ${kind} validator`);
    else if (api === undefined && form !== undefined)
      flag('extra', `${kind} ${form} in the form; the API has no ${key}`);
    // a value only known at runtime (`maxLength(this.limit)`) is not compared – it may well match
    else if (api !== undefined && !Number.isNaN(Number(form)) && Number(form) !== Number(api)) {
      flag(
        'differs',
        `${kind} ${form} in the form, ${api} in the API (${looser(Number(form), Number(api)) ? 'the form accepts values the API rejects' : 'the form is stricter'})`,
      );
    }
  }
  if (spec.pattern !== undefined) {
    const form = valueOf('pattern');
    if (form === undefined) flag('missing', `API pattern ${spec.pattern}; the control has no pattern validator`);
    else if (normalisePattern(form) !== normalisePattern(spec.pattern))
      flag('differs', `pattern ${form} in the form, ${spec.pattern} in the API`);
  }
  if (spec.format === 'email' && !has('email').length) {
    const native = control.validators.some((v) => v.kind === 'email' && v.native);
    flag(
      'missing',
      `API format email; the control has no email validator${native ? ' (type="email" alone is only the browser check, which Angular disables)' : ''}`,
    );
  } else if (
    spec.format !== 'email' &&
    has('email').length &&
    spec.format === undefined &&
    spec.type?.startsWith('string')
  ) {
    flag('extra', 'email validator in the form; the API has no format email');
  }
  const order = ['ok', 'extra', 'differs', 'missing'];
  const status = levels.reduce((worst, level) => (order.indexOf(level) > order.indexOf(worst) ? level : worst), 'ok');
  return { status, issues, levels };
}

// every issue's level, not only the worst one the status shows; kept out of the lineage JSON
const issueLevels = new WeakMap();

/** The levels of a control's issues ('missing', 'differs', 'extra'), for `benda check`. */
export const levelsOf = (control) => issueLevels.get(control) ?? [];

const FIX_RULES = [
  ['required', (s) => s.required === true, () => null],
  ['maxLength', (s) => s.maxLength !== undefined, (s) => s.maxLength],
  ['minLength', (s) => s.minLength !== undefined, (s) => s.minLength],
  ['min', (s) => s.minimum !== undefined, (s) => s.minimum],
  ['max', (s) => s.maximum !== undefined, (s) => s.maximum],
  ['pattern', (s) => s.pattern !== undefined, (s) => s.pattern],
  ['email', (s) => s.format === 'email', () => null],
];

/**
 * The validators the spec asks for, each as a call in the form's own API, so tasks quote code the agent can paste.
 * Signal Forms calls need the schema's path parameter; without a schema function there is nothing to quote.
 */
function specFixes(form, name, spec) {
  if (!spec || !name) return null;
  const argOf = (kind, value) =>
    kind === 'pattern'
      ? `/${String(value)
          .replace(/^\/(.*)\/[a-z]*$/, '$1')
          .replace(/(?<!\\)\//g, '\\/')}/`
      : typeof value === 'number'
        ? String(value)
        : JSON.stringify(value);
  const callOf = (kind, value) => {
    if (form.kind === 'reactive')
      return value == null ? `Validators.${kind}` : `Validators.${kind}(${argOf(kind, value)})`;
    if (form.kind !== 'signal' || !form.schemaParam) return null;
    const fn = form.validatorNames?.get(kind) ?? kind;
    return `${fn}(${form.schemaParam}.${name}${value == null ? '' : `, ${argOf(kind, value)}`})`;
  };
  const fixes = FIX_RULES.filter(([, applies]) => applies(spec)).map(([kind, , valueOf]) => {
    const value = valueOf(spec);
    return { kind, value, call: callOf(kind, value) };
  });
  return fixes.length && fixes.every((f) => f.call) ? fixes : null;
}

function specOf(inputField) {
  if (!inputField) return null;
  const spec = { required: inputField.required, type: inputField.type };
  for (const key of SPEC_KEYS) if (inputField.constraints?.[key] !== undefined) spec[key] = inputField.constraints[key];
  return spec;
}

// ---------------------------------------------------------------- public

/**
 * Forms of a component. `analysis` is the component analysis (sf, cls, template scan), `stores` the component's
 * stores with their lineage ([{ property, store, lineage }]), `selected` the selection item.
 */
export function analyseForms({ analysis, file, stores, selected }) {
  const { sf, cls, template: scan } = analysis;
  if (!cls) return [];
  const storeProperties = new Map(stores.filter((s) => s.property).map((s) => [s.property, s]));
  const selectedElement = scan && selected ? locateElement(scan, selected) : null;

  return formDefinitions(sf, cls).map((form) => {
    const { formElement, elements } = linkTemplate(scan, form);

    let submit = null;
    let write = null;
    let keys = new Map();
    for (const call of storeCalls(sf, cls, submitHandlers(sf, cls, form, formElement, scan), storeProperties)) {
      const detail = storeProperties.get(call.property);
      write =
        detail.lineage.writes.find((w) => w.storeMethod === call.method && w.requestType) ??
        detail.lineage.writes.find((w) => w.storeMethod === call.method);
      if (!write) continue;
      submit = {
        store: detail.lineage.name,
        method: call.method,
        operation: write.operation,
        http: write.http,
        requestType: write.requestType,
        mapper: write.mapper && { name: write.mapper.name, file: write.mapper.file, line: write.mapper.line },
        line: lineOf(sf, call.node),
      };
      keys = draftKeys(sf, call, form);
      break;
    }
    const schema = write?.mapper?.dtoType ?? write?.requestType ?? null;
    const detail = submit && [...storeProperties.values()].find((s) => s.lineage.name === submit.store);
    const inputFields = (detail?.lineage.inputFields ?? []).filter((f) => f.schema === schema);

    const controls = form.controls.map((c) => {
      const element = elements.get(c.name) ?? null;
      const validators = [...c.validators, ...(form.kind === 'reactive' ? templateValidators(element) : [])];
      const draftKey = submit ? (keys.get(c.name) ?? null) : null;
      let apiField = null;
      let conversion = null;
      if (draftKey && write?.mapper) {
        const mapped =
          write.mapper.fields.find((f) => f.source.includes(draftKey)) ??
          write.mapper.fields.find((f) => f.source.some((s) => s.startsWith(`${draftKey}.`)));
        apiField = mapped?.dto ?? null;
        conversion = mapped?.conversion ?? null;
      } else if (draftKey && inputFields.some((f) => f.path === draftKey)) apiField = draftKey;
      const control = {
        name: c.name,
        line: c.line,
        templateLine: element?.line ?? null,
        ...(c.array && { array: true }),
        validators,
        draftField: draftKey,
        apiField,
        conversion,
        spec: specOf(inputFields.find((f) => f.path === apiField)),
        status: 'unmapped',
        issues: [],
        selected: Boolean(selectedElement && element === selectedElement),
      };
      if (!apiField) {
        control.issues.push(
          !submit
            ? 'not sent to an API: the submit handler calls no store write'
            : draftKey
              ? `${write?.mapper?.name ?? 'the store'} does not write ${draftKey} to the request`
              : 'not passed to the store call',
        );
      } else if (control.spec) {
        const { levels, ...result } = compare({ ...control, validators }, control.spec, element, scan);
        Object.assign(control, result);
        issueLevels.set(control, levels);
      } else control.status = 'ok';
      const fixes = !c.array && specFixes(form, c.name, control.spec);
      if (fixes) control.fixes = fixes;
      return control;
    });

    // request fields no control writes: required ones block the request, optional ones are possible additions
    const written = new Set(controls.map((c) => c.apiField).filter(Boolean));
    const constant = new Set((write?.mapper?.fields ?? []).filter((f) => !f.source.length).map((f) => f.dto));
    for (const f of inputFields) {
      if (
        f.object ||
        written.has(f.path) ||
        constant.has(f.path) ||
        [...written].some((w) => w.startsWith(`${f.path}.`) || f.path.startsWith(`${w}.`))
      )
        continue;
      controls.push({
        name: null,
        line: null,
        templateLine: null,
        validators: [],
        draftField: null,
        apiField: f.path,
        conversion: null,
        spec: specOf(f),
        status: 'missing-control',
        issues: [
          f.required
            ? `${f.path} is required by ${schema} but no control writes it`
            : `${f.path} (optional in ${schema}) has no control${f.mapped ? '' : ` and is not set by ${write?.mapper?.name ?? 'the mapper'}`}`,
        ],
        selected: false,
      });
    }
    return {
      name: form.name,
      kind: form.kind,
      file,
      line: form.line,
      templateFile: scan?.file ?? null,
      templateLine: formElement?.line ?? null,
      ...(form.model && { model: form.model }),
      submit,
      controls,
    };
  });
}
