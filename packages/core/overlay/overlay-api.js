// API view of the Benda overlay: browse and search the OpenAPI specs in api/, add new specs or
// versions (with a diff against the previous version), see what another version means for the app's mappers, stores
// and forms (impact, from the adapter) and re-run the client generator.
// Loaded lazily by overlay.js the first time the API tab is opened.

export const API_STYLES = `
  .api { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding: 10px 12px; gap: 10px; }
  .api input[type=search] { flex: 1; min-width: 0; border: 1px solid #d4d4d8; border-radius: 8px; padding: 7px 10px; font: inherit; color: inherit; }
  .api input[type=search]:focus { outline: 2px solid #c7d2fe; border-color: #6366f1; }
  .api h3 { margin: 4px 0 0; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #71717a; }
  .group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; border: 1px solid #f4f4f5; border-radius: 10px; background: #fafafa; }
  .group strong { margin-right: 4px; }
  .version { border: 1px solid #e4e4e7; border-radius: 999px; padding: 2px 9px; background: #fff; color: #3f3f46; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; cursor: pointer; }
  .version.on { border-color: #6366f1; background: #eef2ff; color: #3730a3; }
  .version .gen { margin-left: 5px; color: #16a34a; }
  .meta-line { color: #71717a; font-size: 12px; line-height: 1.5; word-break: break-all; }
  .meta-line code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #3f3f46; }
  .op, .schema { border: 1px solid #f4f4f5; border-radius: 8px; }
  .op > button, .schema > button { display: flex; width: 100%; align-items: center; gap: 8px; border: 0; background: transparent; padding: 6px 8px; text-align: left; cursor: pointer; font: inherit; color: inherit; }
  .op > button:hover, .schema > button:hover { background: #fafafa; }
  .method { flex: none; width: 54px; border-radius: 4px; padding: 1px 0; text-align: center; font: 700 11px ui-monospace, monospace; color: #fff; }
  .method.get { background: #16a34a; } .method.post { background: #2563eb; } .method.put, .method.patch { background: #d97706; } .method.delete { background: #dc2626; }
  .method.head, .method.options { background: #71717a; }
  .op code, .schema code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .op small, .schema small { margin-left: auto; color: #a1a1aa; font: 11px ui-monospace, monospace; white-space: nowrap; }
  .deprecated code { text-decoration: line-through; }
  .details { padding: 4px 10px 10px 70px; font-size: 12px; line-height: 1.6; color: #3f3f46; }
  .schema .details { padding-left: 10px; }
  .details table { border-collapse: collapse; width: 100%; }
  .details td { padding: 2px 8px 2px 0; vertical-align: top; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .details td:first-child { white-space: nowrap; }
  .details .req { color: #dc2626; }
  .hit { background: #fef9c3; border-radius: 3px; }
  .api textarea { min-height: 140px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .api pre { margin: 0; max-height: 180px; overflow: auto; padding: 8px; border-radius: 8px; background: #18181b; color: #e4e4e7; font: 11px/1.5 ui-monospace, monospace; white-space: pre-wrap; }
  .diff { font-size: 12px; line-height: 1.6; }
  .diff .add { color: #15803d; } .diff .del { color: #b91c1c; }
  .impact { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid #e4e4e7; border-radius: 10px; background: #fff; }
  .impact select { flex: 0 1 auto; }
  .impact h4 { margin: 4px 0 0; font-size: 12px; font-weight: 700; }
  .impact h4.breaking { color: #b91c1c; } .impact h4.changed { color: #b45309; } .impact h4.new { color: #15803d; }
  .impact-item { padding: 4px 0 4px 8px; border-left: 3px solid #e4e4e7; font-size: 12px; line-height: 1.5; color: #3f3f46; }
  .impact-item.breaking { border-color: #fca5a5; } .impact-item.changed { border-color: #fcd34d; } .impact-item.new { border-color: #86efac; }
  .impact-item code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  .impact-item .where { color: #71717a; }
  .impact-item .fix { color: #52525b; }
`;

const STORAGE_KEY = 'benda-api';

/**
 * `sendTask(instruction, context, template, options)` queues a task for the agent chosen under "Run with"
 * (overlay.js); `sendLabel()` names that agent on the button and `agentPicker()` renders the choice. All three are
 * optional: without `sendTask` the migration task can be copied instead. `impact` is the bridge's
 * `capabilities.impact`: without an adapter that analyses impact, "Impact on the app" is not shown. `onImpact` gets
 * every impact result ({ from, to, items }), e.g. for the Inventory to mark the affected building blocks.
 */
