// Components view of the Benda overlay: the design system's components, from the catalog an agent read from the
// design system's MCP server (`npx benda components`), to drag into the page. A drop becomes a task for the agent,
// which also sets the component's required inputs – markup alone often does not compile. With ⌥/Alt held, Benda writes
// the plain markup through the adapter (POST /components/insert) without an agent, unless the place is ambiguous.
// Loaded lazily by overlay.js the first time the Components tab is opened.

export const COMPONENTS_STYLES = `
  .catalog { display: flex; flex-direction: column; min-height: 0; flex: 1; }
  .catalog .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #f4f4f5; }
  .catalog input[type=search] { flex: 1; min-width: 140px; border: 1px solid #d4d4d8; border-radius: 8px; padding: 7px 10px; font: inherit; color: inherit; }
  .catalog input[type=search]:focus { outline: 2px solid #c7d2fe; border-color: #6366f1; }
  .catalog select { border: 1px solid #d4d4d8; border-radius: 6px; padding: 2px 4px; font: inherit; }
  .catalog .list > div:not(.hint) { display: flex; flex-direction: column; gap: 6px; }
  .entry { display: block; width: 100%; text-align: left; font: inherit; color: inherit; cursor: grab; }
  .entry:hover, .entry:focus-visible { border-color: #c7d2fe; background: #eef2ff; outline: none; }
  .entry:active { cursor: grabbing; }
  .entry .head code { margin-left: auto; color: #71717a; }
  .drop-line { position: fixed; z-index: 2; height: 3px; border-radius: 2px; background: #6366f1; pointer-events: none; }
`;

const CATALOG_INPUT = '.benda/components-input.json';
const CATALOG_EXAMPLE = {
  source: '<name of the MCP server>',
  components: [{
    name: 'Button',
    group: 'Actions',
    description: 'Primary and secondary actions',
    snippet: '<acme-button variant="primary">Save</acme-button>',
    import: { name: 'AcmeButton', from: '@acme/design-system' },
  }],
};
const CATALOG_TASK = [
  'Load the component catalog for the Benda overlay: list every component of the design system this project uses, ' +
    'through the design system\'s MCP server (look for it among your MCP tools).',
  `Change no project files: write the catalog as JSON to ${CATALOG_INPUT} (the only file you write), in this shape:`,
  JSON.stringify(CATALOG_EXAMPLE),
  `then run: npx benda components ${CATALOG_INPUT}`,
  'Per component, `snippet` is minimal working markup for this project\'s framework, starting with the component\'s ' +
    'element, with sensible values for required inputs; `import` names the class and module a template needs for it ' +
    '(Angular: what goes into the standalone component\'s `imports`) – leave it out for globally registered web ' +
    'components. If there is no design-system MCP server, say so and stop.',
].join('\n');

const WHERE = { before: 'before', after: 'after', inside: 'as the last child of' };
const EDGE = 0.25; // top and bottom quarter of an element: before / after, the middle: inside
const LEAF = new Set(['img', 'input', 'br', 'hr', 'textarea', 'select', 'video', 'audio', 'iframe', 'canvas']);
const PREVIEW_MAX_MS = 10_000;

const tagOf = (component) => component.snippet.match(/^<([a-zA-Z][\w-]*)/)?.[1].toLowerCase() ?? 'div';

