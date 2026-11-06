// Skills the agent's harness can load, so the overlay can offer them under "/" and a task can name the ones to use.
// Benda never loads a skill itself: the context block only names them and the harness loads them with its skill tool.
// The directories follow each harness's own discovery, from the workspace up to the repository root:
//   claude    – .claude/skills/<name>/SKILL.md, ~/.claude/skills
//   opencode  – .opencode/skill(s), .claude/skills, .agents/skills, and the same below ~/.config/opencode, ~/.claude,
//               ~/.agents (OpenCode reads Claude Code skills unless OPENCODE_DISABLE_CLAUDE_CODE(_SKILLS) is set)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { WORKSPACE } from './lib.mjs';

// the Benda skill explains Benda itself – it is loaded anyway when a task arrives
const HIDDEN = new Set(['benda']);
const MAX_DESCRIPTION = 300;

/** The workspace and its parents up to the repository root; just the workspace outside a repository. */
function projectDirs() {
  const dirs = [];
  for (let dir = WORKSPACE; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (existsSync(join(dir, '.git'))) return dirs;
    if (dirname(dir) === dir) return [WORKSPACE];
  }
}

/** `name` and `description` from the frontmatter; enough YAML for plain, quoted and folded (`>`, `|`) values. */
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    let value = field[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    fields[field[1]] = value.replace(/^(["'])(.*)\1$/, '$2').replace(/\s+/g, ' ').trim();
  }
  return fields;
}

function readSkills(dir, scope) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .flatMap((entry) => {
      try {
        const meta = frontmatter(readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8'));
        const description = meta.description ?? '';
        return [{
          name: meta.name || entry.name,
          description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description,
          scope,
        }];
      } catch {
        return [];
      }
    });
}

function skillDirs(kind) {
  const home = homedir();
  const project = projectDirs();
  if (kind === 'claude') {
    return [...project.map((dir) => [join(dir, '.claude', 'skills'), 'project']), [join(home, '.claude', 'skills'), 'user']];
  }
  const withClaude = !process.env.OPENCODE_DISABLE_CLAUDE_CODE && !process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS;
  const config = process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
  const roots = (base, scope) => [
    [join(base, '.opencode', 'skill'), scope],
    [join(base, '.opencode', 'skills'), scope],
    ...(withClaude ? [[join(base, '.claude', 'skills'), scope]] : []),
    [join(base, '.agents', 'skills'), scope],
  ];
  return [
    ...project.flatMap((dir) => roots(dir, 'project')),
    [join(config, 'skill'), 'user'],
    [join(config, 'skills'), 'user'],
    ...(withClaude ? [[join(home, '.claude', 'skills'), 'user']] : []),
    [join(home, '.agents', 'skills'), 'user'],
  ];
}

/** Skills an agent ({ kind }) sees, by name; a project skill wins over a user skill of the same name. */
export function listSkills(agent) {
  if (!agent) return [];
  const byName = new Map();
  for (const [dir, scope] of skillDirs(agent.kind)) {
    for (const skill of readSkills(dir, scope)) if (!byName.has(skill.name) && !HIDDEN.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1));
}

/** The skill names a task asks for, checked against what its agent sees; throws for one it does not. */
export function resolveSkills(names, agent) {
  if (!Array.isArray(names) || !names.length) return [];
  const known = new Set(listSkills(agent).map((skill) => skill.name));
  const unique = [...new Set(names.map(String))];
  const unknown = unique.filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`${agent.label} has no skill ${unknown.map((name) => `"${name}"`).join(', ')}`);
  return unique;
}