export function createApiView({ el, bridge, request, showToast, sendTask = null, sendLabel = () => 'Send to the agent', agentPicker = null, impact = true, onImpact = null }) {
  const s = {
    specs: null,
    dir: 'api',
    file: null,
    detail: null,
    query: '',
    open: new Set(),
    adding: false,
    draft: '',
    busy: false,
    result: null, // { kind: 'added' | 'generated', ... }
    error: null,
    impactFrom: null, // spec files compared under "Impact on the app"
    impactTo: null,
    impacts: new Map(), // `${from}|${to}` → { loading, error, data }
  };
  let root = null;
  let results = null;
  const actionSlots = new Set(); // agent picker + send button, refreshed on every mount

  try {
    Object.assign(s, JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}'));
  } catch {
    /* storage unavailable */
  }
  const persist = () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ file: s.file, query: s.query }));
    } catch {
      /* storage unavailable */
    }
  };

  async function getJson(path) {
    const res = await fetch(`${bridge}${path}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function load() {
    try {
      const { specs, dir } = await getJson('/specs');
      Object.assign(s, { specs, dir, error: null });
      if (s.file && !specs.some((spec) => spec.file === s.file)) s.file = null;
      if (!s.file) s.file = specs.filter((spec) => !spec.error).at(-1)?.file ?? null;
      if (s.file) await select(s.file, false);
    } catch (err) {
      s.error = err.message;
    }
    redraw();
  }

  async function select(file, draw = true) {
    s.file = file;
    s.open.clear();
    s.impactFrom = s.impactTo = null;
    persist();
    try {
      s.detail = await getJson(`/specs/detail?file=${encodeURIComponent(file)}`);
    } catch (err) {
      s.detail = null;
      s.error = err.message;
    }
    if (draw) redraw();
  }

  async function save(overwrite = false) {
    s.busy = true;
    redraw();
    try {
      const added = await request('/specs', { text: s.draft, overwrite });
      Object.assign(s, { adding: false, draft: '', result: { kind: 'added', ...added } });
      await load();
      await select(added.file);
      showToast(`Saved ${added.file}`);
    } catch (err) {
      if (/already exists/.test(err.message) && confirm(`${err.message}. Overwrite?`)) return save(true);
      showToast(`Saving failed: ${err.message}`);
    } finally {
      s.busy = false;
      redraw();
    }
  }

  async function regenerate() {
    s.busy = true;
    redraw();
    try {
      const result = await request('/specs/generate', { file: s.file });
      s.result = { kind: 'generated', ...result };
      showToast(result.ok ? 'Client regenerated' : 'Generator failed – see output');
    } catch (err) {
      showToast(err.message);
    } finally {
      s.busy = false;
      redraw();
    }
  }

  // ---------------------------------------------------------------- impact on the app

  const impactKey = (from, to) => `${from}|${to}`;
  const versionsOf = (file) => {
    const title = s.specs?.find((spec) => spec.file === file)?.title;
    return (s.specs ?? []).filter((spec) => !spec.error && spec.title === title);
  };
  const generatedOf = (file) => versionsOf(file).find((spec) => spec.generators.length) ?? null;

  /** The client's current version is what the code reflects, so the impact starts there when there is one. */
  function impactBase(file, previous) {
    const generated = generatedOf(file);
    return generated && generated.file !== file ? generated.file : previous ?? null;
  }

  async function loadImpact(from, to) {
    const key = impactKey(from, to);
    s.impacts.set(key, { loading: true });
    redrawImpacts();
    try {
      const data = await request('/specs/impact', { from, to });
      s.impacts.set(key, { data });
      onImpact?.({ from, to, items: data.items ?? [] });
    } catch (err) {
      s.impacts.set(key, { error: err.message });
    }
    redrawImpacts();
  }

  const impactSlots = new Set(); // { node, from, to } – impact lists in the page, redrawn when a result arrives

  function redrawImpacts() {
    for (const slot of impactSlots) {
      if (!slot.node.isConnected) impactSlots.delete(slot);
      else slot.node.replaceChildren(...impactBody(slot.from, slot.to, slot.withDiff));
    }
  }

  const LEVELS = [
    ['breaking', 'Breaking'],
    ['changed', 'Changed'],
    ['new', 'New in the API'],
  ];

  /** The migration task: switch the generator, regenerate, then fix exactly the listed places. */
  function migrationTask({ from, to, items }) {
    const generator = generatedOf(from.file)?.generators[0] ?? null;
    const line = (i) => `- ${i.file}:${i.line} ${i.symbol}: ${i.message}.${i.fix ? ` Fix: ${i.fix}` : ''}`;
    const fixes = items.filter((i) => i.level !== 'new');
    const additions = items.filter((i) => i.level === 'new');
    return [
      `Migrate the app's data layer from ${from.title} ${from.version} (${from.file}) to ${to.version} (${to.file}).`,
      `1. Point the client generator at ${to.file}${generator ? ` (${generator.config})` : ''} and regenerate the client${generator ? ` with \`${generator.command}\`` : ''}. Never edit the generated code.`,
      `2. Fix the code the new version affects, following the data-layer rules: mappers absorb the API change, stores and components keep working with the UI model, form validators follow the spec.${fixes.length ? '' : ' Benda found no affected places; check the compiler output after regenerating.'}`,
      ...fixes.map(line),
      ...(additions.length
        ? ['3. New in the API – map these only where the UI needs them, and list the ones you leave out in your summary:', ...additions.map(line)]
        : []),
      `${additions.length ? 4 : 3}. Update the mapper unit tests for every changed mapper and run them.`,
      `${additions.length ? 5 : 4}. Run \`npx benda check\` and fix its errors.`,
    ].join('\n');
  }

  async function migrate(data) {
    const text = migrationTask(data);
    // a migration concerns the workspace, not the elements that happen to be selected
    if (sendTask) return sendTask(text, '', null, { withSelection: false });
    try {
      await navigator.clipboard.writeText(text);
      showToast('Migration task copied to clipboard');
    } catch {
      showToast('Copying failed');
    }
  }

  function impactItem(item) {
    return el('div', { class: `impact-item ${item.level}` }, [
      el('div', {}, [el('code', { text: item.symbol }), ` ${item.message}`]),
      el('div', { class: 'where' }, [el('code', { text: `${item.file}:${item.line}` }), ` · ${item.kind}`]),
      ...(item.fix ? [el('div', { class: 'fix', text: item.fix })] : []),
    ]);
  }

  /** Agent choice and the migrate button; rebuilt on every mount so "Run with" changes show up. */
  function migrateActions(data) {
    const slot = el('div', { style: 'display: flex; flex-direction: column; gap: 6px' });
    const fill = () => {
      const label = `Migrate mapping to ${data.to.version}`;
      slot.replaceChildren(
        ...(sendTask && agentPicker ? [agentPicker()].filter(Boolean) : []),
        el('div', { class: 'row' }, [
          el('button', {
            class: 'primary',
            text: sendTask ? `${label} (${sendLabel()})` : `Copy task: ${label}`,
            title: 'Update the generator config, regenerate the client and fix the listed places',
            onclick: () => migrate(data),
          }),
        ]),
      );
    };
    fill();
    actionSlots.add({ node: slot, fill });
    return slot;
  }

  function impactBody(from, to, withDiff = false) {
    const entry = s.impacts.get(impactKey(from, to));
    if (!entry) return [];
    if (entry.loading) return [el('div', { class: 'meta-line', text: 'Checking mappers, stores and forms …' })];
    if (entry.error) {
      const unsupported = /no impact analysis/.test(entry.error);
      return [el('div', { class: unsupported ? 'meta-line' : 'status failed', text: unsupported ? `${entry.error}.` : entry.error })];
    }
    const { items, summary, from: a, to: b } = entry.data;
    const generated = summary.generated.map((file) => (s.specs ?? []).find((spec) => spec.file === file)?.version ?? file);
    if (!summary.stores) {
      return [el('div', { class: 'meta-line', text: `No store in this workspace uses a client generated from ${a.title}.` })];
    }
    const checked = `${summary.stores} store${summary.stores === 1 ? '' : 's'}, ${summary.mappers} mapper${summary.mappers === 1 ? '' : 's'}, ${summary.forms} form${summary.forms === 1 ? '' : 's'}`;
    return [
      ...(withDiff ? [diffNode(entry.data.diff, a)] : []),
      el('div', { class: 'meta-line', text: `${a.version} → ${b.version}: checked ${checked} (client generated from ${generated.join(', ')}).` }),
      ...(items.length
        ? LEVELS.flatMap(([level, title]) => {
            const group = items.filter((i) => i.level === level);
            return group.length ? [el('h4', { class: level, text: `${title} (${group.length})` }), ...group.map(impactItem)] : [];
          })
        : [el('div', { class: 'meta-line', text: 'Nothing in the mappers, stores or forms is affected.' })]),
      ...(summary.failures?.length ? [el('div', { class: 'meta-line', text: `Not analysed: ${summary.failures.map((f) => f.file).join(', ')}` })] : []),
      migrateActions(entry.data),
    ];
  }

  /** "Impact on the app" for two versions, loaded on first display when `auto`; `pick` lets the user choose both. */
  function impactNode(from, to, { auto = false, pick = false } = {}) {
    if (auto && from && to && !s.impacts.has(impactKey(from, to))) loadImpact(from, to);
    const body = el('div', { style: 'display: flex; flex-direction: column; gap: 6px' });
    const slot = { node: body, from, to, withDiff: pick };
    impactSlots.add(slot);
    body.replaceChildren(...impactBody(from, to, pick));
    const header = [el('h4', { text: 'Impact on the app' })];
    if (pick) {
      const versions = versionsOf(to ?? from);
      const select = (value, onchange, label) => {
        const node = el('select', { 'aria-label': label, onchange: (e) => onchange(e.target.value) },
          versions.map((v) => el('option', { value: v.file, text: `${v.version}${v.generators.length ? ' ●' : ''}` })));
        node.value = value ?? '';
        return node;
      };
      header.push(
        el('div', { class: 'row' }, [
          select(from, (file) => { s.impactFrom = file; redraw(); }, 'Current version'),
          el('span', { text: '→' }),
          select(to, (file) => { s.impactTo = file; redraw(); }, 'Version to move to'),
          el('button', {
            class: 'secondary',
            text: 'Check again',
            disabled: !from || !to || from === to,
            onclick: () => loadImpact(from, to),
          }),
        ]),
      );
    }
    return el('div', { class: 'impact' }, [...header, body]);
  }

  /** Under the selected spec: compare it with another version of the same API. */
  function compareNode() {
    const d = s.detail;
    const versions = d ? versionsOf(d.file) : [];
    // right after adding a version the saved result already shows its impact
    if (!impact || versions.length < 2 || (s.result?.kind === 'added' && s.result.file === d.file)) return [];
    if (!s.impactFrom || !s.impactTo) {
      // what the code would go through: from the client's version to the selected one, or from the selected
      // client version to the newest other one; without a client from the previous version on
      const generated = generatedOf(d.file);
      const at = versions.findIndex((v) => v.file === d.file);
      const other = versions.filter((v) => v.file !== d.file).at(-1).file;
      if (generated && generated.file !== d.file) [s.impactFrom, s.impactTo] = [generated.file, d.file];
      else if (generated || at === 0) [s.impactFrom, s.impactTo] = [d.file, other];
      else [s.impactFrom, s.impactTo] = [versions[at - 1].file, d.file];
    }
    return [impactNode(s.impactFrom, s.impactTo, { pick: true, auto: s.impactFrom !== s.impactTo })];
  }

  // ---------------------------------------------------------------- search

  const tokens = () => s.query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (haystack) => tokens().every((t) => haystack.toLowerCase().includes(t));
  const isHit = (text) => tokens().length > 0 && tokens().some((t) => String(text).toLowerCase().includes(t));

  function opMatches(op) {
    return matches([op.method, op.path, op.operationId, op.summary, ...op.tags, ...op.parameters.map((p) => p.name), op.requestBody, ...op.responses.map((r) => r.type)].join(' '));
  }

  function schemaMatches(schema) {
    return matches([schema.name, schema.description, ...schema.properties.map((p) => `${p.name} ${p.type}`)].join(' '));
  }

  // ---------------------------------------------------------------- rendering

  function toggle(key) {
    if (s.open.has(key)) s.open.delete(key);
    else s.open.add(key);
    drawResults();
  }

  function operationNode(op) {
    const key = `op:${op.method}:${op.path}`;
    const expanded = s.open.has(key);
    const body = [];
    if (expanded) {
      const rows = [
        ...op.parameters.map((p) => [`${p.in} ${p.name}`, p.type, p.required]),
        ...(op.requestBody ? [['body', op.requestBody, true]] : []),
        ...op.responses.map((r) => [`→ ${r.status}`, r.type ?? r.description, false]),
      ];
      body.push(
        el('div', { class: 'details' }, [
          ...(op.summary ? [el('div', { text: op.summary })] : []),
          el('table', {}, rows.map(([name, type, required]) =>
            el('tr', {}, [el('td', {}, [name, ...(required ? [el('span', { class: 'req', text: ' *' })] : [])]), el('td', { text: type ?? '' })]),
          )),
        ]),
      );
    }
    return el('div', { class: `op${op.deprecated ? ' deprecated' : ''}` }, [
      el('button', { 'aria-expanded': String(expanded), onclick: () => toggle(key) }, [
        el('span', { class: `method ${op.method}`, text: op.method.toUpperCase() }),
        el('code', { text: op.path }),
        el('small', { text: op.operationId ?? '' }),
      ]),
      ...body,
    ]);
  }

  function schemaNode(schema) {
    const key = `schema:${schema.name}`;
    const propertyHit = tokens().length > 0 && schema.properties.some((p) => isHit(p.name)) && !isHit(schema.name);
    const expanded = s.open.has(key) || propertyHit;
    return el('div', { class: 'schema' }, [
      el('button', { 'aria-expanded': String(expanded), onclick: () => toggle(key) }, [
        el('code', { text: schema.name }),
        el('small', { text: schema.properties.length ? `${schema.properties.length} fields` : schema.type }),
      ]),
      ...(expanded
        ? [el('div', { class: 'details' }, [
            ...(schema.description ? [el('div', { text: schema.description })] : []),
            schema.properties.length
              ? el('table', {}, schema.properties.map((p) =>
                  el('tr', { title: p.description }, [
                    el('td', {}, [el('span', { class: isHit(p.name) ? 'hit' : '', text: p.name }), ...(p.required ? [el('span', { class: 'req', text: ' *' })] : [])]),
                    el('td', { text: p.type }),
                  ]),
                ))
              : el('code', { text: schema.type }),
          ])]
        : []),
    ]);
  }

  function diffNode(diff, previous) {
    if (!diff) return el('div', { class: 'meta-line', text: 'First version of this API.' });
    const lines = [
      ...diff.addedOperations.map((o) => ['add', `+ ${o}`]),
      ...diff.removedOperations.map((o) => ['del', `− ${o}`]),
      ...diff.addedSchemas.map((n) => ['add', `+ schema ${n}`]),
      ...diff.removedSchemas.map((n) => ['del', `− schema ${n}`]),
      ...diff.changedSchemas.flatMap((c) => [
        ...c.added.map((p) => ['add', `+ ${c.name}.${p}`]),
        ...c.removed.map((p) => ['del', `− ${c.name}.${p}`]),
      ]),
    ];
    return el('div', { class: 'diff' }, [
      el('div', { class: 'meta-line', text: `Changes since ${previous.version}:` }),
      ...(lines.length ? lines.map(([cls, text]) => el('div', { class: cls, text })) : [el('div', { text: 'No structural changes.' })]),
    ]);
  }

  function resultNode() {
    const r = s.result;
    if (!r) return null;
    const close = el('button', { class: 'link', text: 'Dismiss', onclick: () => { s.result = null; redraw(); } });
    if (r.kind === 'added') {
      const base = impact && r.previous ? impactBase(r.file, r.previous.file) : null;
      return el('div', { class: 'status done' }, [
        `✓ Saved ${r.title} ${r.version} as ${r.file}. `,
        close,
        diffNode(r.diff, r.previous),
        ...(base ? [impactNode(base, r.file, { auto: true })] : []),
      ]);
    }
    return el('div', { class: `status ${r.ok ? 'done' : 'failed'}` }, [
      `${r.ok ? '✓ Generated' : '✕ Generator failed'}: ${r.command} `, close, el('pre', { text: r.output || '(no output)' }),
    ]);
  }

  function addForm() {
    const saveButton = el('button', { class: 'primary', text: s.busy ? 'Saving …' : 'Save spec', disabled: s.busy || !s.draft.trim(), onclick: () => save() });
    const setDraft = (text) => {
      s.draft = text;
      saveButton.disabled = s.busy || !text.trim();
    };
    const textarea = el('textarea', {
      placeholder: 'Paste an OpenAPI spec (YAML or JSON) – or choose a file. It is stored by title and info.version.',
      oninput: (e) => setDraft(e.target.value),
    });
    textarea.value = s.draft;
    const fileInput = el('input', {
      type: 'file',
      accept: '.yaml,.yml,.json',
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setDraft(await file.text());
        textarea.value = s.draft;
      },
    });
    return el('div', { class: 'composer', style: 'padding: 0; border: 0' }, [
      textarea,
      fileInput,
      el('div', { class: 'row' }, [
        saveButton,
        el('button', { class: 'secondary', text: 'Cancel', onclick: () => { s.adding = false; redraw(); } }),
      ]),
    ]);
  }

  function specList() {
    const groups = new Map();
    for (const spec of s.specs ?? []) {
      const key = spec.title ?? spec.file;
      groups.set(key, [...(groups.get(key) ?? []), spec]);
    }
    if (!groups.size) {
      return [el('div', { class: 'empty', text: `No OpenAPI specs found in ${s.dir}/. Add one with “+ Add spec”.` })];
    }
    return [...groups.entries()].map(([title, versions]) =>
      el('div', { class: 'group' }, [
        el('strong', { text: title }),
        ...versions.map((spec) =>
          spec.error
            ? el('span', { class: 'version', title: spec.error, text: `⚠ ${spec.file}` })
            : el('button', {
                class: `version${spec.file === s.file ? ' on' : ''}`,
                title: `${spec.file} · ${spec.operations} operations · ${spec.schemas} schemas`,
                onclick: () => select(spec.file),
              }, [spec.version, ...(spec.generators.length ? [el('span', { class: 'gen', title: 'A client is generated from this version', text: '●' })] : [])]),
        ),
      ]),
    );
  }

  function detailHeader() {
    const d = s.detail;
    if (!d) return [];
    const generator = d.generators[0];
    return [
      el('div', { class: 'meta-line' }, [
        el('code', { text: d.file }), ` · OpenAPI ${d.openapi}`, ...(d.servers.length ? [` · server ${d.servers.join(', ')}`] : []),
      ]),
      el('div', { class: 'meta-line' }, generator
        ? ['Client: ', el('code', { text: generator.tool }), ' → ', el('code', { text: generator.output ?? '?' }), ' ',
            el('button', { class: 'link', text: s.busy ? 'Generating …' : 'Regenerate', disabled: s.busy, onclick: regenerate })]
        : ['No client is generated from this version.']),
    ];
  }

  function drawResults() {
    if (!results) return;
    const d = s.detail;
    if (!d) {
      results.replaceChildren();
      return;
    }
    const ops = d.operations.filter(opMatches);
    const schemas = d.schemas.filter(schemaMatches);
    results.replaceChildren(
      el('h3', { text: `Operations (${ops.length}${ops.length !== d.operations.length ? ` of ${d.operations.length}` : ''})` }),
      ...ops.map(operationNode),
      el('h3', { text: `Schemas (${schemas.length}${schemas.length !== d.schemas.length ? ` of ${d.schemas.length}` : ''})` }),
      ...schemas.map(schemaNode),
    );
  }

  function redraw() {
    if (!root) return;
    impactSlots.clear(); // the lists of the previous drawing are gone; this one registers its own
    const search = el('input', {
      type: 'search',
      placeholder: 'Search paths, operations, schemas, fields …',
      'aria-label': 'Search the selected spec',
      oninput: (e) => { s.query = e.target.value; persist(); drawResults(); },
    });
    search.value = s.query;
    results = el('div', { style: 'display: flex; flex-direction: column; gap: 4px' });
    root.replaceChildren(
      el('div', { class: 'row' }, [
        search,
        el('button', { class: 'secondary', text: '+ Add spec', onclick: () => { s.adding = true; redraw(); } }),
        el('button', { class: 'icon', title: 'Reload specs', text: '↻', onclick: load }),
      ]),
      ...(s.error ? [el('div', { class: 'status failed', text: s.error })] : []),
      ...[resultNode()].filter(Boolean),
      ...(s.adding ? [addForm()] : []),
      el('h3', { text: `Specs in ${s.dir}/` }),
      ...(s.specs ? specList() : [el('div', { class: 'meta-line', text: 'Loading …' })]),
      ...detailHeader(),
      ...compareNode(),
      results,
    );
    drawResults();
  }

  /**
   * Returns the view's root element and loads the specs on first use. The view redraws itself on its
   * own state changes only – the overlay re-renders often (status events) and must not steal focus.
   */
  function mount() {
    if (!root) {
      root = el('div', { class: 'api' });
      redraw();
      load();
    }
    for (const slot of actionSlots) {
      if (!slot.node.isConnected) actionSlots.delete(slot);
      else slot.fill();
    }
    return root;
  }

  return { mount };
}
