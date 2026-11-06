<!-- benda -->
## Benda (live selection in the browser)

- `npm run dev` starts the bridge (port 4499) and all apps; `npm run benda` starts the bridge only.
- Select elements in the browser with Alt+Shift+C (Mac: ⌥⇧C). The selection lands in `.benda/selection.json` and is
  attached through the UserPromptSubmit hook as the context block "Benda – selection from the browser".
- With such a context: change the file under "File to edit" (template of the owning component), follow its
  "Project rules" (`prompt.rules` in benda.config.json) or else the project's styling conventions and existing tokens, keep
  the change limited to the selection, then summarise briefly.
- Watch mode (default once the dev environment runs): start `npx benda wait` in the background. Without a running
  watcher, tasks sent from the browser only reach Claude with the next prompt. The command exits as soon as a task
  is sent and prints it. Start it again right after finishing the task.
- `npx benda show` prints the current selection.
