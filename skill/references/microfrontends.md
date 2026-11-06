# Micro frontends with Native Federation (Angular ≥ 20, esbuild)

Tested with Angular 22.2 and `@angular-architects/native-federation` 22.2 (federation format v4).
The package version follows the Angular major. The peer dependency `@angular/build` must match.

## Setup

```bash
npm i -D @angular-architects/native-federation@<angular-version>
ng g @angular-architects/native-federation:init --project mfe-a --port 4301 --type remote
ng g @angular-architects/native-federation:init --project mfe-b --port 4302 --type remote
ng g @angular-architects/native-federation:init --project shell --port 4300 --type dynamic-host
```

The schematic switches `build`/`serve` to the NF builder, creates `federation.config.mjs` and moves the bootstrap
from `main.ts` to `bootstrap.ts` (`main.ts` first calls `initFederation`, then `import('./bootstrap')`).

## Required fixes after the schematic

1. **Skip `@angular/animations`.** Otherwise the build fails with
   `Could not resolve "@angular/animations/browser"` (optional peer, not installed). Add to `skip` in _every_
   `federation.config.mjs`:
   ```js
   '@angular/platform-browser/animations',
   '@angular/platform-browser/animations/async',
   ```
2. **Remote names in the manifest = `name` from the remote config.** The schematic writes camelCase keys (`mfeA`)
   into `shell/public/federation.manifest.json`, but registers the remotes under their `name` (`mfe-a`). Result:
   `Remote 'mfeA' is not initialized`. Change the keys to the config names and name `loadRemoteModule('mfe-a', …)`
   the same way.
3. **Expose routes instead of a component.** In the remote config:
   ```js
   exposes: { './routes': './projects/mfe-a/src/app/a/a.routes.ts' },
   ```
   The remote's standalone app uses the same routes (`app.routes.ts` → `{ path: '', children: routes }`).

## Shell routing with fallback

```ts
function remoteRoutes(remoteName: string): () => Promise<Routes> {
  return () =>
    loadRemoteModule(remoteName, './routes')
      .then((m) => m.routes as Routes)
      .catch(() => [{ path: '**', component: RemoteUnavailable, data: { remote: remoteName } }]);
}

export const routes: Routes = [{ path: 'a', loadChildren: remoteRoutes('mfe-a') }];
```

Enable `withComponentInputBinding()` in the router, so `data.remote` arrives as an input.

## Tailwind (if the project uses it)

Remote CSS is not loaded in the shell. Every `styles.css` needs `@source '../../';`, so the shell also generates the
remotes' utilities. Shared tokens live in `projects/shared/theme.css`.

## Benda + micro frontends

- One overlay in the shell covers all remotes: they share the DOM and `@angular/core` (singleton), so `window.ng`
  works for remote components too.
- The bridge recognises the micro frontend by the file path (`projects/<name>/…`); it appears as
  "Project / micro frontend" in the context.
- `loadBenda()` is called in every app. Remotes loaded in the shell do not run their `bootstrap.ts`. Remotes started
  standalone (`ng serve mfe-a`) still get the overlay.
- Keep `@strokkurio/benda-angular` in `devDependencies`: Native Federation shares `dependencies`, and the loader is too
  small to be worth sharing.
- `npm run dev` starts the bridge and all apps in parallel (`benda dev`).
- **Never `ng build` in parallel with `npm run dev`.** The NF dev server serves from `dist/<app>`. A production build
  overwrites it, the app then runs in production mode and the overlay does not load. Build first, then start the dev
  server (or restart it afterwards).
- **Unit tests:** the schematic redirects `build` to the NF builder. The `unit-test` builder then warns ("not
  supported"). Set `architect.test.options.buildTarget` to `<app>:esbuild:development` in every project.
- **API proxy:** `proxyConfig` belongs in the `serve-original` target of every app, not in `serve` (NF builder).
  Remotes inside the shell call through the shell's origin, standalone through their own. So every app needs the proxy.
- **Path alias for generated clients (`@api/*`):** NF shares every tsconfig `paths` entry as a shared mapping and only
  accepts barrels there. Files like `crm.service.ts` make the dev server abort on start with "Only barrel imports can be
  shared as a sharedMapping". Running dev servers do not notice; only a restart does. Add `/^@api\//` to `skip` in every
  `federation.config.mjs`: the client is then bundled per app.
