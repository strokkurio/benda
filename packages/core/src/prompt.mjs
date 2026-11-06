// Project-specific prompt parts from benda.config.json (`prompt`). The core states no styling conventions of its own:
//   rules           – always added to the context block (string or string[])
//   templates       – task framings the user picks in the panel: [{ id, label, text }]
//   tags            – text the user adds to a task with "#", any number per task: [{ id, label, text }]
import { readConfig } from './lib.mjs';

function promptConfig() {
  return readConfig().prompt ?? {};
}

export function projectRules() {
  const { rules } = promptConfig();
  return (Array.isArray(rules) ? rules : [rules]).filter((rule) => typeof rule === 'string' && rule.trim()).map((rule) => rule.trim());
}

/** Templates and tags share their shape: [{ id, label, text }]. */
function parts(list) {
  return Array.isArray(list) ? list.filter((t) => t && typeof t.id === 'string' && typeof t.label === 'string' && typeof t.text === 'string') : [];
}

const templates = () => parts(promptConfig().templates);
const tags = () => parts(promptConfig().tags);

/**
 * What the overlay offers under "Template" and "#" and shows in its info view. A sent task names its template and
 * tags by id only; the bridge resolves the text, so a task never carries a stale copy.
 */
export function promptParts() {
  const all = templates();
  return {
    rules: projectRules(),
    templates: all.map(({ id, label, text }) => ({ id, label, text: text.trim() })),
    tags: tags().map(({ id, label, text }) => ({ id, label, text: text.trim() })),
  };
}

/** null for no template; throws for an id the config does not (or no longer) define. */
export function resolveTemplate(id) {
  if (!id) return null;
  const template = templates().find((t) => t.id === id);
  if (!template) throw new Error(`Unknown template "${id}"`);
  return { id: template.id, label: template.label, text: template.text.trim() };
}

/** [] for no tags; throws for an id the config does not (or no longer) define. */
export function resolveTags(ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const all = tags();
  return [...new Set(ids)].map((id) => {
    const tag = all.find((t) => t.id === id);
    if (!tag) throw new Error(`Unknown tag "${id}"`);
    return { id: tag.id, label: tag.label, text: tag.text.trim() };
  });
}
