# Benda

**Point at an element in your running web app – an AI agent changes exactly that element in the source.**

Benda (Icelandic for "to point") puts a small overlay into your app while it runs in development. You click the
button, card or table cell you want to change, say what should be different, and your coding agent edits the right
file and line. The dev server reloads, and you see the result where you asked for it.

- **Precise:** the agent gets the selected element together with its component, source file, likely template line,
  computed styles and HTML – no hunting through the code base for "the blue button on the dashboard".
- **Works with your agent:** [Claude Code](https://claude.com/claude-code) in your terminal session or run by Benda,
  or a local model through [OpenCode](https://opencode.ai). Each task starts fresh or continues a shared session.
- **Live feedback:** while the agent works, the overlay shows the elapsed time and its current step ("Editing
  kpi-card.ts"), and the selected elements pulse until it is done.
- **Data-aware:** the **Data** tab shows where an element's data comes from and where it goes (component → store →
  API operation → mapper, for reading and writing), checks forms against the API spec, shows the app's real requests
  with spec violations and simulates slow, empty or failing responses; the **API** tab browses, versions and
  regenerates your OpenAPI clients and shows what a new API version breaks in your code.
- **Development only:** the overlay is served by a local bridge and loaded only in dev mode. Production builds never
  contain it.

Supported today: **Angular** (including micro frontends with Native Federation). Vue and React are planned.

## Quick start

In the root of your Angular workspace:

```bash
npx ng add @strokkurio/benda-angular
npm run dev
```

Open the app, start Claude Code in the project folder (`claude`), and press **⌥⇧C** (Alt+Shift+C) in the browser.

## Documentation

The full documentation is at **[strokkurio.github.io/benda](https://strokkurio.github.io/benda/)**; its sources live in
[`docs/`](docs/) and are built with [Zensical](https://zensical.org):

- [Getting started](docs/getting-started.md) – requirements, new and existing projects, the Benda skill
- [Use Benda without Claude](docs/local-ai.md) – local models through OpenCode
- [Designing with Benda](docs/designing.md), [Components](docs/components.md), [Data](docs/data.md),
  [Inventory](docs/inventory.md)
- [Configuration](docs/configuration.md), [CLI](docs/cli.md), [Security](docs/security.md),
  [Troubleshooting](docs/troubleshooting.md)

To read it locally as a site:

```bash
uvx zensical serve
```

Contributing and architecture: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
