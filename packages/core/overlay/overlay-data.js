// Data tab of the Benda overlay: shows where the selected element's data comes from
// (component → store → API operation → mapper → field mapping), how it is written back (write mapper, request
// fields) and how forms compare with the API spec, and turns all of it into agent tasks. Unbound elements get an
// AI-proposed mapping, write operations an AI-proposed form; the user edits either before it is implemented.
// Loaded lazily by overlay.js the first time the Data tab is opened.
import { proposalSteps } from './ui.js';

export const DATA_STYLES = `
  .data { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding: 10px 12px; gap: 10px; }
  .chains { display: flex; flex-direction: column; gap: 4px; }
  .chain { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 12px; }
  .chain span.node { border: 1px solid #e4e4e7; border-radius: 6px; padding: 2px 7px; background: #fafafa; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .chain span.node.view { border-style: dashed; background: #fff; color: #52525b; }
  .chain i { color: #a1a1aa; font-style: normal; }
  .chain .branch { padding-left: 10px; }
  .map { width: 100%; border-collapse: collapse; font-size: 12px; }
  .map th { text-align: left; font-weight: 600; color: #71717a; padding: 4px 6px; border-bottom: 1px solid #e4e4e7; }
  .map td { padding: 4px 6px; border-bottom: 1px solid #f4f4f5; vertical-align: top; }
  .map td code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .map tr.focus td { background: #fef9c3; }
  .map tr.clickable { cursor: pointer; }
  .map tr.clickable:hover td { background: #f4f4f5; }
  .map tr.focus.clickable:hover td { background: #fef08a; }
  .map tr.unmapped td { color: #a1a1aa; }
  .map tr.gap td { background: #fffbeb; }
  .map tr.nested td:nth-child(2) { padding-left: 16px; }
  .map tr.issue td { border-bottom: 1px solid #f4f4f5; padding-top: 0; color: #92400e; font-size: 11px; }
  .map tr.has-issue td { border-bottom: 0; }
  .map .muted { color: #a1a1aa; }
  .map .sub { color: #71717a; font-size: 11px; }
  .map .warn { color: #b45309; }
  .map input { width: 100%; min-width: 60px; border: 1px solid #d4d4d8; border-radius: 6px; padding: 3px 6px; font: 12px ui-monospace, monospace; }
  .lookup { color: #52525b; }
  .pill { border: 1px solid #c7d2fe; border-radius: 999px; padding: 0 7px; background: #eef2ff; color: #3730a3; font: 600 11px ui-sans-serif, system-ui; cursor: pointer; white-space: nowrap; }
  .pill:hover { background: #e0e7ff; }
  .pill.warn { border-color: #fcd34d; background: #fffbeb; color: #92400e; }
  .pill.warn:hover { background: #fef3c7; }
  .cell-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .writes { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: #52525b; }
  .writes code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #18181b; }
  .section { display: flex; flex-direction: column; gap: 6px; }
  .section-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 12px; }
  .section-head .muted, .section .muted { color: #a1a1aa; }
  button.section-head { border: 0; background: transparent; padding: 2px 0; cursor: pointer; font: inherit; text-align: left; color: inherit; }
  button.section-head:hover strong { text-decoration: underline; }
  .tag { border-radius: 999px; padding: 0 6px; background: #f4f4f5; color: #52525b; font-size: 11px; }
  .vchip { display: inline-block; margin: 0 3px 2px 0; border: 1px solid #e4e4e7; border-radius: 4px; padding: 0 4px; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
  .vchip.template { border-style: dashed; }
  .vchip small { color: #a1a1aa; font: 10px ui-sans-serif, system-ui; margin-left: 3px; }
  .st { font-weight: 600; white-space: nowrap; }
  .st.ok { color: #15803d; }
  .st.missing, .st.differs, .st.required { color: #b45309; }
  .st.extra { color: #4f46e5; }
  .st.unmapped, .st.optional { color: #a1a1aa; }
  .summary { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #52525b; }
  .scroll-x { overflow-x: auto; }
  .map.form-proposal input { min-width: 72px; }
`;

const DISMISSED_KEY = 'benda-proposals-done';
const PROPOSAL_MAX_AGE_MS = 60 * 60 * 1000;

// Form rows whose status is a fixable deviation from the API spec.
const ISSUE = new Set(['missing', 'differs', 'missing-control']);
const STATUS_LABEL = { ok: '✓ ok', missing: '⚠ missing', differs: '≠ differs', extra: 'extra', unmapped: 'unmapped' };
const FIX_LABEL = { missing: '+ Validator', differs: 'Fix', 'missing-control': '+ Control' };
const WRITE_METHODS = new Set(['post', 'put', 'patch']);
const isWrite = (op) => WRITE_METHODS.has(op?.method);
const opLabel = (op) => `${op.method.toUpperCase()} ${op.path}`;

// Spec constraint → validator kind the form uses for it, and how the API states the rule.
const RULES = [
  { key: 'required', kind: 'required', reason: () => 'is required' },
  { key: 'maxLength', kind: 'maxLength', reason: (n) => `allows at most ${n} characters` },
  { key: 'minLength', kind: 'minLength', reason: (n) => `requires at least ${n} characters` },
  { key: 'minimum', kind: 'min', reason: (n) => `must be at least ${n}` },
  { key: 'maximum', kind: 'max', reason: (n) => `must be at most ${n}` },
  { key: 'pattern', kind: 'pattern', reason: (p) => `must match ${p}` },
  { key: 'format', kind: 'email', only: 'email', reason: () => 'must be an email address' },
];

function doneProposals() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function markDone(id) {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...doneProposals(), id].slice(-50)));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------- lineage helpers (pure)

/** All stores of the lineage; older adapters only report the first one at the top level. */
function storesOf(l) {
  if (l?.stores?.length) return l.stores;
  if (!l?.store) return [];
  const operations = l.operations ?? [];
  const writes =
    l.writes ??
    operations
      .filter((o) => o.role === 'write')
      .map((o) => ({
        operation: o.method,
        storeMethod: o.storeMethod ?? null,
        http: o.http,
        requestType: o.requestType ?? null,
        mapper: null,
      }));
  return [
    {
      ...l.store,
      operations,
      mapper: l.mapper,
      mappers: l.mapper ? [l.mapper] : [],
      writes,
      dtoFields: l.dtoFields ?? [],
      inputFields: l.inputFields ?? [],
      spec: l.spec,
    },
  ];
}

const readMappers = (st) => (st.mappers?.length ? st.mappers : st.mapper ? [st.mapper] : []);

function writeMappers(st) {
  const byName = new Map();
  for (const w of st.writes ?? []) if (w.mapper && !byName.has(w.mapper.name)) byName.set(w.mapper.name, w.mapper);
  return [...byName.values()];
}

const inputGaps = (st) => (st.inputFields ?? []).filter((f) => !f.mapped && !f.object);
const requestType = (st) =>
  (st.writes ?? []).find((w) => w.requestType)?.requestType ?? writeMappers(st)[0]?.dtoType ?? null;
const qualified = (type, path) => (type ? `${type}.${path}` : path);
const basename = (file) => file?.split('/').pop() ?? '';

/** The store binding of the selected value: the adapter's own, else the template read of the same field. */
const selectedBinding = (l) =>
  l.binding ?? (l.field ? (l.bindings ?? []).find((b) => b.field === l.field) : null) ?? null;

