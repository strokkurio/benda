# Configuration

`benda.config.json` in the project root, written by `ng add`. Restart `npm run dev` (or the bridge) after changing
`adapter`, `port` or `api.mocks`; the other settings apply immediately.

| Key                       | Default                       | Meaning                                                                                                                                                             |
|---------------------------|-------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `adapter`                 | –                             | framework adapter package, e.g. `@strokkurio/benda-angular`; without it the overlay shows plain DOM data                                                            |
| `name`                    | `package.json` name           | project name; the bridge serves the overlay only to `loadBenda({ name })` with the same name                                                                        |
| `port`                    | `4399`                        | bridge port; also pass it to `loadBenda({ port })`                                                                                                                  |
| `claude`                  | `true`                        | `false`: local-only – no Claude Code in the panel, the hooks do nothing                                                                                             |
| `claude.models`           | `["opus", "sonnet", "haiku"]` | models offered for runs the bridge starts (aliases or full model ids)                                                                                               |
| `claude.permissionMode`   | `acceptEdits`                 | permission mode of those runs (`--permission-mode`)                                                                                                                 |
| `claude.allowedTools`     | `[]`                          | tools they may use without asking, e.g. `["Bash(npm run build:*)"]`; `npx benda proposal`, `npx benda check` and `npx benda components` are always allowed          |
| `claude.timeoutMinutes`   | `15`                          | cancels such a run after this time                                                                                                                                  |
| `claude.bin`              | `claude`                      | path of the Claude Code executable                                                                                                                                  |
| `editor`                  | `vscode`                      | how the Inventory opens files: `vscode`, `cursor`, `idea`, `webstorm`, or a URL with `{path}` and `{line}`                                                          |
| `defaultAgent`            | `claude`                      | agent preselected in the panel: `claude` (terminal), `claude:<model>` or `opencode:<provider/model>`; local-only: the first OpenCode model                          |
| `opencode.include`        | `["*"]`                       | globs for the OpenCode models offered under **Run with**                                                                                                            |
| `opencode.autoApprove`    | `true`                        | lets the model use tools without asking (nobody could answer)                                                                                                       |
| `opencode.timeoutMinutes` | `15`                          | cancels a run after this time                                                                                                                                       |
| `opencode.bin`            | `opencode`                    | path of the OpenCode executable                                                                                                                                     |
| `prompt.rules`            | –                             | project rules added to every context block (string or list), see below                                                                                              |
| `prompt.templates`        | `[]`                          | task templates offered under **Template**: `{ "id", "label", "text" }`                                                                                              |
| `prompt.tags`             | `[]`                          | text added to a task with **#**: `{ "id", "label", "text" }`                                                                                                        |
| `api.dir`                 | `api`                         | folder with OpenAPI specs (YAML needs `yaml` or `js-yaml` installed)                                                                                                |
| `api.generate`            | detected                      | command that regenerates the API clients                                                                                                                            |
| `api.mocks`               | `[]`                          | mock servers started by `benda dev`: `{ "spec", "port" }` (Prism, needs `@stoplight/prism-cli`) or `{ "script", "port" }` (your Node script, started with `--port`) |

Environment variables: `BENDA_DEFAULT_AGENT` overrides `defaultAgent`; `BENDA_WORKSPACE` sets the project root if
Benda is started outside of it.

## Several projects at once

Each Benda project needs its own bridge port. `ng add` picks one: the first port from 4399 up that no other Benda
project on this machine has configured and nothing is listening on. To know the other projects, the bridge records
every workspace it runs in in `~/.benda/workspaces.json` (paths only; the ports stay in each `benda.config.json`).

Should two projects still share a port, nothing gets mixed up:

- `npm run dev` stops before starting any app if another project's bridge holds the port, and stops everything if its
  bridge exits. If this project's bridge is already running (`npm run benda`), it uses that one.
- `loadBenda({ name })` asks for the overlay of its own project. Another project's bridge refuses and logs a warning in
  the browser console instead, so a selection never reaches the wrong workspace.
- The bridge warns on start when another known project is configured for the same port.

## Project rules and templates

Benda prescribes no styling. It asks the agent to follow your project's conventions and design tokens; `prompt`
states them explicitly, for every agent and for **Copy prompt**. Example for a Tailwind project:

```json
"prompt": {
  "rules": ["Use Tailwind utilities and the tokens in projects/shared/theme.css, no inline styles."],
  "templates": [
    { "id": "restyle", "label": "Restyle", "text": "Change only the visual appearance; keep structure, texts and behaviour." },
    { "id": "copy", "label": "Text change", "text": "Change only the visible texts; keep markup and styles." }
  ],
  "tags": [
    { "id": "sub-agents", "label": "Sub-agents", "text": "Use sub-agents for independent parts of the task if you can." },
    { "id": "tests", "label": "Tests", "text": "Add or update the unit tests of the changed component." }
  ]
}
```

- **Rules** appear in every context block as a "Project rules" list.
- **Templates** frame a single task: the chosen template appears as a "Template" line, your text adds to it.
- **Tags** add to a task: each one appears as a "Tag" line after your text. Use them for instructions you want now
  and then, not always – those belong in the rules.
- Tasks from the Data tab use no template, tags or skills.
- **ⓘ** next to the panel's close button shows how a task is put together, in this order: template, your text, tags,
  skills, the selected elements, the project rules and Benda's closing note – and the keyboard shortcuts.

## Skills

Skills use the [Agent Skills](https://agentskills.io) format (a folder with a `SKILL.md`), which Claude Code and
OpenCode share. Benda offers under **/** the skills the agent chosen under **Run with** can load, found the way that
agent finds them, in the project directory and its parents up to the repository root, and in your home directory:

| Agent       | Directories                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Claude Code | `.claude/skills/`, `~/.claude/skills/`                                                                      |
| OpenCode    | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/`, `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/` |

Put project skills into `.claude/skills/`: both agents read it, so a skill picked there stays when you switch
**Run with**. Skills from Claude Code plugins are not listed, but Claude still uses them on its own. Benda does not
load a skill itself: the context block names it, and the agent loads it with its skill tool.
