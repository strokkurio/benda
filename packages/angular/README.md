# @strokkurio/benda-angular

**Point at an element in your running Angular app – an AI agent changes exactly that element in the source.**

The Angular adapter for [Benda](../../README.md): it finds the component that declares a selected element (through
Angular's dev-mode debug API), maps it to its source file and template line, shows where its data comes from and
goes to (stores, `rxResource`, read and write mappers), checks Reactive and Signal Forms against the OpenAPI spec,
reads the live form and store state, powers `benda check` and the impact of a new API version, and installs
everything with `ng add`. Micro frontends with Native Federation are supported.

## Install

```bash
npx ng add @strokkurio/benda-angular [--project <app>[,<app>]] [--port 4399] [--agent opencode:<provider>/<model>]
npm run dev
```

`ng add` calls `loadBenda()` after `bootstrapApplication(...)` in every application, writes `benda.config.json`, adds
the npm scripts `dev` and `benda` and the Claude Code hooks, and adds `@strokkurio/benda` as a devDependency. Restart
Claude Code in the project afterwards so it loads the hooks.

With `--agent opencode:<provider>/<model>` the project is local-only: browser tasks run with that OpenCode model,
the panel offers no Claude Code, and no hooks are written. `--agent claude` switches back.

Then open your app, press **⌥⇧C** or hold **⌥** (Windows/Linux: **Alt+Shift+C**) and click an element.

## `loadBenda()`

```ts
import { loadBenda } from '@strokkurio/benda-angular';

bootstrapApplication(App, appConfig)
  .then(() => loadBenda({ name: 'my-app' }))   // or loadBenda({ port: 4400, name: 'my-app' })
  .catch((err) => console.error(err));
```

It loads the overlay from the local bridge in dev mode and does nothing in production builds.
The overlay itself is never part of your bundle. `port` and `name` match `benda.config.json`; `ng add` writes both.
With `name`, a bridge of another project on the same port does not serve the overlay to your app.

Documentation, configuration and troubleshooting: see the [Benda documentation](../../docs/index.md).
