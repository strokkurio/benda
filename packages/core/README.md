# @strokkurio/benda

**Point at an element in your running web app – an AI agent changes exactly that element in the source.**

This is the framework-independent core of Benda: the local bridge, the in-browser overlay with its network capture
(requests matched to OpenAPI operations, validated against the spec, simulated on demand), the `benda` CLI, the
Claude Code hooks and the runner for headless Claude Code and OpenCode tasks. You normally do not install it on its
own – a framework adapter's installer adds it:

```bash
npx ng add @strokkurio/benda-angular     # Angular
```

## CLI

```bash
npx benda dev [app...]   # bridge + API mocks + dev servers (all apps, or the ones named)
npx benda bridge         # bridge only
npx benda wait           # watch mode: waits for a task from the browser, prints it and exits
npx benda show           # prints the current selection as the agent sees it
npx benda clear          # discards the current selection
npx benda proposal [file]  # submits a proposal (JSON from the file or stdin) to the Data tab or the Inventory
npx benda check [--json] [--level error|warning|info]
                         # static data-layer check of the workspace (adapter capability), no bridge needed;
                         # exits 1 when a finding reaches --level (default error)
npx benda hook <event>   # used by the Claude Code hooks: user-prompt-submit | pre-tool-use | stop
```

The bridge listens on `127.0.0.1` only, answers browser requests from `localhost` origins only, and serves the overlay
to apps in dev mode – production builds never contain it. After updating the package, restart the bridge.

Documentation, configuration and troubleshooting: see the [Benda documentation](https://strokkurio.github.io/benda/).
