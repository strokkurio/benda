# Benda with Angular

## How Benda finds the source

- `owner` = the component whose template declares the element (`ng.getOwningComponent`), i.e. the place to edit.
- `component` = the component whose host the element is (`ng.getComponent`), else `null`.
- The bridge's source index matches selector and class name to `@Component` declarations below `projects/`, `apps/`,
  `libs/` and `src/`, and scores template lines by shared classes, own text and tag. The file is exact, the line is a
  heuristic.
- Component info needs Angular's dev mode (`window.ng`). Without it the overlay only delivers DOM data.

## Building blocks in the Inventory

`inventory()` reads every `.ts` file below `projects/`, `apps/`, `libs/` and `src/` (no specs, no generated clients)
with the workspace's TypeScript compiler, cached per file:

| Kind | Found by |
| --- | --- |
| application, library | `angular.json` projects; a file belongs to the project with the longest matching root |
| route | exported arrays typed `Routes`/`Route[]`, named `…routes` or in `*.routes.ts`: `path`, `component`, `loadComponent`/`loadChildren` (dynamic `import()` → file and export; a call with a string argument, e.g. `loadRemoteModule('mfe-x', …)` or a helper `remoteRoutes('mfe-x')` → that remote's project), `redirectTo`, guards and resolvers, `children` |
| component, directive, pipe | `@Component`, `@Directive`, `@Pipe`: selector, inputs/outputs (signal and decorator), template |
| store, service | `@Injectable` / `@Service`; a store calls the generated client, uses `rxResource`/`resource`/`httpResource` or lives in `*-store.ts` |
| mapper, model | files `*.mapper.ts` / `*.model.ts` (the data-layer convention), one item per file |
| guard, resolver, interceptor | exported constants typed `CanActivateFn`, `CanMatchFn`, `ResolveFn`, `HttpInterceptorFn`, … |
| api-client | each generator output (orval, openapi-generator), with its spec |

The group is the feature folder below `src/app` (`group-a`, `test-page`). `places` lists each project's `src/app` and its
feature folders with the project's `prefix` from `angular.json`; route, component, directive, pipe, store, service,
guard, resolver and interceptor can be created in the Inventory (a store with its API operations). Relations: `injects` (`inject()` and
constructor parameters), `uses` (imported building blocks and custom elements in the template), `routes-to` and
`guarded-by` (routes), `reads`/`writes` (a store's operations, from the store lineage).

## How Benda reads the data layer

Static, with the workspace's TypeScript compiler (Data tab, `benda check`, impact of a new API version):

- Stores are classes a component gets with `inject()`; calls of the generated client inside `rxResource` are reads,
  others are writes of the store method around them. Generated code (orval / openapi-generator output) is never
  analysed or checked.
- Mappers are found by type: a parameter typed with a generated DTO makes a read mapper, a generated return type a
  write mapper. Untyped functions fall back to the names `toX(dto)` / `toXInput(draft)`. Field mappings come from
  the returned object literal.
- Forms: Reactive Forms (`FormGroup`, `FormBuilder`, `Validators.*`, template attributes such as `required` and
  `maxlength`) and Signal Forms (`form()` from `@angular/forms/signals` with `required`, `maxLength`, `pattern`, …).
  The submit handler's store call links each control to its draft field, the write mapper and the request field.
- Template bindings (`store.signal()` reads per line) and AG Grid column definitions locate the selected value.

Live, in the browser through `window.ng` (dev mode only, read-only – nothing is called that changes state):
the form control of the selected element or its `<label>` (Reactive or Signal Forms), the form around it with
its invalid controls, the injected stores' signals and resources, and the model object the element renders (an
object input or the `@for` item). Signal Forms list only fields Angular has already materialised; every bound
field is.

## Set up a project

Inputs are typically a stack (e.g. "Angular + Tailwind") and a brief in prose.

1. **Evaluate the brief** and turn it into decisions. Fill gaps with defaults and list them _briefly_ for the user,
   do not ask:
   - Apps: micro frontends yes/no. If yes: a shell + 1–3 domain remotes derived from the brief (default `shell`,
     `mfe-<domain>`).
   - Ports: shell first, remotes consecutive (default 4200/4201…, the user's wish wins). `ng add` picks the bridge
     port (from 4399 up) around the apps' ports and other Benda projects on this machine.
   - Styling: what the brief names (e.g. Tailwind v4, SCSS). Without one: plain CSS. Shared tokens live in
     `projects/shared/theme.css` (Tailwind `@theme`, else CSS custom properties).
   - UI language from the brief (`<html lang>`).
2. **Create the workspace** (in the target folder, Git may already exist):
   ```bash
   ng new <name> --directory . --create-application false --skip-git --ai-config claude-code --package-manager npm --defaults
   ng generate application <app> --style <tailwind|scss|css> --ssr false --prefix <short>   # per app
   ```
   If the npm registry is unreachable, ask the user. Do not switch registries on your own.
3. **Micro frontends** (if chosen): read and follow `microfrontends.md`. It lists the pitfalls that otherwise break
   the build or the loading of the remotes.
4. **Styles** in every app. With Tailwind, `src/styles.css` =
   ```css
   @import 'tailwindcss';
   @import '../../shared/theme.css';
   @source '../../';
   ```
   `@source '../../'` is mandatory with micro frontends: the shell loads only _its_ CSS and must contain the utilities
   of all remotes. Without Tailwind, import `../../shared/theme.css` from `src/styles.(s)css`.
5. **Remove the placeholder** (`app.html`/`app.css`/`app.spec.ts`) and build real, small components for the brief.
   Every visible unit is its own component, so Benda can map it cleanly. Follow the rules in the generated `AGENTS.md`
   (signals, `input()`, control flow, a11y).
6. **Install Benda** → SKILL.md, section B (`npx ng add @strokkur/benda-angular`). Then set `prompt.rules` in
   `benda.config.json` to the chosen styling, e.g. "Use Tailwind utilities and the tokens in
   projects/shared/theme.css, no inline styles.".
7. **Verify**: `ng build <app>` for every app, _then_ (never in parallel, see `microfrontends.md`) `npm run dev` in the
   background and check that all ports answer. If possible open the page in the browser (check the remote routes too).
