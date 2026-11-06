# Insert components from your design system

The **Components** tab lists the components of your design system, to drag into the page. Benda does not talk to the
design system itself: its MCP server is set up for your agent anyway – per project (`.mcp.json`) or per user – so the
agent reads the catalog from it.

1. **Load from design system** sends the agent a task: list every component through the design system's MCP server
   and submit them with `npx benda components`. Each entry has a name, a group, a description, the markup to insert
   and – where the framework needs one – the import (Angular: the class for the standalone component's `imports`).
   The catalog is kept in `.benda/components.json`; **↻** reads it again.
2. **Drag** a component onto the page. The top edge of an element inserts before it, the bottom edge after it, the
   middle as its last child; a line and a label show where. A click on a component inserts it at the selected element
   instead, before, after or inside as chosen above the list.
3. **The agent inserts it**: the markup at the place, the import, and the inputs the place needs – it looks them up
   with the MCP server and sets every required one, so the app still builds.

Hold **⌥/Alt** while dropping or clicking to let Benda write the plain catalog markup right away, without an agent:
the markup at the place, the import in the component's file, the class in its `imports` (a web component without
import gets `CUSTOM_ELEMENTS_SCHEMA`). A registered web component shows at once, anything else as a placeholder until
the dev server has reloaded. Benda writes only markup that needs no code and only when the place is unambiguous: when
the markup binds to fields (`[rows]="rows"`, `{{ … }}`, `@for`), the element matches several elements of the template,
its component belongs to an NgModule or a file changed meanwhile, it hands the drop to the agent instead, with the
reason. This needs an adapter that supports it (`insert()`). Benda keeps no undo of its own: use your editor or git.

For runs the bridge starts with `claude -p`, allow the MCP server's tools in `claude.allowedTools` (e.g.
`["mcp__design-system"]`); with OpenCode, set the server up in OpenCode's own configuration.
