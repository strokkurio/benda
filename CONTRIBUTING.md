# Contributing to Benda

## Repository layout

```text
packages/
  core/       @strokkur/benda          bridge, overlay, `benda` CLI, Claude Code hooks, runner (Claude Code, OpenCode), OpenAPI index
  angular/    @strokkur/benda-angular  Angular adapter, loadBenda(), ng-add schematic
skill/        the agent skill: SKILL.md, references/<topic>.md
```

npm workspaces, no build step, no runtime dependencies: everything is plain ESM for Node ≥ 20.11 and evergreen
browsers. The schematic is CommonJS, because the Angular CLI loads schematics with `require`.

## Architecture

### Core and adapters

The core knows no framework. Everything framework-specific sits behind an adapter with two halves:

| Concern                    | Browser adapter (`/adapter.js`)        | Node adapter (`<package>/adapter`)              |
| -------------------------- | -------------------------------------- | ----------------------------------------------- |
| Element → owning component | `owner(el)`, `component(el)`, `componentChain(el)` | –                                   |
| Element → data field       | `field(el)`, optional: e.g. the grid column around el | `lineage(item)` reads it as `item.field` |
| Component → source file    | –                                      | `enrichItem(item)`: source index                |
| Element → line             | build-time attribute (planned) or –    | `enrichItem(item)`: template line heuristic     |
| Framework noise in the DOM | `hiddenAttributes`, `hiddenClasses`    | –                                               |
| Dev servers                | –                                      | `devServers(apps)` for `benda dev`              |
| Data lineage (Data tab)    | –                                      | `lineage(item)`, optional: stores, read and write mappers, template bindings, forms with their validators; without it the Data tab is hidden |
| Live state (Data tab)      | `inspect(el, hints)`, optional: form control, form, store signals and resources, the rendered model object; without it the live section shows requests only | – |
| Workspace check            | –                                      | `check()`, optional; without it `benda check` reports nothing to do |
| Inventory                  | –                                      | `inventory()` and `itemDetail(id)`, optional: kinds, items with groups and relations, detail sections; without them the Inventory says so |
| Impact of a spec version (API tab) | –                              | `impact(input)`, optional: maps the core's field diff onto mappers, store calls and form controls; without it `/specs/impact` answers 404 and the API tab shows no impact |
| Component from the catalog (Components tab) | –                     | `insert(input)`, optional: writes the catalog markup before, after or into the dropped-on element and adds its imports; refuses with status 409 when the markup binds to fields or the place is ambiguous. Used for ⌥/Alt drops; every other drop is an agent task |

The contracts are documented where they are used: the Node side in
[`packages/core/src/adapter.mjs`](packages/core/src/adapter.mjs), the browser side in
[`packages/core/overlay/dom-adapter.js`](packages/core/overlay/dom-adapter.js), which is also the fallback when no
adapter is configured.

What needs no framework knowledge stays in the core: the network capture (`overlay/overlay-network.js` patches
`fetch` and `XMLHttpRequest`, which every HTTP client ends in), matching requests to spec operations, validating
responses against the spec, building simulated responses from it (`src/api-index.mjs`, `/specs/validate`,
`/specs/simulate`) and the field-level diff of two spec versions. The live section (`overlay/overlay-live.js`) only
knows the lineage shape, the capture and the optional `inspect()`.

The overlay's composer (text field with the `/` and `#` menus, Template, Run with, sending), its task list and the
shared controls are modules of their own – `overlay/composer.js`, `overlay/tasks-view.js`, `overlay/ui.js` – that work
on the host's state object, so every browser UI of Benda offers the same agents, sessions and queue.

Adapters receive the core's API through `createAdapter(ctx)` and never import `@strokkur/benda`. Installed from a
`file:` link, an adapter's real path has no `node_modules` that could resolve the core.

### Rules

- **The core knows no framework.** No Angular, Vue or React specifics in `packages/core`.
- **The overlay is never part of the app bundle.** The bridge serves it, in dev mode only, so production builds never
  contain it and micro frontends do not load it once per remote.
- **Bridge and overlay ship in the same package**, so their protocol versions always match.
- **The context block and the CLI are the contract with the skill.** `packages/core/src/context.mjs` and
  `packages/core/src/cli.mjs`: change them deliberately and update `skill/` in the same commit.
- **Everything in English:** code, comments, docs, overlay, context blocks. Comments explain why, not what.

### Source locations per framework

| Framework | Source of the location                                                                                   | Precision                  |
| --------- | -------------------------------------------------------------------------------------------------------- | -------------------------- |
| Angular   | runtime debug API (`ng.getOwningComponent`), then the source index matches selector/class to `@Component` | file exact, line heuristic |
| Vue (planned) | `el.__vueParentComponent.type.__file` in dev mode; the Vite plugin adds the line                     | exact                      |
| React (planned) | the Vite plugin annotates JSX at build time (`data-benda-src="file:line:col"`); React 19 no longer exposes `_debugSource` | exact |

