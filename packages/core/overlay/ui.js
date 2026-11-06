// Building blocks shared by Benda's browser UIs – the overlay in the app and the Inventory of the bridge: DOM
// helper, keyboard labels, bridge requests and the styles of the controls both show (composer, task cards, buttons).
// Served by the bridge next to overlay.js.

// Shortcut labels follow the platform convention: ⌥⇧C on macOS, Alt+Shift+C on Windows/Linux.
export const IS_MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent);
export const KEY = IS_MAC
  ? { alt: '⌥', shift: '⇧', mod: '⌘', enter: '↩', join: '' }
  : { alt: 'Alt', shift: 'Shift', mod: 'Ctrl', enter: 'Enter', join: '+' };
export const combo = (...keys) => keys.join(KEY.join);

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children);
  return node;
}

/** Renders a shortcut as separate <kbd> keys: ⌥ ⇧ C on macOS, Alt + Shift + C elsewhere. */
export function kbdCombo(...keys) {
  return keys.flatMap((key, i) => [...(i && KEY.join ? [KEY.join] : []), el('kbd', { text: key })]);
}

/** POST to the bridge; a non-2xx answer becomes an Error with the bridge's message. */
export function createRequest(bridge) {
  return async function request(path, payload) {
    const res = await fetch(`${bridge}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  };
}

/**
 * How an agent hands in a proposal: written to a file, submitted by its path. A JSON heredoc on the command line would
 * be shorter, but Claude Code refuses shell commands with braces in quotes when it runs without the user.
 */
export const PROPOSAL_INPUT = '.benda/proposal-input.json';
export function proposalSteps(example, intro = 'Submit the proposal') {
  return [
    `${intro} without changing project files: write it as JSON to ${PROPOSAL_INPUT} (the only file you write), in this shape:`,
    JSON.stringify(example),
    `then run: npx benda proposal ${PROPOSAL_INPUT}`,
  ];
}

/** The first `max` UTF-16 units without a lone half of an emoji, which the agent would get as "\uFFFD". */
export function cut(text, max) {
  const s = String(text).slice(0, max);
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s;
}

export function elapsed(since) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Styles of the shared controls; each UI adds its own layout around them. */
export const UI_STYLES = `
  .icon { border: 0; background: transparent; border-radius: 6px; padding: 4px 7px; cursor: pointer; color: #52525b; font: inherit; }
  .icon:hover { background: #f4f4f5; color: #18181b; }
  .icon.on { background: #eef2ff; color: #3730a3; }
  a.icon { text-decoration: none; }
  .list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
  .item { border: 1px solid #f4f4f5; border-radius: 10px; padding: 8px 10px; background: #fafafa; }
  .item .head { display: flex; align-items: center; gap: 8px; }
  .item .num { flex: none; width: 20px; height: 20px; border-radius: 10px; background: #f59e0b; color: #1c1917; font-weight: 700; font-size: 11px;
    display: grid; place-items: center; }
  .item code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .meta { margin-top: 4px; color: #71717a; font-size: 12px; line-height: 1.5; word-break: break-all; }
  .item .meta strong { color: #4338ca; font-weight: 600; }
  .item .actions { display: flex; gap: 2px; margin-left: auto; }
  .item .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item .text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; }
  .item .origin { margin-left: auto; color: #a1a1aa; font-size: 11px; white-space: nowrap; }
  .item .body { margin-top: 4px; color: #3f3f46; font-size: 12px; line-height: 1.5; }
  .item .body.none { color: #a1a1aa; }
  .item .body ul { margin: 0; padding-left: 16px; }
  .item .body code { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: normal; }
  .composer { border-top: 1px solid #f4f4f5; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .compose { position: relative; }
  .menu { position: absolute; left: 0; right: 0; bottom: calc(100% + 4px); z-index: 1; max-height: 240px; overflow-y: auto; padding: 4px;
    border: 1px solid #e4e4e7; border-radius: 10px; background: #fff; box-shadow: 0 8px 24px rgb(0 0 0 / 0.15); }
  .option { padding: 6px 8px; border-radius: 6px; cursor: pointer; }
  .option.on { background: #eef2ff; }
  .option .name { display: flex; align-items: baseline; gap: 6px; color: #3730a3; font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .option .scope { margin-left: auto; color: #a1a1aa; font: 11px ui-sans-serif, system-ui; }
  .option .detail { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #71717a; font-size: 12px; }
  .menu .none { padding: 6px 8px; color: #71717a; font-size: 12px; line-height: 1.45; }
  .tokens { display: flex; flex-wrap: wrap; gap: 6px; }
  .token { display: inline-flex; align-items: center; gap: 2px; padding: 1px 2px 1px 8px; border-radius: 999px; background: #eef2ff; color: #3730a3;
    font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .token button { border: 0; border-radius: 999px; padding: 0 5px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .token button:hover { background: #e0e7ff; }
  textarea { display: block; width: 100%; min-height: calc(3 * 1.45em + 18px); line-height: 1.45; resize: vertical; border: 1px solid #d4d4d8; border-radius: 8px; padding: 8px 10px; font: inherit; color: inherit; }
  textarea:focus { outline: 2px solid #c7d2fe; border-color: #6366f1; }
  .row { display: flex; align-items: center; gap: 8px; }
  .primary { border: 0; border-radius: 8px; padding: 8px 12px; background: #4f46e5; color: #fff; font: 600 13px ui-sans-serif, system-ui; cursor: pointer; }
  .primary:hover { background: #4338ca; }
  .primary:disabled { opacity: .5; cursor: default; }
  .secondary { border: 1px solid #e4e4e7; border-radius: 8px; padding: 7px 10px; background: #fff; color: #3f3f46; font: inherit; cursor: pointer; }
  .secondary:hover { background: #f4f4f5; }
  .secondary:disabled { opacity: .5; cursor: default; }
  .copy { font-size: 15px; line-height: 1; padding: 7px 10px; }
  .send { margin-left: auto; }
  .hint { color: #71717a; font-size: 12px; line-height: 1.45; }
  .status { padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.45; }
  .status.selected, .status.pending { background: #eef2ff; color: #3730a3; }
  .status.in-progress { background: #fef3c7; color: #92400e; }
  .status.done { background: #dcfce7; color: #166534; }
  .status.waiting, .status.failed { background: #fef2f2; color: #991b1b; }
  .status.cancelled { background: #f4f4f5; color: #3f3f46; }
  .summary { margin-top: 6px; max-height: 160px; overflow-y: auto; white-space: pre-wrap; color: #14532d; }
  .link { border: 0; padding: 0; background: none; color: inherit; font: inherit; font-weight: 600; text-decoration: underline; cursor: pointer; }
  .field { display: flex; align-items: center; gap: 8px; }
  .field > span:first-child { flex: none; width: 64px; color: #52525b; font-size: 12px; }
  .field .harness, .field .session { flex: 0 1 140px; min-width: 0; }
  .field .icon { flex: none; }
  .field .fixed { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #e4e4e7; border-radius: 8px; background: #fafafa; color: #52525b;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* own arrow: the native one sits flush against the border and ignores padding */
  select { flex: 1; min-width: 0; appearance: none; border: 1px solid #d4d4d8; border-radius: 8px; padding: 6px 26px 6px 8px; color: inherit; font: inherit; cursor: pointer;
    background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2371717a' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 8px center; }
  select:focus { outline: 2px solid #c7d2fe; border-color: #6366f1; }
  .empty { padding: 18px 14px; color: #71717a; line-height: 1.5; }
  kbd { font: 11px ui-monospace, monospace; padding: 1px 5px; border: 1px solid #d4d4d8; border-bottom-width: 2px; border-radius: 4px; background: #fff; color: #3f3f46; }
  .tasks-bar { justify-content: space-between; padding: 2px 4px; }
  .pill { flex: none; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #f4f4f5; color: #52525b; }
  .pill.waiting, .pill.failed { background: #fef2f2; color: #991b1b; }
  .pill.in-progress { background: #fef3c7; color: #92400e; }
  .pill.done { background: #dcfce7; color: #166534; }
  .section { margin: 6px 4px 0; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #71717a; }
  [hidden] { display: none !important; }
`;
