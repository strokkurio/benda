// The task composer shared by the overlay and the Inventory: text field with the "/" (skills) and "#" (tags)
// menus, the chips of what was picked, Template, Run with (harness, session, model) and sending to the bridge's queue.
// It works on the host's state object, so both UIs keep their own state with the same field names:
//   agents, agent, session, modelOf, sessionOf, templates, template, tagList, tags, skillList, skills, menu,
//   instruction, rules, note, lastPrompt
// Served by the bridge next to overlay.js.

export const SESSIONS = { terminal: 'This terminal', task: 'New per task', shared: 'Shared' };
export const SESSION_HINT = {
  terminal: 'Your Claude Code session in the terminal – it keeps the conversation; tasks need the watch mode or your next prompt',
  task: 'The bridge starts a new session for every task – a fresh context each time',
  shared: 'The bridge continues one session across tasks – it remembers the earlier ones; ↺ starts a new one',
};

export const harnessOf = (id) => (String(id).startsWith('opencode:') ? 'OpenCode' : 'Claude Code');

// "/" picks a skill, "#" a tag – typed at the start of the text or after a space, so paths and "and/or" stay text
const MENU_KIND = { '/': 'skill', '#': 'tag' };

/**
 * `render` redraws the host UI, `persist` saves its state; both are called after every change the composer makes.
 */
