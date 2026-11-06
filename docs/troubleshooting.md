# Troubleshooting

| Symptom                                           | Fix                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| No overlay, or a red dot in the toolbar           | The bridge is not running: `npm run benda` (or `npm run dev`).          |
| Elements are shown "not inside a component"       | The app does not run in dev mode; Angular's debug API (`window.ng`) is missing. |
| Selections never reach Claude                     | Restart Claude Code in the project so it loads the hooks; check `/hooks`. |
| "Waiting for your prompt in Claude Code"          | The watch mode is off – ask Claude to start it, or type a prompt.       |
| `Port 4399 is used by …`                          | Another project's bridge or another process holds the port: change `port` in `benda.config.json` and in `loadBenda({ port })`. |
| Console: `The bridge on port … belongs to …`      | The app reached another project's bridge; give the projects different ports ([Several projects at once](configuration.md#several-projects-at-once)). |
| **Run with** is disabled: "No agent available"   | Local-only and `opencode models` lists no model matching `opencode.include`. |
| A model is missing under **Run with**            | Run `opencode models`: Benda offers what it lists, filtered by `opencode.include`. If OpenCode itself does not list the model, check its provider config; an organisation-managed OpenCode configuration can also restrict the allowed providers (`opencode debug config`). |
| A local model stops early or its tool calls fail | Give the model more context (`OLLAMA_CONTEXT_LENGTH`, and `limit.context` in `opencode.json`), and keep the task small. |
| `Timed out after 15 min`                          | Raise `opencode.timeoutMinutes` in `benda.config.json`.                 |
| Overlay gone after `ng build` (Native Federation) | The NF dev server serves from `dist/`. Do not build while `npm run dev` runs; restart it. |
| Data tab: "No request captured since the overlay loaded" | The app sent the request before the overlay was loaded (e.g. on start). Reload the page or trigger the request again. |
| Data, API tab or `benda check` behave like an older version after an update | The bridge still runs the old code: restart `npm run dev` (or the bridge). |