/** Constraints as short phrases; `enumSep` differs because the context block uses `|` as a column separator. */
function constraintParts(c, { required, type, enumSep = ' | ' } = {}) {
  if (!c) return [];
  const parts = [];
  if (required !== undefined) parts.push(required ? 'required' : 'optional');
  if (c.maxLength != null) parts.push(`maxLength ${c.maxLength}`);
  if (c.minLength != null) parts.push(`minLength ${c.minLength}`);
  if (c.minimum != null) parts.push(`min ${c.minimum}`);
  if (c.maximum != null) parts.push(`max ${c.maximum}`);
  if (c.pattern) parts.push(`pattern ${c.pattern}`);
  if (c.format) parts.push(`format ${c.format}`);
  // generated enum types already name their values ('CustomerState: ACTIVE | INACTIVE')
  if (c.enum?.length && !c.enum.every((v) => type?.includes(String(v)))) parts.push(`enum ${c.enum.join(enumSep)}`);
  return parts;
}

const specParts = (spec, opts) =>
  spec ? constraintParts(spec, { type: spec.type, ...opts, required: !!spec.required }) : [];
const validatorText = (v) => `${v.kind}${v.value != null ? ` ${v.value}` : ''}`;
const stripSlashes = (p) => String(p).replace(/^\/(.*)\/[a-z]*$/, '$1');

function submitPath(form) {
  const s = form.submit;
  if (!s) return 'no API write';
  return [
    `submit → ${s.store}.${s.method}`,
    s.operation ? ` → ${s.operation}${s.http ? ` (${s.http})` : ''}` : '',
    s.mapper ? ` via ${s.mapper.name}` : '',
  ].join('');
}

/** What the form's validators lack or get wrong compared with the spec of the API field. */
function validatorFixes(control) {
  const spec = control.spec;
  if (!spec) return [];
  const fixes = [];
  for (const rule of RULES) {
    const value = spec[rule.key];
    if (value == null || value === false || (rule.only && value !== rule.only)) continue;
    const wanted = rule.key === 'required' || rule.only ? null : value;
    const have = control.validators.filter((v) => v.kind === rule.kind);
    const reason = rule.reason(value);
    if (!have.length) fixes.push({ action: 'add', kind: rule.kind, value: wanted, reason });
    else if (wanted != null) {
      const same = (v) =>
        rule.kind === 'pattern' ? stripSlashes(v.value) === stripSlashes(wanted) : String(v.value) === String(wanted);
      const wrong = have.filter((v) => !same(v));
      if (wrong.length) fixes.push({ action: 'change', kind: rule.kind, value: wanted, from: wrong, reason });
    }
  }
  return fixes;
}

/** The call the adapter wrote for this validator in the form's own API, or null when it wrote none. */
const fixCall = (control, kind) => control.fixes?.find((f) => f.kind === kind)?.call ?? null;
const neutralValidator = (kind, value) => `a ${kind}${value == null ? '' : ` ${value}`} validator`;

// ---------------------------------------------------------------- form proposals (pure)

const CONSTRAINT_KEYS = ['maxLength', 'minLength', 'minimum', 'maximum', 'pattern', 'format', 'enum'];
const pickConstraints = (c) => Object.fromEntries(CONSTRAINT_KEYS.filter((k) => c?.[k] != null).map((k) => [k, c[k]]));
// the spec detail renders enums as a type string: '"SMB" | "MID_MARKET"'
const enumValues = (type) =>
  /^"[^"]*"( \| "[^"]*")*$/.test(type ?? '') ? [...type.matchAll(/"([^"]*)"/g)].map((m) => m[1]) : null;

/** Leaf fields of a schema from the spec detail, nested objects as dotted paths. */
function specFields(detail, typeName, prefix = '', depth = 0) {
  const schema = detail?.schemas?.find((x) => x.name === typeName);
  if (!schema || depth > 3) return [];
  return schema.properties.flatMap((p) => {
    const path = prefix ? `${prefix}.${p.name}` : p.name;
    const ref = detail.schemas.find((x) => x.name === p.type);
    if (ref?.properties.length)
      return specFields(detail, ref.name, path, depth + 1).map((f) => ({ ...f, required: f.required && p.required }));
    const values = enumValues(ref ? ref.type : p.type);
    const format = /\(([\w-]+)\)/.exec(p.type)?.[1];
    return [
      {
        path,
        type: p.type,
        required: !!p.required,
        ...(values ? { enum: values } : {}),
        ...(format ? { format } : {}),
        ...pickConstraints(p.constraints ?? p),
      },
    ];
  });
}

const fieldValidators = (h) =>
  RULES.filter((r) => h[r.key] != null && h[r.key] !== false && (!r.only || h[r.key] === r.only))
    .map((r) => (r.key === 'required' || r.only ? r.kind : `${r.kind} ${h[r.key]}`))
    .join(', ');

function fieldWidget(h) {
  if (h.enum?.length) return 'select';
  if (/boolean/.test(h.type)) return 'checkbox';
  if (/integer|number/.test(h.type)) return 'number';
  return { email: 'email', date: 'date', 'date-time': 'datetime-local' }[h.format] ?? 'text';
}