export function createComponentsView({ el, bridge, root, host, showToast, describe, selected, queueTask, agentName, canInsert }) {
  let node = null; // the view, kept across renders of the panel
  let catalog = null; // { source, components: [{ name, snippet, description, group, import? }], at }
  let query = '';
  let position = 'after'; // for inserting without dragging, relative to the selected element
  let dragging = null; // the component being dragged
  let drop = null; // { target, position } under the pointer
  const box = el('div', { class: 'box hover', hidden: true });
  const line = el('div', { class: 'drop-line', hidden: true });
  const label = el('div', { class: 'label', hidden: true });
  root.append(box, line, label);

  async function load() {
    try {
      catalog = await (await fetch(`${bridge}/components`)).json();
    } catch {
      catalog = { components: [] };
    }
    node?.replaceChildren(...content());
  }

  /** Called with the catalog's version from every status event – an agent may have just submitted a new one. */
  function onCatalog(at) {
    if (catalog && (catalog.at ?? null) !== at) load();
  }

  // ---------------------------------------------------------------- dragging into the page

  const isOwn = (event) => event.composedPath().includes(host);

  function positionAt(target, y) {
    const rect = target.getBoundingClientRect();
    const offset = (y - rect.top) / Math.max(rect.height, 1);
    if (LEAF.has(target.tagName.toLowerCase())) return offset < 0.5 ? 'before' : 'after';
    return offset < EDGE ? 'before' : offset > 1 - EDGE ? 'after' : 'inside';
  }

  function showDrop(target, where) {
    const rect = target.getBoundingClientRect();
    Object.assign(box.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    box.hidden = false;
    line.hidden = where === 'inside';
    if (where !== 'inside') {
      Object.assign(line.style, { top: `${(where === 'before' ? rect.top : rect.bottom) - 2}px`, left: `${rect.left}px`, width: `${rect.width}px` });
    }
    const tag = target.tagName.toLowerCase();
    label.textContent = `${dragging.name} ${WHERE[where]} <${tag}${target.classList[0] ? `.${target.classList[0]}` : ''}>`;
    label.style.top = `${Math.max(4, rect.top - 28)}px`;
    label.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - 300))}px`;
    label.hidden = false;
  }

  function hideDrop() {
    box.hidden = line.hidden = label.hidden = true;
    drop = null;
  }

  function onDragOver(event) {
    if (!dragging) return;
    const target = event.composedPath()[0];
    // over the panel there is nothing to drop on – no preventDefault, so the browser shows "not allowed"
    if (isOwn(event) || !(target instanceof Element) || target === document.documentElement || target.closest('[data-benda-preview]')) return hideDrop();
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    const where = positionAt(target, event.clientY);
    if (drop?.target !== target || drop.position !== where) {
      drop = { target, position: where };
      showDrop(target, where);
    }
  }

  function onDrop(event) {
    if (!dragging || !drop) return;
    // the app's own drop handlers must not see a component from the overlay
    event.preventDefault();
    event.stopImmediatePropagation();
    const { target, position: where } = drop;
    const component = dragging;
    stopDragging();
    insert(component, target, where, event.altKey);
  }

  function stopDragging() {
    dragging = null;
    hideDrop();
    window.removeEventListener('dragover', onDragOver, true);
    window.removeEventListener('drop', onDrop, true);
  }

  function startDragging(event, component) {
    dragging = component;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', component.snippet);
    window.addEventListener('dragover', onDragOver, true);
    window.addEventListener('drop', onDrop, true);
  }

  // ---------------------------------------------------------------- inserting

  /**
   * Shows the component at the drop place until the dev server delivers the real one: a registered web component
   * renders as itself, anything else as a placeholder. Only the bare element – the catalog's markup stays out of the
   * page, it is written to the source.
   */
  function showPreview(target, where, component) {
    const tag = tagOf(component);
    const real = Boolean(customElements.get(tag));
    const preview = real
      ? document.createElement(tag)
      : el('div', { style: 'margin: 4px 0; padding: 8px 10px; border: 2px dashed #6366f1; border-radius: 6px; background: rgb(99 102 241 / 0.08); color: #4338ca; font: 600 12px ui-sans-serif, system-ui;' });
    preview.textContent = real ? component.name : `${component.name} – inserting …`;
    preview.setAttribute('data-benda-preview', '');
    target.insertAdjacentElement({ before: 'beforebegin', after: 'afterend', inside: 'beforeend' }[where], preview);
    // gone as soon as the reloaded template renders the component itself
    const observer = new MutationObserver((mutations) => {
      const added = mutations.flatMap((m) => [...m.addedNodes]).filter((n) => n instanceof Element && n !== preview);
      if (added.some((n) => n.matches(tag) || n.querySelector(tag))) remove();
    });
    const remove = () => {
      observer.disconnect();
      clearTimeout(timer);
      preview.remove();
    };
    const timer = setTimeout(remove, PREVIEW_MAX_MS);
    observer.observe(document.body, { childList: true, subtree: true });
    return remove;
  }

  function agentTask(component, where, reason) {
    const lines = [
      `Insert the design-system component "${component.name}" ${WHERE[where]} the selected element.`,
      `Markup from the component catalog: ${component.snippet}`,
      ...(component.import ? [`Import: ${component.import.name} from '${component.import.from}'`] : []),
      'Look up its inputs and usage with the design system\'s MCP server and fill in what this place needs.',
      'Set every required input, so the app still builds.',
      ...(reason ? [`(Benda could not insert it directly: ${reason})`] : []),
    ];
    return lines.join('\n');
  }

  async function insert(component, target, where, direct) {
    const item = describe(target);
    if (!direct || !canInsert) {
      if (await queueTask(agentTask(component, where), [item])) showToast(`${component.name}: sent to ${agentName()}`);
      return;
    }
    const removePreview = showPreview(target, where, component);
    let res;
    try {
      res = await fetch(`${bridge}/components/insert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: component.name, position: where, item }),
      });
    } catch {
      removePreview();
      return showToast('Bridge not reachable');
    }
    if (res.ok) {
      const { file, line: at } = await res.json();
      return showToast(`✓ ${component.name} inserted in ${file}:${at}`);
    }
    removePreview();
    const reason = await res.text();
    // 409: Benda cannot tell the place for sure – an agent can
    if (res.status !== 409) return showToast(`Inserting failed: ${reason}`);
    if (await queueTask(agentTask(component, where, reason), [item])) showToast(`${reason} – sent to ${agentName()}`);
  }

  function insertAtSelection(component, direct) {
    const target = selected();
    if (!target) return showToast('Select an element first, or drag the component into the page');
    insert(component, target, LEAF.has(target.tagName.toLowerCase()) && position === 'inside' ? 'after' : position, direct);
  }

  // ---------------------------------------------------------------- view

  async function loadFromDesignSystem() {
    if (await queueTask(CATALOG_TASK, [])) showToast(`${agentName()} reads the components from the design system`);
  }

  function entry(component) {
    return el('button', {
      class: 'item entry',
      draggable: 'true',
      title: 'Drag into the page, or click to insert it at the selected element',
      ondragstart: (event) => startDragging(event, component),
      ondragend: stopDragging,
      onclick: (event) => insertAtSelection(component, event.altKey),
    }, [
      el('div', { class: 'head' }, [el('b', { text: component.name }), el('code', { text: `<${tagOf(component)}>` })]),
      ...(component.description ? [el('div', { class: 'meta', text: component.description })] : []),
    ]);
  }

  /** The view's content; built again only when the catalog changes, so typing in the search keeps its focus. */
  function content() {
    if (!catalog) return [el('div', { class: 'empty', text: 'Loading …' })];
    if (!catalog.components.length) {
      return [el('div', { class: 'empty' }, [
        'No component catalog yet. ', el('b', { text: agentName() }), ' reads it from your design system\'s MCP server ',
        '(project or user setting of the agent) and submits it with ', el('code', { text: 'npx benda components' }), '. ',
        el('br'), el('br'),
        el('button', { class: 'primary', text: 'Load from design system', onclick: loadFromDesignSystem }),
      ])];
    }
    const select = el('select', { 'aria-label': 'Where a click inserts', onchange: (event) => (position = event.target.value) },
      Object.entries(WHERE).map(([value, text]) => el('option', { value, text, ...(value === position ? { selected: true } : {}) })));
    const entries = () => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = catalog.components.filter((c) => words.every((w) => `${c.name} ${c.group} ${c.description} ${tagOf(c)}`.toLowerCase().includes(w)));
      const groups = Map.groupBy(matches, (c) => c.group || 'Other');
      return matches.length
        ? [...groups].flatMap(([group, list]) => [el('div', { class: 'section', text: group }), ...list.map(entry)])
        : [el('div', { class: 'empty', text: 'No component matches.' })];
    };
    const results = el('div', {}, entries());
    const search = el('input', {
      type: 'search',
      placeholder: `Search ${catalog.components.length} components`,
      'aria-label': 'Search components',
      value: query,
      oninput: (event) => {
        query = event.target.value;
        results.replaceChildren(...entries());
      },
    });
    return [
      el('div', { class: 'bar' }, [
        search,
        el('button', { class: 'secondary', title: `${agentName()} reads the catalog again from the design system's MCP server`, text: '↻', 'aria-label': 'Reload from design system', onclick: loadFromDesignSystem }),
      ]),
      el('div', { class: 'list' }, [
        el('div', { class: 'hint' }, [
          'Drag a component onto the page: top edge = before, bottom edge = after, middle = inside. ',
          `${agentName()} inserts it and sets its required inputs.`,
          canInsert ? ' Hold Alt (⌥) to let Benda write the plain markup right away, without an agent.' : '',
          ' Click inserts it ', select, ' the selected element.',
        ]),
        results,
        el('div', { class: 'hint', text: `${catalog.source ? `From ${catalog.source}, ` : ''}${catalog.at ? new Date(catalog.at).toLocaleString() : ''}` }),
      ]),
    ];
  }

  function mount() {
    if (!node) {
      node = el('div', { class: 'catalog' });
      node.replaceChildren(...content());
      load();
    }
    return node;
  }

  return { mount, onCatalog };
}