export function createComposer({ state, el, bridge, request, showToast, render, persist }) {
  const isClaude = () => state.agent === 'claude';
  /** False in local-only projects ("claude": false), where the bridge does not list Claude. */
  const hasClaude = () => state.agents.some((agent) => agent.kind === 'claude');
  // Naming, the same everywhere: "Harness · model" where an agent is chosen or recorded (Run with, toolbar, task
  // cards), the harness alone in buttons and live messages ("Send to OpenCode", "Claude Code · Editing …").
  const agentById = (id) => state.agents.find((agent) => agent.id === id);
  const agentLabel = (id) => agentById(id)?.label ?? harnessOf(id);
  const agentName = () => (state.agent ? harnessOf(state.agent) : 'the agent');
  const sendLabel = () => `Send to ${agentName()}`;

  /** The sessions a harness offers, in a fixed order. */
  const sessionsOf = (harness) =>
    Object.keys(SESSIONS).filter((session) => state.agents.some((agent) => agent.harness === harness && agent.sessions?.includes(session)));
  /** Default: the terminal where there is one (as before), else a new session per task – small local contexts fill fast. */
  const defaultSession = (harness) => {
    const offered = sessionsOf(harness);
    return offered.includes(state.sessionOf[harness]) ? state.sessionOf[harness] : offered.includes('terminal') ? 'terminal' : offered[0];
  };

  /** Picks harness, session and model together; without an agent id the one last used for that harness and session. */
  async function chooseAgent(harness, session = defaultSession(harness), id = null) {
    const fits = (agent) => agent?.harness === harness && agent.sessions?.includes(session);
    const agent = [agentById(id), agentById(state.modelOf[harness])].find(fits) ?? state.agents.find(fits);
    if (!agent) return;
    Object.assign(state, { agent: agent.id, session });
    state.sessionOf[harness] = session;
    if (session !== 'terminal') state.modelOf[harness] = agent.id;
    persist();
    render();
    const dropped = await loadSkills();
    if (dropped.length) showToast(`${agentName()} has no skill ${dropped.map((name) => `/${name}`).join(', ')} – removed`);
  }

  async function resetSession() {
    try {
      await request('/sessions/reset', { harness: harnessOf(state.agent) === 'OpenCode' ? 'opencode' : 'claude' });
      showToast(`New ${agentName()} session with the next task`);
    } catch (err) {
      showToast(`Reset failed: ${err.message}`);
    }
  }

  /**
   * Harness, session and model side by side; a part with nothing to choose is shown as text, e.g. the terminal
   * session's model, which only Claude Code itself can change.
   */
  function agentPicker() {
    const current = agentById(state.agent);
    if (!current) return null;
    const harnesses = [...new Set(state.agents.map((agent) => agent.harness))];
    const sessions = sessionsOf(current.harness);
    const models = state.agents.filter((agent) => agent.harness === current.harness && agent.sessions?.includes(state.session));
    if (harnesses.length < 2 && sessions.length < 2 && models.length < 2) return null;
    const fixed = (text, title = '') => el('span', { class: 'fixed', text, title: title || text });
    const select = (props, options, value) => {
      const node = el('select', props, options.map(([key, text]) => el('option', { value: key, text })));
      node.value = value;
      return node;
    };
    const harness = harnesses.length > 1
      ? select({ class: 'harness', 'aria-label': 'Harness', onchange: (e) => chooseAgent(e.target.value) }, harnesses.map((name) => [name, name]), current.harness)
      : fixed(current.harness);
    const session = sessions.length > 1
      ? select({ class: 'session', 'aria-label': 'Session', title: SESSION_HINT[state.session], onchange: (e) => chooseAgent(current.harness, e.target.value) },
          sessions.map((key) => [key, SESSIONS[key]]), state.session)
      : fixed(SESSIONS[state.session], SESSION_HINT[state.session]);
    const reset = state.session === 'shared'
      ? [el('button', { class: 'icon', text: '↺', title: 'Start a new shared session with the next task', 'aria-label': 'New shared session', onclick: resetSession })]
      : [];
    const model = state.session === 'terminal'
      ? fixed(`${current.modelLabel ?? 'Model'} of the session`, 'Claude Code uses the model of your session – change it there with /model')
      : models.length > 1
        ? select({ 'aria-label': 'Model', onchange: (e) => chooseAgent(current.harness, state.session, e.target.value) }, models.map((agent) => [agent.id, agent.modelLabel]), state.agent)
        : fixed(current.modelLabel);
    return el('div', { class: 'field' }, [el('span', { text: 'Run with' }), harness, session, ...reset, model]);
  }

  function templatePicker() {
    if (!state.templates.length) return null;
    const select = el('select', {
      'aria-label': 'Template',
      onchange: (e) => {
        state.template = e.target.value || null;
        persist();
        render();
      },
    }, [{ id: '', label: 'None' }, ...state.templates].map((t) => el('option', { value: t.id, text: t.label })));
    select.value = state.template ?? '';
    return el('label', { class: 'field' }, [el('span', { text: 'Template' }), select]);
  }

  /** The "/…" or "#…" being typed at the caret, or null. */
  function menuToken(textarea) {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const match = /(?:^|\s)([/#])([\w.:-]*)$/.exec(before);
    if (!match || textarea.selectionStart !== textarea.selectionEnd) return null;
    return { kind: MENU_KIND[match[1]], query: match[2].toLowerCase(), start: before.length - match[2].length - 1, end: before.length };
  }

  function menuOptions(kind, query) {
    const hit = (...texts) => texts.some((text) => text.toLowerCase().includes(query));
    const byPrefix = (a, b) => Number(!a.value.toLowerCase().startsWith(query)) - Number(!b.value.toLowerCase().startsWith(query));
    const options = kind === 'skill'
      ? state.skillList.filter((s) => !state.skills.includes(s.name) && hit(s.name))
        .map((s) => ({ value: s.name, label: `/${s.name}`, detail: s.description, scope: s.scope }))
      : state.tagList.filter((t) => !state.tags.includes(t.id) && hit(t.id, t.label))
        .map((t) => ({ value: t.id, label: `#${t.id}`, detail: `${t.label}: ${t.text}` }));
    return options.sort(byPrefix);
  }

  /** Why the menu has nothing to offer – only for a bare "/" or "#", where the user clearly asked for the menu. */
  function menuEmptyText(kind) {
    if (kind === 'tag') return state.tagList.length ? 'All tags are added.' : 'No tags yet – add prompt.tags to benda.config.json.';
    if (state.skillList.length) return 'All skills are added.';
    return isClaude()
      ? 'Claude Code has no skills here – add them under .claude/skills/ or ~/.claude/skills/.'
      : `${agentName()} has no skills here – add them under .opencode/skills/, .claude/skills/ or ~/.config/opencode/skills/.`;
  }

  let menuDismissed = null; // start of a token closed with Esc – it stays closed until the user types elsewhere

  /** Shows, updates or hides the "/" and "#" menu for the text field. */
  function renderMenu(textarea, menu) {
    const token = menuToken(textarea);
    if (token?.start !== menuDismissed) menuDismissed = null;
    const options = token ? menuOptions(token.kind, token.query) : [];
    if (!token || menuDismissed !== null || (!options.length && token.query)) {
      state.menu = null;
      menu.hidden = true;
      return;
    }
    const index = state.menu?.kind === token.kind ? Math.min(state.menu.index, options.length - 1) : 0;
    state.menu = { ...token, options, index: Math.max(index, 0) };
    menu.hidden = false;
    if (!options.length) return menu.replaceChildren(el('div', { class: 'none', text: menuEmptyText(token.kind) }));
    menu.replaceChildren(...options.map((option, i) => el('div', {
      class: i === state.menu.index ? 'option on' : 'option',
      role: 'option',
      'aria-selected': String(i === state.menu.index),
      // mousedown, not click: the text field keeps the focus
      onmousedown: (e) => { e.preventDefault(); chooseOption(textarea, i); },
    }, [
      el('div', { class: 'name' }, [option.label, ...(option.scope ? [el('span', { class: 'scope', text: option.scope })] : [])]),
      ...(option.detail ? [el('div', { class: 'detail', text: option.detail, title: option.detail })] : []),
    ])));
    menu.children[state.menu.index]?.scrollIntoView({ block: 'nearest' });
  }

  /** Replaces the typed "/…" or "#…" with a token above the text field. */
  function chooseOption(textarea, index) {
    const { kind, start, end, options } = state.menu;
    const option = options[index];
    if (kind === 'skill') state.skills = [...state.skills, option.value];
    else state.tags = [...state.tags, option.value];
    textarea.value = textarea.value.slice(0, start) + textarea.value.slice(end).replace(/^ /, start && textarea.value[start - 1] === ' ' ? '' : ' ').replace(/^ $/, '');
    textarea.setSelectionRange(start, start);
    state.instruction = textarea.value;
    state.menu = null;
    persist();
    render();
  }

  /** Keys the open menu takes from the text field; true when the key was handled. */
  function menuKey(e, textarea, menu) {
    if (!state.menu || e.metaKey || e.ctrlKey || e.altKey) return false;
    const count = state.menu.options.length;
    if (e.key === 'Escape') {
      menuDismissed = state.menu.start;
      renderMenu(textarea, menu);
    } else if (!count) return false;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      state.menu.index = (state.menu.index + (e.key === 'ArrowDown' ? 1 : count - 1)) % count;
      renderMenu(textarea, menu);
    } else if (e.key === 'Enter' || e.key === 'Tab') chooseOption(textarea, state.menu.index);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  /** "/ skill, # tag" for placeholders – only what there is to pick. */
  const triggerHint = () => [state.skillList.length && '/ skill', state.tagList.length && '# tag'].filter(Boolean).join(', ');

  /**
   * The text field with its "/" and "#" menu. `onInput` runs after every keystroke (the host updates its send
   * button there instead of re-rendering), `onSubmit` on ⌘/Ctrl+Enter or ⌥/Alt+Enter.
   */
  function textField({ placeholder, onInput, onSubmit }) {
    const menu = el('div', { class: 'menu', role: 'listbox', 'aria-label': 'Skills and tags', hidden: true });
    const textarea = el('textarea', {
      class: 'instruction',
      rows: 3,
      placeholder,
      oninput: (e) => {
        state.instruction = e.target.value;
        persist();
        renderMenu(textarea, menu);
        onInput?.();
      },
      onkeyup: (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') renderMenu(textarea, menu); },
      onclick: () => renderMenu(textarea, menu),
      onblur: () => { state.menu = null; menu.hidden = true; },
      onkeydown: (e) => {
        if (menuKey(e, textarea, menu)) return;
        if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey || e.altKey)) return;
        e.preventDefault(); // ⌥↩ would insert a line break
        onSubmit();
      },
    });
    textarea.value = state.instruction;
    return { node: el('div', { class: 'compose' }, [menu, textarea]), textarea, menu };
  }

  /**
   * Hosts rebuild their UI on every status event: call before replacing it (with the root that holds the focus), then
   * call the result with the new field – typing goes on where it was, menu included.
   */
  function keepTyping(root) {
    const typing = root.activeElement?.classList.contains('instruction') ? root.activeElement : null;
    return (field) => {
      if (!typing || !field.textarea.isConnected) return;
      field.textarea.focus();
      field.textarea.setSelectionRange(typing.selectionStart, typing.selectionEnd);
      renderMenu(field.textarea, field.menu);
    };
  }

  /** The skills and tags picked for the next task, each removable. */
  function tokenList() {
    if (!state.skills.length && !state.tags.length) return null;
    const token = (text, title, remove) => el('span', { class: 'token', title }, [
      text,
      el('button', { title: 'Remove', 'aria-label': `Remove ${text}`, text: '✕', onclick: () => { remove(); persist(); render(); } }),
    ]);
    return el('div', { class: 'tokens' }, [
      ...state.skills.map((name) => token(`/${name}`, state.skillList.find((s) => s.name === name)?.description ?? 'Skill',
        () => (state.skills = state.skills.filter((n) => n !== name)))),
      ...state.tags.map((id) => {
        const tag = state.tagList.find((t) => t.id === id);
        return token(`#${id}`, tag ? `${tag.label}: ${tag.text}` : 'Tag', () => (state.tags = state.tags.filter((t) => t !== id)));
      }),
    ]);
  }

  /**
   * Queues a task for the chosen agent and session; `fields` are the rest of the POST /tasks body (instruction,
   * template, tags, skills, items, page, …). Clears what was typed for it. The bridge's answer, or null on failure.
   */
  async function submit(fields) {
    try {
      const result = await request('/tasks', { agent: state.agent, session: state.session, ...fields });
      state.lastPrompt = result.prompt;
      state.instruction = '';
      // chosen for this task like the instruction, so they go with it: the next task starts without a template
      if (fields.template) state.template = null;
      if (fields.skills?.length) state.skills = [];
      if (fields.tags?.length) state.tags = [];
      persist();
      render();
      if (result.ahead) showToast(`Task queued – ${result.ahead} ahead of it`);
      return result;
    } catch (err) {
      showToast(`Sending failed: ${err.message}`);
      return null;
    }
  }

  async function loadPrompt() {
    const { rules, templates, tags = [], note } = await (await fetch(`${bridge}/prompt`)).json();
    Object.assign(state, { rules, templates, note, tagList: tags });
    state.tags = state.tags.filter((id) => tags.some((t) => t.id === id));
    if (!templates.some((t) => t.id === state.template)) state.template = null;
  }

  /**
   * Skills differ per harness (and user skills per machine): a skill picked for one agent stays only if the newly
   * chosen agent can load it too, e.g. a project skill both read. Returns the names dropped.
   */
  async function loadSkills() {
    try {
      const { skills } = state.agent ? await (await fetch(`${bridge}/skills?agent=${encodeURIComponent(state.agent)}`)).json() : { skills: [] };
      state.skillList = skills;
    } catch {
      return []; // bridge offline – keep the choice, sending checks it anyway
    }
    const dropped = state.skills.filter((name) => !state.skillList.some((skill) => skill.name === name));
    state.skills = state.skills.filter((name) => !dropped.includes(name));
    persist();
    render();
    return dropped;
  }

  async function loadAgents() {
    try {
      const [{ agents, defaultAgent }] = await Promise.all([fetch(`${bridge}/agents`).then((res) => res.json()), loadPrompt()]);
      state.agents = agents;
      const known = (id) => agents.some((agent) => agent.id === id);
      if (!known(state.agent)) state.agent = known(defaultAgent) ? defaultAgent : (agents[0]?.id ?? null);
      const agent = agentById(state.agent);
      if (agent && !agent.sessions?.includes(state.session)) state.session = agent.sessions.includes(defaultSession(agent.harness)) ? defaultSession(agent.harness) : agent.sessions[0];
      await loadSkills();
      render();
    } catch {
      /* bridge offline – the picker stays hidden until it reconnects */
    }
  }

  /** SSE field `claude`: the hooks saw a new model in the Claude session (e.g. after /model). True when it changed. */
  function updateClaude(claude) {
    const listed = state.agents.findIndex((agent) => agent.id === 'claude');
    if (!claude || listed < 0 || state.agents[listed].label === claude.label) return false;
    state.agents[listed] = claude;
    return true;
  }

  return {
    isClaude, hasClaude, agentById, agentLabel, agentName, sendLabel, harnessOf,
    chooseAgent, agentPicker, templatePicker, tokenList, textField, keepTyping, triggerHint, renderMenu,
    submit, loadPrompt, loadSkills, loadAgents, updateClaude,
  };
}
