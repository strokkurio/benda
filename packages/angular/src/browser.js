// Angular adapter for the Benda overlay. The bridge serves this file as /adapter.js; it is never part of the app
// bundle. Component info comes from Angular's debug API (`window.ng`), which only exists in dev mode.

function safe(fn) {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

const ng = () => window.ng;

// Guarded: proxies such as signal forms' field trees may throw on own-key lookups.
function isSignal(value) {
  return (
    typeof value === 'function' &&
    safe(() => Object.getOwnPropertySymbols(value).some((s) => s.description === 'SIGNAL')) === true
  );
}

function preview(value) {
  const unwrapped = isSignal(value) ? safe(value) : value;
  if (typeof unwrapped === 'function') return 'ƒ';
  const json = safe(() => JSON.stringify(unwrapped)) ?? String(unwrapped);
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}

const className = (instance) => instance?.constructor?.name?.replace(/^_+/, '') || 'Unknown';

// Input name → class property; metadata lists inputs either as a plain property name or as { classPropertyName }.
function inputProps(instance) {
  const meta = safe(() => ng().getDirectiveMetadata(instance));
  const props = [];
  for (const [key, value] of Object.entries(meta?.inputs ?? {})) {
    const prop = [key, typeof value === 'string' ? value : value?.classPropertyName].find((p) => p && p in instance);
    if (prop) props.push([key, prop]);
  }
  return props;
}

function componentInfo(instance, hostEl) {
  if (!instance) return null;
  const inputs = {};
  for (const [key, prop] of inputProps(instance)) inputs[key] = preview(instance[prop]);
  return {
    name: className(instance),
    selector: hostEl?.tagName?.toLowerCase() ?? '',
    inputs,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Live state for the Data tab: forms, stores and the model object an element renders. Everything is read-only:
// signals are read, getters on controls are read, but no method with side effects is called.

const LIMITS = { depth: 4, items: 50, string: 500, nodes: 2000, components: 10 };

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isObject = (value) => value !== null && typeof value === 'object';
const isPlainObject = (value) =>
  isObject(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Array.isArray(value);
const read = (sig) => safe(() => sig());

// Serialises any value into something JSON-safe and bounded, so it can travel to the bridge as is.
function serialize(value) {
  let budget = LIMITS.nodes;
  const path = new WeakSet();
  const walk = (v, depth, unwrapped) => {
    if (budget-- <= 0) return '…';
    if (isSignal(v)) return unwrapped ? 'ƒ' : walk(read(v), depth, true);
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    if (typeof v === 'string') return clip(v, LIMITS.string);
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v !== 'object') return typeof v === 'function' ? 'ƒ' : String(v);
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof Error) return { name: v.name, message: clip(String(v.message), LIMITS.string) };
    if (typeof Node !== 'undefined' && v instanceof Node) return `<${v.nodeName.toLowerCase()}>`;
    if (safe(() => typeof v.then === 'function')) return '[Promise]';
    if (safe(() => typeof v.subscribe === 'function')) return '[Observable]';
    if (path.has(v)) return '[Circular]';
    const list = v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : Array.isArray(v) ? v : null;
    if (depth >= LIMITS.depth) return list ? `[… ${list.length}]` : '{…}';
    path.add(v);
    let out;
    if (list) {
      out = list.slice(0, LIMITS.items).map((item) => walk(item, depth + 1, false));
      if (list.length > LIMITS.items) out.push(`… ${list.length - LIMITS.items} more`);
    } else {
      out = {};
      const keys = safe(() => Object.keys(v)) ?? [];
      for (const key of keys.slice(0, LIMITS.items)) {
        const item = safe(() => v[key]);
        out[key] = walk(item, depth + 1, false);
      }
      if (keys.length > LIMITS.items) out['…'] = `${keys.length - LIMITS.items} more`;
    }
    path.delete(v);
    return out;
  };
  return safe(() => walk(value, 0, false));
}

function snapshot(value) {
  const raw = serialize(value);
  return {
    value: clip(safe(() => JSON.stringify(raw)) ?? String(raw), 160),
    raw,
    ...(Array.isArray(value) ? { count: value.length } : {}),
  };
}

// --- Reactive forms (@angular/forms): AbstractControl exposes its state as plain getters.

const isControl = (v) =>
  isObject(v) && typeof v.setValue === 'function' && typeof v.markAsTouched === 'function' && 'status' in v;
const isGroup = (v) => isControl(v) && isObject(v.controls);

function controlErrors(control) {
  const errors = safe(() => control.errors);
  return errors ? serialize(errors) : null;
}

function reactiveState(control) {
  return {
    valid: !!control.valid,
    invalid: !!control.invalid,
    pending: !!control.pending,
    touched: !!control.touched,
    dirty: !!control.dirty,
    disabled: !!control.disabled,
  };
}

function reactiveControl(control, name) {
  return {
    kind: 'reactive',
    name,
    value: serialize(control.value),
    ...reactiveState(control),
    errors: controlErrors(control),
  };
}

function reactiveName(directive, control) {
  const path = safe(() => directive?.path);
  if (Array.isArray(path) && path.length) return path.join('.');
  if (directive?.name != null) return String(directive.name);
  const siblings = safe(() => control.parent.controls);
  return (siblings && Object.keys(siblings).find((key) => siblings[key] === control)) ?? '';
}

function reactiveForm(group, name) {
  const controls = [];
  const invalidControls = [];
  const visit = (node, prefix, depth) => {
    for (const [key, child] of Object.entries(node.controls ?? {})) {
      if (controls.length >= LIMITS.items) return;
      const childName = prefix ? `${prefix}.${key}` : key;
      const errors = controlErrors(child);
      if (isGroup(child) && depth < LIMITS.depth) {
        if (errors) invalidControls.push({ name: childName, errors });
        visit(child, childName, depth + 1);
        continue;
      }
      const state = reactiveState(child);
      controls.push({ name: childName, value: serialize(child.value), ...state, errors });
      if (state.invalid) invalidControls.push({ name: childName, errors });
    }
  };
  visit(group, '', 0);
  return {
    kind: 'reactive',
    name,
    ...reactiveState(group),
    value: serialize(group.value),
    errors: controlErrors(group),
    invalidControls,
    controls,
  };
}

// --- Signal forms (@angular/forms/signals). A field tree is a callable proxy; calling it returns the FieldState,
// whose state is all signals. The FIELD_TREE brand symbol is not exported, so an unknown function is recognised by
// shape before it is called – calling an arbitrary function property could have side effects. Every real function
// has an own `length`; the proxy answers own-property lookups from the model value instead, so it reports none for
// an object model and throws for a primitive one. Array-valued field trees are not recognised this way.

const isFieldState = (v) =>
  isObject(v) && isSignal(v.value) && isSignal(v.errors) && isSignal(v.touched) && isSignal(v.valid);

function fieldStateOf(tree, known = false) {
  if (typeof tree !== 'function' || isSignal(tree)) return null;
  if (!known && safe(() => Object.prototype.hasOwnProperty.call(tree, 'length')) === true) return null;
  const state = safe(() => tree());
  return isFieldState(state) ? state : null;
}

// Signal errors are a list of { kind, message?, ...details }; reactive errors are { kind: details | true }. The Data
// tab and the agent get the reactive shape for both.
function signalErrors(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const errors = {};
  for (const error of list) {
    const details = {};
    for (const [key, value] of Object.entries(error ?? {})) {
      if (!['kind', 'fieldTree', 'formField', '__brand'].includes(key) && value !== undefined) details[key] = value;
    }
    errors[error?.kind ?? 'error'] = Object.keys(details).length ? serialize(details) : true;
  }
  return errors;
}

function signalState(state) {
  return {
    valid: !!read(state.valid),
    invalid: !!read(state.invalid),
    pending: !!read(state.pending),
    touched: !!read(state.touched),
    dirty: !!read(state.dirty),
    disabled: !!read(state.disabled),
  };
}

// `pathKeys` is internal but gives the key path relative to the form; `name()` is public and prefixed with the
// form's generated root name, which is stripped when the root is known.
function signalName(state, root) {
  const keys = safe(() => state.structure.pathKeys());
  if (Array.isArray(keys)) return keys.join('.');
  const name = String(read(state.name) ?? '');
  const rootName = root ? read(root.name) : null;
  return rootName && name.startsWith(`${rootName}.`) ? name.slice(rootName.length + 1) : name;
}

function signalControl(state, root) {
  return {
    kind: 'signal',
    name: signalName(state, root),
    value: serialize(read(state.value)),
    ...signalState(state),
    ...(isSignal(state.required) ? { required: !!read(state.required) } : {}),
    errors: signalErrors(read(state.errors)),
  };
}

// Only already materialised children are listed: asking for unmaterialised ones would write to the form's internal
// signals. Fields bound in a template are always materialised.
const fieldChildren = (state) => safe(() => state.structure.materializedChildren()) ?? [];

function signalForm(root, name) {
  const controls = [];
  const visit = (state, depth) => {
    for (const child of fieldChildren(state)) {
      if (controls.length >= LIMITS.items) return;
      if (!isFieldState(child)) continue;
      const nested = fieldChildren(child).length > 0 && depth < LIMITS.depth;
      if (nested) visit(child, depth + 1);
      else {
        const { kind, ...control } = signalControl(child, root);
        controls.push(control);
      }
    }
  };
  visit(root, 0);
  // errorSummary() is public and covers every field, including ones not materialised above.
  const byField = new Map();
  for (const error of read(root.errorSummary) ?? []) {
    const field = fieldStateOf(error?.fieldTree, true) ?? root;
    if (!byField.has(field)) byField.set(field, []);
    byField.get(field).push(error);
  }
  const invalidControls = [...byField].map(([field, errors]) => ({
    name: signalName(field, root),
    errors: signalErrors(errors),
  }));
  return {
    kind: 'signal',
    name,
    ...signalState(root),
    value: serialize(read(root.value)),
    errors: signalErrors(read(root.errors)),
    invalidControls: invalidControls.slice(0, LIMITS.items),
    controls,
  };
}

// --- Element → control / form

const directivesOf = (node) => safe(() => ng().getDirectives(node)) ?? [];

function ancestors(el) {
  const nodes = [];
  for (let node = el; node && node !== document.documentElement; node = node.parentElement) nodes.push(node);
  return nodes;
}

// The element itself or a custom control component around it; a <label> stands for the control it labels.
function findControl(el) {
  const start = el?.tagName === 'LABEL' && el.control ? el.control : el;
  for (const node of ancestors(start)) {
    if (node.tagName === 'FORM') break;
    for (const d of directivesOf(node)) {
      if (isSignal(d?.state) && isSignal(d?.field)) {
        const state = read(d.state);
        if (isFieldState(state)) return { kind: 'signal', state };
      }
      const control = safe(() => d?.control);
      if (isControl(control) && !isGroup(control)) return { kind: 'reactive', control, directive: d };
    }
  }
  return null;
}

// Nearest form group directive around el: FormGroupDirective / NgForm (`form`), FormGroupName / FormArrayName
// (`control`), or signal forms' FormRoot (`fieldTree` input).
function findFormDirective(el) {
  for (const node of ancestors(el)) {
    for (const d of directivesOf(node)) {
      const group = [safe(() => d?.form), safe(() => d?.control)].find(isGroup);
      if (group) return { kind: 'reactive', group, directive: d };
      const state = isSignal(d?.fieldTree) ? fieldStateOf(read(d.fieldTree), true) : null;
      if (state) return { kind: 'signal', state };
    }
  }
  return null;
}

function components(el) {
  const list = [];
  const add = (instance) => instance && !list.includes(instance) && list.push(instance);
  add(safe(() => ng().getComponent(el)));
  const owner = safe(() => ng().getOwningComponent(el));
  add(owner);
  const host = safe(() => ng().getHostElement(owner));
  for (let node = host?.parentElement; node && list.length < LIMITS.components; node = node.parentElement) {
    add(safe(() => ng().getComponent(node)));
  }
  return list;
}

// Own enumerable properties: TypeScript `private` fields are ordinary properties, ES `#private` ones stay hidden.
const ownEntries = (instance) =>
  (safe(() => Object.keys(instance)) ?? []).map((key) => [key, safe(() => instance[key])]);

function inspectForms(el, owner) {
  const found = findControl(el);
  let control = null;
  let root = null;
  if (found?.kind === 'reactive') {
    control = reactiveControl(found.control, reactiveName(found.directive, found.control));
  }
  const formDirective = findFormDirective(el);
  const ownerForms = owner
    ? ownEntries(owner)
        .map(([property, value]) => ({ property, group: isGroup(value) ? value : null, state: fieldStateOf(value) }))
        .filter((entry) => entry.group || entry.state)
    : [];

  if (found?.kind === 'signal') {
    root = formDirective?.kind === 'signal' ? formDirective.state : safe(() => found.state.structure.root);
    if (!isFieldState(root)) {
      const name = String(read(found.state.name) ?? '');
      root = ownerForms.find((f) => f.state && name.startsWith(`${read(f.state.name)}.`))?.state ?? null;
    }
    control = signalControl(found.state, root);
  }

  const signalRoot = found?.kind === 'signal' ? root : formDirective?.kind === 'signal' ? formDirective.state : null;
  const group =
    formDirective?.kind === 'reactive'
      ? formDirective.group
      : found?.kind === 'reactive'
        ? safe(() => found.control.parent)
        : null;
  let form = null;
  if (signalRoot) {
    form = signalForm(signalRoot, ownerForms.find((f) => f.state === signalRoot)?.property ?? '');
  } else if (isGroup(group)) {
    const name = ownerForms.find((f) => f.group === group)?.property ?? formDirective?.directive?.name ?? '';
    form = reactiveForm(group, String(name));
  } else if (ownerForms.length && !found) {
    const { property, group: ownerGroup, state } = ownerForms[0];
    form = ownerGroup ? reactiveForm(ownerGroup, property) : signalForm(state, property);
  }
  return { control, form };
}

// --- Stores: injected objects on the components around el that hold signals (Angular services, NgRx signal stores).

const isResource = (v) =>
  isObject(v) && isSignal(v.value) && isSignal(v.status) && isSignal(v.isLoading) && isSignal(v.error);

function resourceInfo(property, resource) {
  const error = read(resource.error);
  return {
    property,
    status: read(resource.status),
    isLoading: !!read(resource.isLoading),
    error: error == null ? null : clip(String(error?.message ?? error), LIMITS.string),
    // value() throws while the resource is in the error state; safe() turns that into null.
    value: serialize(read(resource.value)),
  };
}

function storeInfo(component, property, store) {
  const signals = [];
  const resources = [];
  for (const [name, value] of ownEntries(store)) {
    if (isResource(value)) resources.push(resourceInfo(name, value));
    else if (isSignal(value)) signals.push({ name, ...snapshot(read(value)) });
  }
  return { name: className(store), property, component: className(component), signals, resources };
}

function looksLikeStore(value) {
  if (!isObject(value) || Array.isArray(value) || isControl(value) || isResource(value)) return false;
  if (typeof Node !== 'undefined' && value instanceof Node) return false;
  const type = typeof value.constructor === 'function' ? value.constructor : {};
  const injectable = ('ɵprov' in type || 'ɵfac' in type) && !('ɵcmp' in type) && !('ɵdir' in type);
  return injectable && ownEntries(value).filter(([, v]) => isSignal(v)).length >= 2;
}

function inspectStores(list, hints) {
  const wanted = new Set((hints?.stores ?? []).map((name) => String(name).replace(/^_+/, '')));
  const seen = new Set();
  const stores = [];
  for (const component of list) {
    for (const [property, value] of ownEntries(component)) {
      if (!isObject(value) || seen.has(value) || value === component) continue;
      const hinted = wanted.has(className(value));
      if (!hinted && !looksLikeStore(value)) continue;
      seen.add(value);
      stores.push({ hinted, info: storeInfo(component, property, value) });
    }
  }
  return stores.sort((a, b) => b.hinted - a.hinted).map((s) => s.info);
}

// --- Context: the model object the element renders – a component input holding an object (e.g. a row's
// `customer`) or the item of the @for block around it, whichever is closer.

const isModel = (v) =>
  isObject(v) &&
  !Array.isArray(v) &&
  !isControl(v) &&
  !isResource(v) &&
  !(typeof Node !== 'undefined' && v instanceof Node) &&
  (isPlainObject(v) || !ownEntries(v).some(([, value]) => typeof value === 'function'));

// The walk ends at the owner's host, so an object input of some layout component far up is not mistaken for it.
function inspectContext(el, ownerHost) {
  for (const node of ancestors(el)) {
    const component = safe(() => ng().getComponent(node));
    if (component) {
      for (const [input, prop] of inputProps(component)) {
        const raw = component[prop];
        const value = isSignal(raw) ? read(raw) : raw;
        if (isModel(value)) {
          return { kind: 'input', component: className(component), property: input, raw: serialize(value) };
        }
      }
    }
    // @for views carry a RepeaterContext ({ $implicit, $index, $count }); other views carry the component itself.
    const context = safe(() => ng().getContext(node));
    const item = isObject(context) && typeof context.$index === 'number' ? context.$implicit : undefined;
    if (isModel(item)) {
      return { kind: 'for', property: '$implicit', index: context.$index, raw: serialize(item) };
    }
    if (node === ownerHost) break;
  }
  return null;
}

export default {
  name: 'angular',
  hiddenAttributes: /^(_ngcontent|_nghost|ng-reflect|ng-version)/,
  hiddenClasses: /^ng-/,

  owner(el) {
    const owner = safe(() => ng().getOwningComponent(el));
    return owner ? componentInfo(owner, safe(() => ng().getHostElement(owner))) : null;
  },

  component(el) {
    return componentInfo(safe(() => ng().getComponent(el)), el);
  },

  componentChain(el) {
    const chain = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      if (safe(() => ng().getComponent(node))) chain.unshift(node.tagName.toLowerCase());
    }
    return chain;
  },

  // AG Grid puts the column on the cell and the header cell only; a click lands on the text span inside
  field(el) {
    return el.closest('[col-id]')?.getAttribute('col-id') ?? null;
  },

  componentHost(el) {
    const owner = safe(() => ng().getOwningComponent(el));
    return safe(() => ng().getHostElement(owner)) ?? el;
  },

  // Optional contract member: live form, store and model state around el, JSON-safe (see dom-adapter.js).
  inspect(el, hints) {
    if (!window.ng || !el) return null;
    const owner = safe(() => ng().getOwningComponent(el));
    // Each part on its own, so one unexpected shape does not hide the others.
    const { control = null, form = null } = safe(() => inspectForms(el, owner)) ?? {};
    const stores = safe(() => inspectStores(components(el), hints)) ?? [];
    const ownerHost = safe(() => ng().getHostElement(owner));
    const context = safe(() => inspectContext(el, ownerHost));
    return control || form || stores.length || context ? { control, form, stores, context } : null;
  },

  warning() {
    return window.ng ? null : 'Angular debug API (window.ng) not found – component info is unavailable. Is the app running in dev mode?';
  },
};