const enumLabel = (v) => {
  const text = String(v).replace(/[_-]+/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const fieldOptions = (h) => (h.enum?.length ? h.enum.map((v) => `${v}=${enumLabel(v)}`).join(', ') : '');
// a | (an Angular pipe like `date | short`) or a line break would break the Markdown table row
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ---------------------------------------------------------------- view

export function createDataView({ el, bridge, request, showToast, agentPicker, sendTask, sendLabel, live = null }) {
  const s = {
    key: null, // path of the analysed element
    item: null,
    lineage: null,
    loading: false,
    error: null,
    draft: '',
    specs: null,
    spec: null, // detail of the spec chosen for binding
    operation: '',
    formOperation: '', // write operation a form without API write is bound to
    proposal: null,
    proposalRows: null, // editable copy
    proposalSpec: null, // spec detail the proposal refers to
    proposalFilled: 0, // rows whose empty validators/options/widget came from the spec
    waitingSince: null,
    waitingFor: null, // where the proposal was requested: 'binding' or 'form:<name>'
    open: {}, // store name → expanded, when the component uses several stores
  };
  let root = null;
  let textarea = null;

  async function getJson(path) {
    const res = await fetch(`${bridge}${path}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function analyse(item, key) {
    Object.assign(s, { key, item, loading: true, error: null, lineage: null, draft: '', open: {} });
    redraw();
    try {
      const lineage = await request('/lineage', { item });
      if (s.key !== key) return; // another element was selected meanwhile
      s.lineage = lineage;
      if (!lineage.store) await loadSpecs();
      // the form binder is optional: without specs the store's lineage still shows
      else if (unboundForms().length) await loadSpecs().catch((err) => console.warn('[benda] specs:', err));
    } catch (err) {
      if (s.key !== key) return;
      s.error = err.message;
    }
    if (s.key !== key) return;
    s.loading = false;
    redraw();
  }

  async function loadSpecs() {
    const { specs } = await getJson('/specs');
    s.specs = specs.filter((spec) => !spec.error);
    const preferred = s.specs.find((spec) => spec.generators.length) ?? s.specs.at(-1);
    if (preferred) await chooseSpec(preferred.file);
  }

  async function chooseSpec(file) {
    s.spec = await getJson(`/specs/detail?file=${encodeURIComponent(file)}`);
    s.operation = s.spec.operations.find((o) => o.method === 'get')?.operationId ?? '';
    s.formOperation = s.spec.operations.find((o) => isWrite(o) && o.operationId)?.operationId ?? '';
    redraw();
  }

  const unboundForms = () => (s.lineage?.forms ?? []).filter((f) => !f.submit);
  const operationOf = (detail, id) => detail?.operations.find((o) => o.operationId === id) ?? null;

  /** API path → constraints of the operation's request body; the adapter's input fields carry more than the spec detail. */
  function requestHints(detail, op) {
    const hints = new Map(specFields(detail, op?.requestBody).map((f) => [f.path, f]));
    for (const st of storesOf(s.lineage)) {
      if (!(st.writes ?? []).some((w) => w.operation === op?.operationId)) continue;
      for (const f of st.inputFields ?? []) {
        if (f.object) continue;
        hints.set(f.path, {
          ...hints.get(f.path),
          path: f.path,
          type: f.type,
          required: !!f.required,
          ...pickConstraints(f.constraints),
        });
      }
    }
    return hints;
  }

  /** Fills what the agent left empty from the spec, so the user reviews the API's rules instead of typing them. */
  async function fillFromSpec(p) {
    try {
      const detail =
        !p.spec || p.spec === s.spec?.file ? s.spec : await getJson(`/specs/detail?file=${encodeURIComponent(p.spec)}`);
      if (s.proposal?.id !== p.id) return;
      s.proposalSpec = detail;
      const op = operationOf(detail, p.operation);
      const hints = requestHints(detail, op);
      const prefix = op?.requestBody ? `${op.requestBody}.` : null;
      let filled = 0;
      for (const row of s.proposalRows) {
        const dto = row.dto.trim();
        const h = hints.get(prefix && dto.startsWith(prefix) ? dto.slice(prefix.length) : dto);
        if (!h) continue;
        const before = `${row.widget}|${row.validators}|${row.options}`;
        if (!row.validators.trim()) row.validators = fieldValidators(h);
        if (!row.options.trim()) row.options = fieldOptions(h);
        if (!row.widget.trim()) row.widget = fieldWidget(h);
        if (before !== `${row.widget}|${row.validators}|${row.options}`) filled++;
      }
      s.proposalFilled = filled;
      redraw();
    } catch (err) {
      console.warn('[benda] spec constraints for the form proposal:', err);
    }
  }

  // ---------------------------------------------------------------- task texts

  const component = () => s.lineage?.component;
  const componentRef = () => (component() ? `${component().name} (${component().file})` : 'the selected element');

  /** The component a form is declared in: the selected element's own one when the data comes from outside. */
  function formRef(form) {
    const l = s.lineage;
    const owner = [l?.view, l?.component].find((c) => c?.file === form.file);
    return `form "${form.name}" in ${owner ? `${owner.name} ` : ''}(${form.file}:${form.line})`;
  }

  function storeContext(l, st, first) {
    const reads = st.operations.filter((o) => o.role === 'read');
    const writes = st.operations.filter((o) => o.role === 'write');
    const shown = (model) => (l.shown ?? []).find((c) => c.field === model || c.field.endsWith(`.${model}`));
    const mappers = readMappers(st);
    const rows = mappers.flatMap((m) =>
      m.fields.map((f) => {
        const ui = shown(f.model);
        return `- ${f.model} ← ${f.source.join(', ') || '—'}${f.conversion ? ` | ${f.conversion}` : ''}${ui ? ` | shown as "${ui.label}"` : ''}`;
      }),
    );
    const unmapped = (st.dtoFields ?? []).filter((f) => !f.mapped && !f.object).map((f) => `${f.path} (${f.type})`);
    const wms = writeMappers(st);
    const gaps = inputGaps(st);
    const gapText = (f) =>
      `${f.path} (${f.type}${constraintParts(f.constraints, { type: f.type, enumSep: ', ' })
        .map((p) => `, ${p}`)
        .join('')})`;
    const required = gaps.filter((f) => f.required).map(gapText);
    const optional = gaps.filter((f) => !f.required).map(gapText);
    const spec = st.spec ?? (first ? l.spec : null);
    return [
      `- Store: ${st.name} (${st.file}) – reads: ${reads.map((o) => `${o.method} (${o.http ?? '?'})`).join(', ') || '—'}; writes: ${writes.map((o) => `${o.method} (${o.http ?? '?'})`).join(', ') || '—'}`,
      ...mappers.map((m) => `- Mapper: ${m.name} (${m.file}:${m.line}), API ${m.dtoType} → model ${m.modelType}`),
      ...wms.map(
        (m) => `- Write mapper: ${m.name} (${m.file}:${m.line}), draft ${m.draftType ?? '?'} → API ${m.dtoType}`,
      ),
      ...(spec && (first || spec.file !== l.spec?.file)
        ? [`- Spec: ${spec.title} ${spec.version} (${spec.file})`]
        : []),
      ...(first
        ? ['Mapping (model ← API field | conversion | UI):']
        : rows.length
          ? [`Mapping of ${st.name} (model ← API field | conversion | UI):`]
          : []),
      ...rows,
      ...(unmapped.length ? [`Unmapped API fields: ${unmapped.join(', ')}`] : []),
      ...(st.writes?.length
        ? [
            'Writes (store method → operation | write mapper):',
            ...st.writes.map(
              (w) =>
                `- ${w.storeMethod ? `${w.storeMethod} → ` : ''}${w.operation} (${w.http ?? '?'}) | ${w.mapper?.name ?? '—'}`,
            ),
          ]
        : []),
      ...wms.flatMap((m) => [
        `Write mapping of ${m.name} (API field ← draft field | conversion):`,
        ...m.fields.map((f) => `- ${f.dto} ← ${f.source.join(', ') || '—'}${f.conversion ? ` | ${f.conversion}` : ''}`),
      ]),
      ...(required.length ? [`Required input fields not written: ${required.join(', ')}`] : []),
      ...(optional.length ? [`Optional input fields not written: ${optional.join(', ')}`] : []),
    ];
  }

  function formContext(form) {
    const head = `Form "${form.name}" (${form.kind}, ${form.file}:${form.line}): ${submitPath(form)}`;
    if (!form.submit)
      return [
        `${head} – controls: ${
          form.controls
            .map((c) => c.name)
            .filter(Boolean)
            .join(', ') || '—'
        }`,
      ];
    const rows = form.controls.filter((c) => c.status !== 'ok' && (c.issues.length || ISSUE.has(c.status)));
    if (!rows.length) return [head, `Form check: all ${form.controls.length} controls match the API`];
    return [
      head,
      'Form check (control → API field: status – issues | validators | API constraints):',
      ...rows.map((c) => {
        const validators = c.validators.map((v) => `${validatorText(v)} (${v.source})`).join(', ') || '—';
        const api = specParts(c.spec, { type: null, enumSep: ', ' }).join(', ') || '—';
        return `- ${c.name ?? '(no control)'} → ${c.apiField ?? '—'}: ${c.status}${c.issues.length ? ` – ${c.issues.join('; ')}` : ''} | validators: ${validators} | API: ${api}${c.selected ? ' (selected)' : ''}`;
      }),
    ];
  }

  function lineageContext() {
    const l = s.lineage;
    const liveText = (live && l && safe(() => live.contextText(l))) || '';
    const stores = storesOf(l);
    const forms = l?.forms ?? [];
    if (!stores.length && !forms.length) return liveText;
    const binding = selectedBinding(l);
    const lines = [
      '',
      'Data lineage of the selection (from Benda):',
      `- Component: ${componentRef()}`,
      ...(l.view
        ? [
            `- View: ${l.view.name} (${l.view.file}), data from ${l.component?.name ?? 'outside'}${l.view.inputs?.length ? ` via inputs: ${l.view.inputs.join(', ')}` : ''}`,
          ]
        : []),
      ...(l.field || binding
        ? [
            `- Selected value: field "${l.field ?? binding.field}"${binding?.store ? ` via ${binding.store}.${binding.storeSignal} (${binding.file ? `${binding.file}:${binding.line}` : `template line ${binding.line}`})` : ''}`,
          ]
        : []),
      ...(l.control ? [`- Selected control: "${l.control.name}" of form "${l.control.form}"`] : []),
      ...stores.flatMap((st, i) => storeContext(l, st, i === 0)),
      ...forms.flatMap(formContext),
      'Follow the data-layer rules in AGENTS.md: change model, mapper and its unit test together; components only use the store.',
      ...(forms.length
        ? ['Form validators come from the API spec schema (required, maxLength, minLength, pattern, format).']
        : []),
    ];
    return [lines.join('\n'), liveText].filter(Boolean).join('\n');
  }

  function safe(fn) {
    try {
      return fn();
    } catch (err) {
      console.warn('[benda] live data:', err);
      return null;
    }
  }

  function prefill(text) {
    s.draft = text;
    // the plain binding view only shows the composer once there is a draft
    if (!textarea) redraw();
    if (textarea) {
      textarea.value = text;
      textarea.focus();
      textarea.setSelectionRange(text.length, text.length);
    }
  }

  async function send(instruction, context = lineageContext()) {
    if (!instruction.trim()) return;
    await sendTask(instruction.trim(), context);
    s.draft = '';
    redraw();
  }

  function proposeTask() {
    const op = s.spec.operations.find((o) => o.operationId === s.operation);
    const instruction = [
      `Propose a data mapping for ${componentRef()} from the operation ${op.operationId} (${op.method.toUpperCase()} ${op.path}, response ${op.responses.find((r) => r.status.startsWith('2'))?.type ?? '?'}) of ${s.spec.title} ${s.spec.version} (${s.spec.file}).`,
      'Do not change any project files. Look at what the component displays and at the response schema in the spec.',
      ...proposalSteps({
        component: component()?.selector ?? null,
        spec: s.spec.file,
        operation: op.operationId,
        rows: [
          {
            ui: '<label or place in the UI>',
            model: '<UI model field>',
            dto: '<API field path, e.g. totalAmount.value>',
            conversion: '<conversion, or none>',
          },
        ],
        notes: '<assumptions, open questions>',
      }, 'Submit the proposal (one row per value the UI shows)'),
    ].join('\n');
    wait('binding');
    send(instruction, '');
  }

  function wait(where) {
    s.waitingSince = new Date().toISOString();
    s.waitingFor = where;
  }

  const controlText = (c) =>
    `${c.name}${c.validators.length ? ` (${c.validators.map(validatorText).join(', ')})` : ''}`;

  /** Asks for a form that writes `operationId`; with `form`, for binding that existing form instead of a new one. */
  function proposeFormTask(operationId, form, where) {
    const op = operationOf(s.spec, operationId);
    const api = `the operation ${op.operationId} (${opLabel(op)}, request body ${op.requestBody ?? '?'}) of ${s.spec.title} ${s.spec.version} (${s.spec.file})`;
    const controls = form ? form.controls.filter((c) => c.name) : [];
    const instruction = [
      form
        ? `Propose how ${formRef(form)} writes ${api}. The form has no API write yet; its controls: ${controls.map(controlText).join(', ') || '—'}.`
        : `Propose a form for ${componentRef()} that writes ${api}.`,
      'Do not change any project files. Look at the request body schema of the operation in the spec and at the selected component.',
      form
        ? 'Propose one row per control (model = its draft field), plus rows for required request fields no control covers yet.'
        : 'Propose one row per field the user fills in.',
      'Take the validators from the schema (required, maxLength, minLength, min, max, pattern, email) and give enums their options.',
      ...proposalSteps({
        kind: 'form',
        ...(form ? { form: form.name } : {}),
        component: component()?.selector ?? null,
        spec: s.spec.file,
        operation: op.operationId,
        rows: [
          {
            ui: '<label>',
            model: '<draft field>',
            dto: '<API field path in the request body, e.g. address.city>',
            conversion: '<conversion, or none>',
            widget: '<text|textarea|number|select|checkbox|date|email|…>',
            validators: '<e.g. required, maxLength 120>',
            options: '<for enums: VALUE=Label, VALUE=Label; else empty>',
          },
        ],
        notes: '<assumptions, open questions>',
      }),
    ].join('\n');
    wait(where);
    send(instruction, '');
  }

  /** "the operation createCustomer (POST /customers, request body CustomerInput)" when the spec detail knows it. */
  function proposalOperation(p) {
    const op = operationOf(s.proposalSpec ?? s.spec, p.operation);
    return op ? `${op.operationId} (${opLabel(op)}, request body ${op.requestBody ?? '?'})` : (p.operation ?? '?');
  }

  function implementFormTask() {
    const p = s.proposal;
    const rows = s.proposalRows.filter((r) => r.model.trim());
    const op = operationOf(s.proposalSpec ?? s.spec, p.operation);
    const form = p.form ? (s.lineage?.forms ?? []).find((f) => f.name === p.form) : null;
    const write = storesOf(s.lineage)
      .flatMap((st) => (st.writes ?? []).map((w) => ({ ...w, store: st })))
      .find((w) => w.operation === p.operation);
    const mapperName = /^[A-Za-z_$][\w$]*$/.test(op?.requestBody ?? '') ? `to${op.requestBody}` : 'a write mapper';
    const mapper = write?.mapper
      ? `extend the write mapper ${write.mapper.name} (${write.mapper.file}:${write.mapper.line}) and its unit tests`
      : `write the mapper ${mapperName}(draft) from the draft to the request body, with unit tests`;
    const draft = write?.mapper?.draftType
      ? `add the fields to the draft type ${write.mapper.draftType}`
      : 'add a Draft type to the UI model';
    const mutation = write?.storeMethod
      ? `submit through the store mutation ${write.store.name}.${write.storeMethod} (${write.store.file})`
      : 'add a store mutation over the generated client that waits for the server on creates and complex updates (optimistic with rollback only for toggles)';
    const instruction = [
      form || p.form
        ? `Bind ${form ? formRef(form) : `form "${p.form}" of ${componentRef()}`} to the API: on submit it writes through the store. Keep its controls and add or change controls and validators as in this confirmed table.`
        : `Implement this confirmed form in ${componentRef()}, or in a new component if the selection is only a placeholder; extend a form that already exists there instead of adding a second one.`,
      `API: ${p.spec ?? s.spec?.file}, operation ${proposalOperation(p)} via the generated client.`,
      '| Label | Draft field | API field | Conversion | Widget | Validators | Options |',
      '|---|---|---|---|---|---|---|',
      ...rows.map(
        (r) => `| ${[r.ui, r.model, r.dto, r.conversion, r.widget, r.validators, r.options].map(cell).join(' | ')} |`,
      ),
      `Follow the data-layer rules in AGENTS.md: ${draft}, ${mapper}, ${mutation}; give the form the validators from the table (a select for every row with options) and show the store's user-facing error message in it.`,
      'Run the mapper tests and `npx benda check`.',
    ].join('\n');
    markDone(p.id);
    s.proposal = null;
    s.proposalRows = null;
    send(instruction, '');
  }

  function implementTask() {
    const p = s.proposal;
    if (p.kind === 'form') return implementFormTask();
    const rows = s.proposalRows.filter((r) => r.model.trim());
    const instruction = [
      `Implement this confirmed data mapping for ${componentRef()}:`,
      `API: ${p.spec ?? s.spec?.file}, operation ${p.operation} via the generated client.`,
      '| UI | Model | API field | Conversion |',
      '|---|---|---|---|',
      ...rows.map((r) => `| ${[r.ui, r.model, r.dto, r.conversion].map(cell).join(' | ')} |`),
      'Follow the data-layer rules in AGENTS.md: UI model, mapper with unit tests, a store over the generated client, and use the store in the component. Run the mapper tests.',
    ].join('\n');
    markDone(p.id);
    s.proposal = null;
    s.proposalRows = null;
    send(instruction, '');
  }

  function mapOnWriteTask(st, field) {
    const mapper = writeMappers(st)[0];
    const constraints = constraintParts(field.constraints, { type: field.type })
      .map((p) => `, ${p}`)
      .join('');
    const target = qualified(requestType(st), field.path);
    const how = mapper
      ? `add the field to the draft type ${mapper.draftType ?? 'of the UI model'} and write it in ${mapper.name} (${mapper.file}:${mapper.line}).`
      : `add the field to the UI model's draft type and write it in a write mapper used by ${st.name} (${st.file}).`;
    return [
      `Map the API field "${target}" (${field.type}, ${field.required ? 'required' : 'optional'}${constraints}) on write: ${how}`,
      'Follow the data-layer rules in AGENTS.md: change model, mapper and its unit test together; components only use the store.',
    ].join('\n');
  }

  /** One concrete instruction for a form row that deviates from the API, or null if it does not. */
  function formFixTask(form, c) {
    const where = formRef(form);
    const api = qualified(form.submit?.requestType, c.apiField ?? '?');
    if (c.status === 'missing-control') {
      const spec = c.spec ? ` (${[c.spec.type, ...specParts(c.spec)].filter(Boolean).join(', ')})` : '';
      const mapper = form.submit?.mapper;
      return [
        `Add a control for the API field ${api}${spec} to ${where}:`,
        `add the field to the draft type, ${mapper ? `write it in ${mapper.name} (${mapper.file}:${mapper.line})` : 'write it in the write mapper'},`,
        `add the control with the validators the spec requires and an input in the template${c.spec?.enum?.length ? ` (a select with ${c.spec.enum.join(', ')})` : ''}.`,
      ].join(' ');
    }
    if (!ISSUE.has(c.status)) return null;
    const fixes = validatorFixes(c);
    const target = `control "${c.name}" of ${where}`;
    if (!fixes.length)
      return `Fix the validation of ${target} to match the API field ${api}: ${c.issues.join('; ') || c.status}.`;
    const added = fixes.filter((f) => f.action === 'add');
    const calls = added.map((f) => fixCall(c, f.kind));
    const adds = calls.every(Boolean)
      ? `the ${calls.length === 1 ? 'validator' : 'validators'} ${calls.join(' and ')}`
      : added.map((f) => neutralValidator(f.kind, f.value)).join(' and ');
    const changes = fixes
      .filter((f) => f.action === 'change')
      .map((f) => {
        const from = f.from
          .map((v) => `${v.value} (${v.source === 'template' ? 'template' : 'code'}, line ${v.line})`)
          .join(' and ');
        return `${f.kind} validator from ${from} to ${fixCall(c, f.kind) ?? f.value}`;
      });
    const reasons = fixes.map((f) => f.reason).join(' and ');
    const action = added.length
      ? `Add ${adds} to ${target}${changes.length ? ` and change its ${changes.join(' and its ')}` : ''}`
      : `In ${target}, change the ${changes.join(' and the ')}`;
    return `${action}: the API field ${api} ${reasons}.`;
  }

  function fixAllTask(form) {
    const tasks = form.controls.map((c) => formFixTask(form, c)).filter(Boolean);
    return [
      `Align the validation of ${formRef(form)} with the API${form.submit?.requestType ? ` (${form.submit.requestType} of ${form.submit.operation})` : ''}:`,
      ...tasks.map((t) => `- ${t}`),
      'Keep template attributes and validators in code consistent.',
    ].join('\n');
  }

  // ---------------------------------------------------------------- rendering

  const code = (text) => el('code', { text });
  const muted = (text, title = '') => el('span', { class: 'muted', text, title });
  const pill = (text, title, onclick, extra = '') =>
    el('button', {
      class: `pill${extra ? ` ${extra}` : ''}`,
      title,
      text,
      onclick: (e) => {
        e.stopPropagation();
        onclick();
      },
    });
  const node = (text, title, extra = '') => el('span', { class: `node${extra ? ` ${extra}` : ''}`, title, text });

  function chain(l) {
    const stores = storesOf(l);
    const head = [
      ...(l.view
        ? [
            node(
              l.view.name,
              `${l.view.file} – the selected element's component; its data comes from ${l.component.name}${l.view.inputs?.length ? ` via inputs: ${l.view.inputs.join(', ')}` : ''}`,
              'view',
            ),
          ]
        : []),
      node(l.component.name, l.component.file),
    ];
    const rows = stores.map((st, i) => {
      const nodes = [
        ...(i === 0 ? head : []),
        node(
          st.name,
          `${st.file}${st.property ? ` (property ${st.property})` : ''}${st.signals?.length ? ` – signals: ${st.signals.join(', ')}` : ''}`,
        ),
        ...st.operations
          .filter((o) => o.role === 'read')
          .map((o) =>
            node(
              `${o.http ?? o.method}`,
              `${o.storeMethod ? `${o.storeMethod}: ` : ''}${o.method} → ${o.responseType ?? '?'}`,
            ),
          ),
        ...readMappers(st).map((m) => node(`${m.name}()`, `${m.file}:${m.line}`)),
      ];
      const spec = i === 0 ? (st.spec ?? l.spec) : st.spec?.file !== (stores[0].spec ?? l.spec)?.file ? st.spec : null;
      return el('div', { class: `chain${i ? ' branch' : ''}` }, [
        ...(i ? [el('i', { text: '↳' })] : []),
        ...nodes.flatMap((n, j) => [...(j ? [el('i', { text: '→' })] : []), n]),
        ...(spec
          ? [el('span', { class: 'muted', style: 'margin-left: 4px', text: `· ${spec.title} ${spec.version}` })]
          : []),
      ]);
    });
    return el('div', { class: 'chains' }, rows.length ? rows : [el('div', { class: 'chain' }, head)]);
  }

  function selectionLines(l) {
    const lines = [];
    const binding = selectedBinding(l);
    if (l.field || binding) {
      const via = binding?.store
        ? ` via ${binding.store}.${binding.storeSignal}${binding.column ? `, column “${binding.column}”` : ''}`
        : '';
      lines.push(
        el('div', {
          class: 'meta-line',
          title: binding?.file ? `${binding.file}:${binding.line}` : '',
          text: `Selected value: field “${l.field ?? binding.field}”${via}`,
        }),
      );
    }
    if (l.control)
      lines.push(
        el('div', { class: 'meta-line', text: `Selected control: “${l.control.name}” of form “${l.control.form}”` }),
      );
    return lines;
  }

  function conversionCell(field) {
    if (field.lookup)
      return el('td', { class: 'lookup', title: field.conversion ?? '', text: field.lookup.join(', ') });
    return el('td', {}, [field.conversion ? code(field.conversion) : muted('—')]);
  }

  function writeCell(st, row, several) {
    if (row.writes.length) {
      return el(
        'td',
        {},
        row.writes.map((w) =>
          el('div', { title: `${w.mapper.name} (${w.mapper.file}:${w.line})` }, [
            ...(several ? [muted(`${w.mapper.name}: `)] : []),
            w.conversion ? code(w.conversion) : code(w.source.join(', ') || '—'),
            ...(w.lookup ? [el('div', { class: 'sub lookup', text: w.lookup.join(', ') })] : []),
          ]),
        ),
      );
    }
    if (row.gap) {
      const g = row.gap;
      return el('td', {}, [
        el('div', { class: 'cell-actions' }, [
          el('span', {
            class: g.required ? 'warn' : 'muted',
            text: g.required ? '⚠ required, not written' : 'not written',
          }),
          pill(
            '+ Map on write',
            `Write ${g.path} in the request (${requestType(st) ?? 'request body'})`,
            () => prefill(mapOnWriteTask(st, g)),
            g.required ? 'warn' : '',
          ),
        ]),
      ]);
    }
    return el('td', {}, [muted('—', 'not part of the request body')]);
  }

  /** Read and write side keyed by API field, so a field read as `name` and written as `companyName` is one row. */
  function mappingRows(st) {
    const writeFields = writeMappers(st).flatMap((m) => m.fields.map((f) => ({ ...f, mapper: m })));
    const gaps = inputGaps(st);
    const usedWrites = new Set();
    const usedGaps = new Set();
    const attach = (paths) => {
      const writes = writeFields.filter((w) => paths.includes(w.dto));
      writes.forEach((w) => usedWrites.add(w));
      const gap = gaps.find((g) => paths.includes(g.path)) ?? null;
      if (gap) usedGaps.add(gap);
      return { writes, gap };
    };
    const rows = [
      ...readMappers(st).flatMap((m) =>
        m.fields.map((f) => ({ kind: 'read', field: f, mapper: m, ...attach(f.source) })),
      ),
      ...(st.dtoFields ?? [])
        .filter((f) => !f.mapped && !f.object)
        .map((f) => ({ kind: 'unread', dto: f, ...attach([f.path]) })),
    ];
    rows.push(
      ...writeFields
        .filter((w) => !usedWrites.has(w))
        .map((w) => ({ kind: 'write', api: w.dto, writes: [w], gap: null })),
      ...gaps.filter((g) => !usedGaps.has(g)).map((g) => ({ kind: 'write', api: g.path, writes: [], gap: g })),
    );
    return rows;
  }

  function mappingTable(l, st, isSelectedStore) {
    const showWrite = writeMappers(st).length > 0 || (st.inputFields ?? []).length > 0;
    const several = writeMappers(st).length > 1;
    const shown = (model) => (l.shown ?? []).find((c) => c.field === model || c.field.endsWith(`.${model}`))?.label;
    const view = l.component.name;
    const rows = mappingRows(st).map((row) => {
      const write = showWrite ? [writeCell(st, row, several)] : [];
      const gapClass = row.gap?.required ? ' gap' : '';
      if (row.kind === 'read') {
        const f = row.field;
        const label = shown(f.model);
        const focus = isSelectedStore && f.model === l.field;
        return el(
          'tr',
          {
            class: `clickable${focus ? ' focus' : ''}${f.nested ? ' nested' : ''}${gapClass}`,
            title: `${f.file ?? row.mapper.file}:${f.line}${f.nested ? ` (in ${f.nested})` : ''} – click to change this mapping`,
            onclick: () =>
              prefill(`Change the mapping of "${f.model}" (${label ? `column "${label}"` : 'not shown'}): `),
          },
          [
            el(
              'td',
              {},
              label
                ? [label]
                : [
                    pill('+ Show', `Show ${f.model} in ${view}`, () =>
                      prefill(`Show the model field "${f.model}" in ${view} with the label "${f.model}".`),
                    ),
                  ],
            ),
            el('td', {}, [code(f.model)]),
            el('td', {}, [code(f.source.join(', ') || '—')]),
            conversionCell(f),
            ...write,
          ],
        );
      }
      if (row.kind === 'unread') {
        const f = row.dto;
        return el('tr', { class: `unmapped${gapClass}` }, [
          el('td', {}, [
            pill('+ Map', `Map ${f.path} into the model`, () =>
              prefill(
                `Map the API field "${f.path}" (${f.type}) into the UI model and show it in ${view} with the label "${f.path}".`,
              ),
            ),
          ]),
          el('td', {}, [muted('not mapped')]),
          el('td', {}, [code(f.path)]),
          el('td', { text: f.type }),
          ...write,
        ]);
      }
      return el('tr', { class: row.gap && !row.gap.required ? 'unmapped' : gapClass.trim() }, [
        el('td', {}, []),
        el('td', {}, [muted('not read')]),
        el('td', { title: row.gap ? row.gap.type : '' }, [code(row.api)]),
        el('td', {}, [muted('—')]),
        ...write,
      ]);
    });
    const heads = showWrite
      ? ['UI', 'Model', 'API field', 'Read', 'Write']
      : ['UI', 'Model', 'API field', 'Conversion'];
    return el('table', { class: 'map' }, [
      el('thead', {}, [
        el(
          'tr',
          {},
          heads.map((h) => el('th', { text: h })),
        ),
      ]),
      el('tbody', {}, rows),
    ]);
  }

  function writesList(st) {
    if (!st.writes?.length) return [];
    return [
      el('div', { class: 'writes' }, [
        el('span', { class: 'muted', text: 'Writes' }),
        ...st.writes.map((w) =>
          el('div', { title: `${st.file}:${w.line}` }, [
            ...(w.storeMethod ? [code(w.storeMethod), ' → '] : []),
            code(w.operation),
            ` (${w.http ?? '?'})`,
            ...(w.mapper ? [' via ', code(w.mapper.name)] : w.requestType ? [' ', muted('no write mapper')] : []),
          ]),
        ),
      ]),
    ];
  }

  function storeSection(l, st, i, count) {
    const binding = selectedBinding(l);
    const isSelected = binding?.store ? binding.store === st.name : i === 0;
    const hasRows = readMappers(st).length || (st.dtoFields ?? []).length || (st.inputFields ?? []).length;
    const content = [
      hasRows
        ? mappingTable(l, st, isSelected)
        : el('div', { class: 'meta-line', text: 'No read mapper found for this store.' }),
      ...writesList(st),
    ];
    if (count < 2) return content;
    const open = s.open[st.name] ?? i === 0;
    const gaps = inputGaps(st).filter((f) => f.required).length;
    const head = el(
      'button',
      {
        class: 'section-head',
        'aria-expanded': String(open),
        onclick: () => {
          s.open[st.name] = !open;
          redraw();
        },
      },
      [
        el('span', { text: open ? '▾' : '▸' }),
        el('strong', { text: st.name }),
        muted(basename(st.file), st.file),
        ...(gaps
          ? [
              el('span', {
                class: 'st required',
                text: `⚠ ${gaps} required ${gaps === 1 ? 'field' : 'fields'} not written`,
              }),
            ]
          : []),
      ],
    );
    return [el('div', { class: 'section' }, [head, ...(open ? content : [])])];
  }

  function validatorChips(c) {
    if (!c.validators.length) return [muted('—')];
    return c.validators.map((v) =>
      el(
        'span',
        {
          class: `vchip${v.source === 'template' ? ' template' : ''}`,
          title: `${v.source === 'template' ? 'template attribute' : 'in code'}, line ${v.line}${v.native ? ' (native input constraint)' : ''}${v.when ? `, only when ${v.when}` : ''}`,
        },
        [
          validatorText(v),
          ...(v.source === 'template' ? [el('small', { text: 'tpl' })] : []),
          ...(v.when ? [el('small', { text: 'if' })] : []),
        ],
      ),
    );
  }

  function statusCell(form, c) {
    const optional = c.status === 'missing-control' && !c.spec?.required;
    const label =
      c.status === 'missing-control'
        ? optional
          ? 'no control'
          : '⚠ no control'
        : (STATUS_LABEL[c.status] ?? c.status);
    const cls = c.status === 'missing-control' ? (optional ? 'optional' : 'required') : c.status;
    const fix = FIX_LABEL[c.status];
    return el('td', {}, [
      el('div', { class: 'cell-actions' }, [
        el('span', { class: `st ${cls}`, text: label }),
        ...(fix
          ? [pill(fix, 'Prefill a task that fixes this', () => prefill(formFixTask(form, c)), optional ? '' : 'warn')]
          : []),
      ]),
    ]);
  }

  function formSection(l, form) {
    const selected = (c) => c.selected || (l.control && l.control.form === form.name && l.control.name === c.name);
    const issues = form.controls.filter((c) => ISSUE.has(c.status));
    // without a submit every row repeats "not sent to an API", which the header already says
    const showIssues = !!form.submit;
    const rows = form.controls.flatMap((c) => {
      const issueText = showIssues && c.status !== 'ok' && c.issues.length ? c.issues.join('; ') : '';
      const tr = el(
        'tr',
        {
          class: `clickable${selected(c) ? ' focus' : ''}${issueText ? ' has-issue' : ''}`,
          title: `${c.name ? `${form.templateFile ?? form.file}:${c.templateLine ?? c.line}` : 'no control'}${c.issues.length ? ` – ${c.issues.join('; ')}` : ''}`,
          onclick: () =>
            prefill(
              c.name
                ? `Change control "${c.name}" of ${formRef(form)}: `
                : `Add a control for the API field ${qualified(form.submit?.requestType, c.apiField)} to ${formRef(form)}: `,
            ),
        },
        [
          el('td', {}, [c.name ? code(c.name) : muted('no control')]),
          el('td', {}, validatorChips(c)),
          el(
            'td',
            {},
            c.apiField
              ? [code(c.apiField), ...(c.conversion ? [el('div', { class: 'sub' }, [code(c.conversion)])] : [])]
              : [muted('—')],
          ),
          el(
            'td',
            { title: c.spec?.type ?? '' },
            c.spec ? [specParts(c.spec, { type: null }).join(' · ')] : [muted('—')],
          ),
          statusCell(form, c),
        ],
      );
      return issueText
        ? [
            tr,
            el('tr', { class: `issue${selected(c) ? ' focus' : ''}` }, [el('td', { colspan: '5', text: issueText })]),
          ]
        : [tr];
    });
    const count = issues.length;
    return el('div', { class: 'section' }, [
      el('div', { class: 'section-head' }, [
        el('strong', { text: `Form “${form.name}”` }),
        el('span', { class: 'tag', text: form.kind }),
        muted(`${basename(form.file)}:${form.line}`, `${form.file}:${form.line}`),
      ]),
      el('div', {
        class: 'meta-line',
        text: form.submit
          ? submitPath(form)
          : 'No API write – the submit handler calls no store write, so the controls are not checked against the spec.',
      }),
      ...(form.submit ? [] : formBinder(form)),
      el('table', { class: 'map' }, [
        el('thead', {}, [
          el(
            'tr',
            {},
            ['Control', 'Validators', 'API field', 'Spec', 'Status'].map((h) => el('th', { text: h })),
          ),
        ]),
        el('tbody', {}, rows),
      ]),
      ...(form.submit
        ? [
            el('div', { class: 'summary' }, [
              el('span', {
                class: `st ${count ? 'missing' : 'ok'}`,
                text: count ? `${count} ${count === 1 ? 'issue' : 'issues'}` : '✓ matches the API',
              }),
              ...(count
                ? [
                    pill(
                      'Fix all',
                      'Prefill one task that fixes every issue of this form',
                      () => prefill(fixAllTask(form)),
                      'warn',
                    ),
                  ]
                : []),
            ]),
          ]
        : []),
    ]);
  }

  function liveSection(l) {
    if (!live) return [];
    const n = safe(() => live.section(l, { prefill, item: s.item }));
    return n ? [n] : [];
  }

  function composer(placeholder, { picker = true } = {}) {
    textarea = el('textarea', {
      placeholder,
      oninput: (e) => {
        s.draft = e.target.value;
      },
    });
    textarea.value = s.draft;
    return el('div', { class: 'composer', style: 'padding: 0; border: 0' }, [
      ...(picker ? [agentPicker()].filter(Boolean) : []),
      textarea,
      el('div', { class: 'row' }, [
        el('button', { class: 'primary', text: sendLabel(), onclick: () => send(s.draft) }),
      ]),
    ]);
  }

  function proposalEditor() {
    const p = s.proposal;
    const rows = s.proposalRows;
    const isForm = p.kind === 'form';
    const keys = isForm
      ? ['ui', 'model', 'dto', 'conversion', 'widget', 'validators', 'options']
      : ['ui', 'model', 'dto', 'conversion'];
    const heads = isForm
      ? ['Label', 'Draft field', 'API field', 'Conversion', 'Widget', 'Validators', 'Options']
      : ['UI', 'Model', 'API field', 'Conversion'];
    const input = (row, key) =>
      el('input', {
        value: row[key],
        'aria-label': key,
        oninput: (e) => {
          row[key] = e.target.value;
        },
      });
    return el('div', { class: 'status selected', style: 'display: flex; flex-direction: column; gap: 8px' }, [
      el('div', {}, [
        el('strong', { text: isForm ? 'AI form proposal' : 'AI proposal' }),
        ` for ${p.operation ?? 'the operation'}${isForm && p.form ? `, binds form “${p.form}”` : ''} – edit, then implement.`,
      ]),
      ...(p.notes ? [el('div', { class: 'meta-line', text: p.notes })] : []),
      ...(isForm && s.proposalFilled
        ? [
            el('div', {
              class: 'meta-line',
              text: `Empty widgets, validators and options of ${s.proposalFilled} ${s.proposalFilled === 1 ? 'row' : 'rows'} were filled from the spec.`,
            }),
          ]
        : []),
      el('div', { class: 'scroll-x' }, [
        el('table', { class: `map${isForm ? ' form-proposal' : ''}` }, [
          el('thead', {}, [
            el(
              'tr',
              {},
              [...heads, ''].map((h) => el('th', { text: h })),
            ),
          ]),
          el(
            'tbody',
            {},
            rows.map((row, i) =>
              el('tr', {}, [
                ...keys.map((key) => el('td', {}, [input(row, key)])),
                el('td', {}, [
                  el('button', {
                    class: 'icon',
                    title: 'Remove row',
                    text: '✕',
                    onclick: () => {
                      rows.splice(i, 1);
                      redraw();
                    },
                  }),
                ]),
              ]),
            ),
          ),
        ]),
      ]),
      el('div', { class: 'row' }, [
        el('button', {
          class: 'secondary',
          text: '+ Row',
          onclick: () => {
            rows.push(Object.fromEntries(keys.map((k) => [k, k === 'conversion' ? 'none' : ''])));
            redraw();
          },
        }),
        el('button', {
          class: 'primary',
          text: `${isForm ? 'Implement form' : 'Implement mapping'} (${sendLabel()})`,
          onclick: implementTask,
        }),
        el('button', {
          class: 'link',
          text: 'Discard',
          onclick: () => {
            markDone(p.id);
            s.proposal = null;
            s.proposalRows = null;
            redraw();
          },
        }),
      ]),
    ]);
  }

  function bindingView({ picker = true } = {}) {
    const l = s.lineage;
    const name = l.component ? `${l.component.name} ‹${l.component.selector}›` : 'this element';
    const parts = [
      el('div', { class: 'meta-line', text: `No data binding found for ${name}. Bind it to an API operation:` }),
    ];
    if (!s.specs?.length) {
      parts.push(el('div', { class: 'meta-line', text: 'No OpenAPI specs found – add one in the API tab.' }));
      return parts;
    }
    const op = operationOf(s.spec, s.operation);
    // an existing form without API write is bound instead of adding a second one
    const form = unboundForms().find((f) => f.name === s.lineage.control?.form) ?? unboundForms()[0] ?? null;
    parts.push(
      el('div', { class: 'row' }, [
        specSelect(),
        operationSelect(
          s.operation,
          (o) => o.operationId,
          (id) => {
            s.operation = id;
            redraw();
          },
        ),
      ]),
      ...(picker ? [agentPicker()].filter(Boolean) : []),
      el('div', { class: 'row' }, [
        isWrite(op)
          ? el('button', {
              class: 'primary',
              text: `Let AI propose a form (${sendLabel()})`,
              onclick: () => proposeFormTask(op.operationId, form, 'binding'),
            })
          : el('button', {
              class: 'primary',
              text: `Let AI propose a mapping (${sendLabel()})`,
              disabled: !s.operation,
              onclick: proposeTask,
            }),
      ]),
      ...waitingLine('binding'),
    );
    return parts;
  }

  function specSelect() {
    const select = el(
      'select',
      { 'aria-label': 'Spec', onchange: (e) => chooseSpec(e.target.value) },
      s.specs.map((spec) =>
        el('option', { value: spec.file, text: `${spec.title} ${spec.version}${spec.generators.length ? ' ●' : ''}` }),
      ),
    );
    select.value = s.spec?.file ?? '';
    return select;
  }

  function operationSelect(value, filter, onchange) {
    const select = el(
      'select',
      { 'aria-label': 'Operation', style: 'flex: 1; min-width: 0', onchange: (e) => onchange(e.target.value) },
      (s.spec?.operations ?? [])
        .filter((o) => o.operationId && filter(o))
        .map((o) => el('option', { value: o.operationId, text: `${opLabel(o)} · ${o.operationId}` })),
    );
    select.value = value;
    return select;
  }

  function waitingLine(where) {
    if (!s.waitingSince || s.proposal || s.waitingFor !== where) return [];
    return [
      el('div', {
        class: 'status in-progress',
        text: '⚙︎ Waiting for the proposal … the agent submits it via “npx benda proposal”.',
      }),
    ];
  }

  /** Write operation picker under a form that writes nothing yet. */
  function formBinder(form) {
    if (!s.specs?.length) return [];
    if (!s.spec?.operations.some((o) => isWrite(o) && o.operationId))
      return [
        el('div', { class: 'meta-line', text: `${s.spec?.title ?? 'The spec'} has no write operation to bind to.` }),
      ];
    return [
      el('div', { class: 'row' }, [
        ...(s.specs.length > 1 ? [specSelect()] : []),
        operationSelect(s.formOperation, isWrite, (id) => {
          s.formOperation = id;
        }),
        el('button', {
          class: 'secondary',
          text: `Let AI propose a form (${sendLabel()})`,
          title: `Propose how form “${form.name}” writes the chosen operation – an editable table first, no files change`,
          onclick: () => proposeFormTask(s.formOperation, form, `form:${form.name}`),
        }),
      ]),
      ...waitingLine(`form:${form.name}`),
    ];
  }

  function lineageView(l) {
    const stores = storesOf(l);
    const forms = l.forms ?? [];
    const body = [];
    if (stores.length) body.push(chain(l));
    body.push(...selectionLines(l));
    body.push(...stores.flatMap((st, i) => storeSection(l, st, i, stores.length)));
    body.push(...forms.map((form) => formSection(l, form)));
    const placeholder = 'Click a row, “+ Map”, “+ Show” or a form fix – or describe a data change …';
    if (!stores.length && !forms.length) {
      // nothing static to show: binding first; a composer only once something (the live section) prefilled a task
      body.push(...bindingView({ picker: !s.draft }), ...liveSection(l), ...(s.draft ? [composer(placeholder)] : []));
      return body;
    }
    body.push(...liveSection(l), composer(placeholder));
    if (!stores.length) body.push(...bindingView({ picker: false }));
    return body;
  }

  function redraw() {
    if (!root) return;
    textarea = null;
    const l = s.lineage;
    const body = [];
    if (!s.item)
      body.push(el('div', { class: 'empty', text: 'Select an element (◎ Select) to see where its data comes from.' }));
    else if (s.loading) body.push(el('div', { class: 'meta-line', text: 'Analysing data lineage …' }));
    else if (s.error) body.push(el('div', { class: 'status failed', text: s.error }));
    else if (l) body.push(...lineageView(l));
    if (s.proposal && s.proposalRows) body.push(proposalEditor());
    root.replaceChildren(...body);
  }

  /**
   * Called whenever the panel renders. `describeItem` is only invoked for a newly selected element,
   * so frequent re-renders (status events) neither re-analyse nor steal focus from the composer.
   */
  function mount(describeItem, key) {
    if (!root) {
      root = el('div', { class: 'data' });
      redraw();
    }
    if (!key && s.key !== null) {
      Object.assign(s, { item: null, key: null, lineage: null });
      redraw();
    } else if (key && key !== s.key) {
      analyse(describeItem(), key);
    }
    return root;
  }

  /** New proposal from the bridge (SSE). */
  function onProposal(proposal) {
    if (!proposal || proposal.id === s.proposal?.id || doneProposals().has(proposal.id)) return;
    // data-access proposals belong to the Inventory
    if (proposal.kind && proposal.kind !== 'mapping' && proposal.kind !== 'form') return;
    if (Date.now() - Date.parse(proposal.at) > PROPOSAL_MAX_AGE_MS) return;
    if (s.waitingSince && proposal.at < s.waitingSince) return;
    const isForm = proposal.kind === 'form';
    s.proposal = proposal;
    s.proposalRows = proposal.rows.map((r) => (isForm ? { widget: '', validators: '', options: '', ...r } : { ...r }));
    s.proposalSpec = null;
    s.proposalFilled = 0;
    s.waitingSince = null;
    s.waitingFor = null;
    showToast(`${isForm ? 'Form' : 'Mapping'} proposal received – review it in the Data tab`);
    redraw();
    if (isForm) fillFromSpec(proposal);
  }

  return { mount, onProposal };
}
