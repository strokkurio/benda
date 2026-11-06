# Use Benda without Claude

Benda can run entirely on your machine: the bridge hands each task to [OpenCode](https://opencode.ai), which works
with a local model – here **Qwen3.8 27B** served by [Ollama](https://ollama.com). No Claude Code session, account or
cloud API is involved.

**1. Run the model locally.** Qwen3.8 27B needs about 18 GB of memory for its weights, plus room for the context.

```bash
ollama pull qwen3.8:27b
OLLAMA_CONTEXT_LENGTH=65536 ollama serve
```

Agent work needs a large context: the task, the project rules and OpenCode's tool definitions together can exceed
Ollama's default. With too little context, tool calls fail or the model loses the task. If you run the Ollama app
instead of `ollama serve`, set the context length in the app's settings.

**2. Register the model in OpenCode** – in `~/.config/opencode/opencode.json` (all projects) or `opencode.json` in
the project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": {
        "qwen3.8:27b": { "name": "Qwen3.8 27B", "limit": { "context": 65536, "output": 8192 } }
      }
    }
  }
}
```

Check that OpenCode sees it – the list must contain `ollama/qwen3.8:27b`:

```bash
opencode models
```

**3. Install Benda for this model** – in the root of your Angular workspace:

```bash
npx ng add @strokkur/benda-angular --agent opencode:ollama/qwen3.8:27b
```

This sets up a local-only project. It writes this `benda.config.json` and no Claude Code hooks:

```json
{
  "adapter": "@strokkur/benda-angular",
  "port": 4399,
  "claude": false,
  "defaultAgent": "opencode:ollama/qwen3.8:27b",
  "opencode": { "include": ["ollama/*"], "autoApprove": true, "timeoutMinutes": 30 }
}
```

- `claude: false` removes Claude Code from the panel: no **Send to Claude Code**, no watch mode status.
- `defaultAgent` preselects the model in the panel, so **Run with** needs no change.
- `opencode.include` offers only your local models, never a cloud model by accident.
- `timeoutMinutes` – a local 27B model is slower than a cloud model; give a run more time than the default 15 minutes.
- `autoApprove` lets the model edit files and run commands without asking, since nobody could answer its questions.
  Use it in a project under version control, so you can review and revert every change.

Benda is already installed? Run the same command; it switches the project to local-only, removes the Benda hooks
from `.claude/settings.json` and keeps your other settings. Or set the keys in `benda.config.json` by hand.

**4. Design.** Start the app with `npm run dev`, press **⌥⇧C**, click an element, describe the change in the panel
and click **Send to OpenCode** (or **⌘↩** / **⌥↩**). The toolbar shows the model's current step; when it finishes,
the panel shows its summary and the page reloads. **Cancel** stops a run.

Good to know:

- Benda passes the selected model to OpenCode also as `small_model`, which OpenCode would otherwise take from its
  own settings for side tasks such as session titles. If your OpenCode config assigns models to individual agents,
  make those local too.
- The project rules reach the model through `AGENTS.md`, which Benda passes to OpenCode as instructions – keep the
  sections `ng add` wrote there.
- To use Claude Code in the same project later, run `npx ng add @strokkur/benda-angular --agent claude`; the panel
  then offers both.
- Local models do best with small, concrete tasks ("make the value bold and one size larger") rather than broad
  redesigns. Select exactly the element to change.
- The Data and API tabs work the same way: mapping and form proposals, their implementation and migrations run with
  the selected model.
