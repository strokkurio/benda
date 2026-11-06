# Security

- The bridge listens on `127.0.0.1` only and rejects browser requests from origins other than `localhost` and
  `*.localhost` (always the own machine, e.g. behind a local reverse proxy), so no other website can send selections –
  and with them text – to your agent.
- The context block marks content from the page (texts, HTML) as data, not as instructions.
- `loadBenda()` does nothing outside dev mode, and the overlay is never part of the app bundle.
- A drop from the Components tab names the component; the bridge takes its markup and import from
  `.benda/components.json`, never from the browser. The page only shows the bare element as a preview.
- The network capture of the Data tab runs only inside the overlay, so only in dev mode. It keeps the last 200
  requests in the page's memory (response bodies up to about 500 KB each and about 16 MB in total, the oldest
  bodies dropped first; request bodies shortened) and sends response bodies only to the local bridge, to check them
  against the spec. Simulations are stored in the tab's
  `sessionStorage`; a banner shows them while they are active.
- OpenCode runs with `opencode.autoApprove` by default. Set it to `false` if the model must not use tools unattended.
