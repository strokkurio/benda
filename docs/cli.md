# CLI

```bash
npx benda dev [app...]   # bridge + API mocks + dev servers (all apps, or the ones named)
npx benda bridge         # bridge only
npx benda wait           # watch mode: waits for a task from the browser, prints it and exits
npx benda show           # prints the current selection as the agent sees it
npx benda clear          # discards the current selection
npx benda proposal [file]  # submits a proposal (JSON from the file or stdin) to the Data tab or the Inventory
npx benda components [file]  # submits the component catalog (JSON from the file or stdin) to the Components tab
npx benda check [--json] [--level error|warning|info]
                         # static data-layer check of the workspace against the OpenAPI specs; no bridge needed,
                         # exits 1 when a finding reaches --level (default error)
npx benda hook <event>   # used by the Claude Code hooks: user-prompt-submit | pre-tool-use | stop (no-ops when local-only)
```
