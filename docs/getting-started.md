# Getting started

## Requirements

- Node.js 20.11 or later
- An Angular workspace (tested with Angular 22), with any styling – tell the agent your conventions in
  [project rules](configuration.md#project-rules-and-templates)
- An agent: [Claude Code](https://claude.com/claude-code), or [OpenCode](https://opencode.ai) with a local model – see
  [Use Benda without Claude](local-ai.md)

## Start a new project

```bash
npx @angular/cli@latest new my-app --style tailwind --ssr false --ai-config claude-code
cd my-app
npx ng add @strokkurio/benda-angular
npm run dev
```

Then open the app (http://localhost:4200), start Claude Code in the project folder (`claude`), and press **⌥⇧C** in
the browser. Continue with [Designing with Benda](designing.md). Working with a local model instead? Install
with `--agent` as described in [Use Benda without Claude](local-ai.md).

**Let Claude set up the project.** With the [Benda skill](getting-started.md#the-benda-skill) installed, Claude can create the whole
workspace from a short brief – apps, micro frontends, design tokens, first components – and install Benda at the
end:

> New project: Angular + Tailwind. A customer portal with micro frontends for contracts and invoices …

## Add Benda to an existing project

In the root of your Angular workspace:

```bash
npx ng add @strokkurio/benda-angular
```

Options:

- `--project <app>[,<app>]` limits the overlay to some applications (default: all).
- `--port <port>` sets the bridge port. Default: the first port from 4399 up that no other Benda project on this
  machine uses ([Several projects at once](configuration.md#several-projects-at-once)).
- `--agent opencode:<provider>/<model>` sets up a local-only project without Claude Code
  ([Use Benda without Claude](local-ai.md)); `--agent claude` switches back.

The installer is idempotent and changes only these files:

| File                       | Change                                                                                                      |
|----------------------------|-------------------------------------------------------------------------------------------------------------|
| `main.ts` / `bootstrap.ts` | `loadBenda({ name })` after `bootstrapApplication(...)` – a no-op in production builds                      |
| `benda.config.json`        | new: adapter, project name, port, agent and API settings, a starter tag ([Configuration](configuration.md)) |
| `.claude/settings.json`    | Claude Code hooks for `UserPromptSubmit`, `PreToolUse` and `Stop` (not when local-only)                     |
| `package.json`             | scripts `dev` (bridge + all apps) and `benda` (bridge only); `@strokkurio/benda` as devDependency           |
| `.gitignore`               | `/.benda` (runtime state)                                                                                   |
| `AGENTS.md`                | short sections on the selection loop and the data-layer rules, read by every agent                          |
| `CLAUDE.md`                | the import `@AGENTS.md`, so Claude Code reads the same rules (not when local-only)                          |

If your project already has a `dev` script, the installer keeps it. Start the bridge next to your usual dev server
instead:

```bash
npm run benda        # bridge only
ng serve             # in a second terminal, as usual
```

Restart Claude Code in the project (or open `/hooks`) so it loads the new hooks.

## The Benda skill

The skill teaches Claude the selection loop, the watch mode and the data-layer rules, and how to set up new
projects. It lives in the `skill/` folder of the Benda repository. Copy or link the folder to `~/.claude/skills/benda` to
use it in all projects, or to `.claude/skills/benda` for a single project. Benda works without the skill; the
installer's `AGENTS.md` sections cover the basics.