Angular's `@angular/build` accepts no plugins without a custom builder, so Angular keeps the runtime path, and
frameworks on Vite will get a more precise mapping. Hot module replacement is no obstacle: Benda only needs the dev
server to reload after a file changes, and the overlay re-resolves the selection after an update.

### Integration per framework

- **Angular:** `ng add @strokkur/benda-angular` patches the entry file (`loadBenda({ name })` after `bootstrapApplication`),
  writes `benda.config.json`, the npm scripts and the Claude Code hooks (none with `--agent opencode:…`). The bridge
  runs as its own process.
- **Vite (planned, Vue, React, Svelte, …):** one plugin with `apply: 'serve'` that injects the overlay through
  `transformIndexHtml` and starts the bridge in `configureServer` – no separate process, no patch to the entry file.

Every integration loads `/overlay.js?name=<project>` with the project name from `benda.config.json`: the bridge
refuses other names, so an app never attaches to another project's bridge on the same port. Installers pick the port
from `~/.benda/workspaces.json` (the workspaces the bridge ran in) and the ports already in use.

The bridge protocol (endpoints, state files, hooks) is described in
[`skill/references/protocol.md`](skill/references/protocol.md).

## Developing locally

```bash
npm install          # links the workspace packages
```

The [Taskfile](https://taskfile.dev) bundles the common commands: `task install`, `task test` (with the demo's
TypeScript, so no test is skipped), `task demo`, `task docs`, `task pack`. `task --list` shows all.

Test against a real project next to the checkout, with `file:` dependencies:

```bash
cd ../my-angular-app
npm i -D ../benda/packages/core ../benda/packages/angular
npx ng add @strokkur/benda-angular
npm run dev
```

npm installs `file:` directories as symlinks, so changes apply without reinstalling: reload the page for overlay and
browser adapter changes, restart `npm run dev` for bridge and Node adapter changes and for new overlay files (the
bridge serves the scripts it knows at start). Users need the same restart after updating Benda.

### Demo app

`demo/` is a small Angular app to try Benda on and to show it to others. It is installed like a user's project, with
`file:` links to the packages, and uses fixed ports: the app on 4500, the bridge on 4499. It preselects Claude Code run
by the bridge (`"defaultAgent": "claude:sonnet"`), so a task needs no Claude Code session in a terminal.

```bash
cd demo
npm install
npm run dev          # http://localhost:4500
npm run reset        # discards what agents changed in demo/src
```

The bridge accepts pages from every `*.localhost` name, so a local reverse proxy can serve the app under a name like
`https://benda.localhost`, routed to `127.0.0.1:4500`.

### Tests

```bash
npm test             # node --test, no test framework
```

`packages/angular/test/` runs the static analysis against a small generated workspace, with the cases it once got
wrong, and inserts catalog components into generated templates. The adapter parses with the workspace's TypeScript,
so the test needs one: installed in this repo, or `BENDA_TEST_TYPESCRIPT=<path to a typescript package>`; without it
the tests are skipped. `packages/core/test/` covers the core's own logic, such as how a failed run's provider error is
explained.

### Release check

A symlinked install resolves modules differently from a real one. Before every release, pack the packages and install
the tarballs in the test project – that behaves exactly like an install from the registry:

```bash
npm run pack                                   # writes dist/*.tgz
cd ../my-angular-app
npm i -D ../benda/dist/strokkur-benda-<version>.tgz ../benda/dist/strokkur-benda-angular-<version>.tgz
```

Then check in the browser: the overlay loads, a selection shows the right file and line, a task sent with the watch
mode running reaches Claude, the Data tab captures requests, `npx benda check` runs, and `ng build` output contains no
reference to the overlay.

## Roadmap

1. **Vite plugin and Vue adapter** – the file path is exact at runtime.
2. **React adapter**, on top of the Vite plugin's source annotations.
3. **Data tab per framework.** Network capture, spec validation, simulation and the spec diff are framework-free
   already. Lineage, forms, live state, `check()` and `impact()` depend on each framework's store and form conventions
   (Angular `rxResource` and Reactive/Signal Forms, Vue Pinia/composables, React TanStack Query) and are adapter
   capabilities. Until an adapter supports lineage, the Data tab stays hidden; selection, agents and the API tab work
   everywhere.
4. **Publishing** to npmjs.org from GitHub Actions with trusted publishing (provenance, no long-lived token).
5. **Claude Code plugin** shipping the skill and the hooks together; the hooks must then do nothing in projects
   without Benda.
6. **MCP server** (`benda mcp`, stdio) as a second channel next to the hooks, for harnesses without them (Codex,
   Gemini CLI, Cursor, an interactive OpenCode session): connected sessions appear under **Run with**, tools
   `get_task`, `complete_task`, `report_progress`, `propose_mapping`, lineage and specs. The hooks stay, because MCP
   cannot add context to a prompt or wake a session; the headless OpenCode runner stays without MCP, so local models
   keep their context. JSON-RPC by hand, to keep the core free of dependencies. Later, Claude Code channels could
   replace `benda wait` – once they run without a development flag.
