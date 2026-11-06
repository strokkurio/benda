# Benda

Point at an element in a running web app, an AI agent changes exactly that element in the source. Product of
**Strokkur**, a private project (not employer work); packages under `@strokkur/*`.

- `README.md`: what Benda is, quick start, links to the docs.
- `docs/`: user documentation as a [Zensical](https://zensical.org) site (`zensical.toml`) – getting started, guides,
  configuration, CLI. `uvx zensical serve` previews it.
- `CONTRIBUTING.md`: architecture, adapter contracts, local development, release check, roadmap.

## Status

Angular is supported (`packages/core`, `packages/angular`, `skill/`); not yet published to npm. Next on the roadmap:
Vite plugin and Vue adapter. License: MIT (`LICENSE`, copied into each package because npm packs it from the package
directory).

## Rules

- **The core knows no framework.** No Angular, Vue or React specifics in `packages/core`; everything
  framework-specific goes through the adapter contract (`packages/core/src/adapter.mjs`,
  `packages/core/overlay/dom-adapter.js`). Adapters get the core's API through `ctx` and never import it.
- **The overlay is never part of the app bundle.** The bridge serves it, in dev mode only, so production builds
  never contain it and micro frontends do not load it per remote.
- **Bridge and overlay ship in the same package**, so their protocol versions always match.
- **The context block (`src/context.mjs`) and the CLI (`src/cli.mjs`) are the contract with the skill.** Change them
  deliberately and update `skill/` in the same commit.
- **Everything in English:** code, comments, docs, overlay, context blocks. Comments explain why, not what.
- **Documentation is release-ready:** it describes what Benda is and does now, for users who install it from npm. No
  notes on where code came from, no internal history, no personal paths.
- **No employer references** (names, model providers, hosts) in code, examples or docs; use neutral examples.

## Test project

`~/projects/ng-claude-designer`: Angular 22 micro frontends (shell :4300, remotes :4301/:4302), bridge :4399, CRM mock
API :4010, on `file:` dependencies to `packages/core` and `packages/angular`; `.claude/skills/benda` links to
`skill/`. `npm run dev` starts everything. Before a release, install the `npm run pack` tarballs there instead
(CONTRIBUTING.md, "Release check").

## Demo

`demo/`: a small Angular app to show Benda (app :4500, bridge :4499), see CONTRIBUTING.md, "Demo app".

## Open questions

- **Name availability:** whether `benda` is free unscoped on npmjs.org and on GitHub is not yet verified. The scoped
  packages only need the npm organisation `strokkur`, which should be claimed early: on npm a scope belongs to whoever
  creates it first, domain ownership does not count.
- **Scope:** Tafla publishes its product under its own scope (`@tafla/*`) and only reusable parts under
  `@strokkur/*`. Benda uses `@strokkur/*` for now; a separate `@benda/*` scope would follow the Tafla pattern.
- **Skill distribution:** the skill lives in `skill/` and users copy it by hand; shipping it in the npm package or as
  a Claude Code plugin (together with the hooks) would make that automatic.
