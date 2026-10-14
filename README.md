# copilot-mesh.nvim

A native Neovim interface for GitHub Copilot built around persistent UUID-backed agents:

- **Primary Copilot agent**: the generic agent initially attached to the main user-facing buffer. It has the same durable UUID, run, SDK session, mailbox, ACL, and activity-cursor model as every other agent, plus management capabilities.
- **Additional agents**: independently configured Copilot sessions that run concurrently, each with its own durable identity, history, permissions, and explicit directional communication ACL.

The Neovim plugin owns a local Node.js adapter through versioned NDJSON over stdio.
The adapter embeds the separately packaged
[copilot-mesh core](https://github.com/searleser97/copilot-mesh), which owns the
official `@github/copilot-sdk`, sessions, durable identities/ownership, mail and
steering, observation, permission enforcement and SQLite recovery state.
It is not a daemon: exiting Neovim shuts down the adapter and its SDK-owned processes.

## Requirements

- Neovim 0.10 or newer
- Node.js 22.13 or newer (including `node:sqlite`; current Node 24 recommended)
- GitHub Copilot access and a Copilot CLI login
- An authenticated [GitHub CLI](https://cli.github.com/) (`gh auth login`) for the built-in GitHub MCP server
- Optional picker UI through [Telescope](https://github.com/nvim-telescope/telescope.nvim)

The pinned core package brings SDK 1.0.11 as a local transitive dependency.
A global SDK installation is neither required nor used.

## Core and adapter boundary

There are exactly two repositories. This repository contains the Lua UI and its
TypeScript adapter: configuration/environment lookup, existing data paths, NDJSON
requests, approvals, render routing, input, pickers/completion and child-process
ownership. Core implementation and regression tests live only in `copilot-mesh`.
The scripted runtime here is a deterministic UI test fixture, not a second real
SDK host implementation.

`src/core-runtime.ts` translates the existing request dispatcher to core API v1;
`src/core-events.ts` translates transport-neutral domain events to the unchanged
Neovim wire names and rendering targets. The core never reads Neovim settings,
chooses a Neovim data directory, watches Neovim's PID or imports plugin files.
Approvals retain their original SDK-session binding; history acknowledgements
remain flow control and are sent by the adapter after Lua consumes each chunk.
No permission, identity, hook/MCP policy or observation boundary is relaxed.

`package.json` pins the core to an immutable GitHub commit, with the resolved
dependency in `package-lock.json`; this is not a public npm registry release.
`npm ci` installs and builds that independent package. To update intentionally,
change the full core commit pin with `npm install --save-exact
"git+https://github.com/searleser97/copilot-mesh.git#<full-commit-sha>"`, commit both
manifest and lockfile, then rebuild the adapter. Do not use a `file:` dependency,
sibling symlink or copied core source. See the core README for its public typed
requests/events/approval contract and minimal non-Neovim consumer.

Existing physical checkouts and Lazy names remain in place. The adapter still
supplies `stdpath("data")/native-copilot/state.sqlite`; schema17 and all SDK session
IDs, durable UUIDs, ACLs, history, receipts, mail and cursors are unchanged. No
database migration, process takeover or running-host restart is needed for this
split. Already-running hosts retain their loaded code until normally closed.

## Main-session statusline colors

The Neovim adapter reserves a shared color for each successfully opened **main SDK
conversation ID**, not for a host process, workspace, role alias, or subagent.
Opening/focusing child panes keeps the main conversation's identity. No color is
allocated while choosing a session or replaying its history.

Colors are seven-day activity leases. Opening/restoring the main conversation or
its live prompt, answer, reasoning, or tool activity renews the lease (writes are
throttled to once per minute during a turn). Statusline redraws, history replay,
status polling and child-only activity do not renew it. Expired colors become
available lazily on allocation. Restoring an expired conversation keeps its old
color only if available; otherwise it receives another color without displacing
a current lease. An idle open window stops displaying an expired color; its next
main-session activity atomically reacquires a lease.

The UI-only SQLite registry is `%LOCALAPPDATA%\copilot-mesh.nvim\session-colors.sqlite`
on Windows, or `$XDG_STATE_HOME/copilot-mesh.nvim/session-colors.sqlite` (default
`~/.local/state`) elsewhere. It is independent of Neovim data profiles and the
core's database. Transactions serialize cross-process allocation, including
simultaneous restoration of the same conversation. Twelve curated colors are
followed by farthest-distance selections in OKLab from a fixed RGB grid (228
colors total). Black/white text is selected for at least 4.5:1 contrast. Large
populations are not guaranteed perceptually distinct; capacity exhaustion and
storage errors are reported, never silently assigned colliding colors. Explicit MCP
color selections may use any six-digit RGB color; the 228-color limit applies to
automatic selection, not to that manual override.

When true color (`termguicolors`) and an already-loaded, compatible lualine are available, the plugin tints its
existing center/fill background only in the Mesh tab, including inactive splits.
It changes only foreground/background colors: no configuration files, theme
settings, text, components, separators, layout, or mode cues are replaced. Manual
theme changes and colorscheme refreshes retain the tint; ordinary editing tabs
and shutdown/failed startup use the original colors. No Neovim configuration edit
is needed. Absent, unloaded, or unsupported providers silently do nothing; the
plugin never loads lualine itself, changes `termguicolors`, or substitutes another statusline.

`setup({ session_colors = { enabled = false } })` disables
allocation/display; `session_colors.database_path` optionally overrides the shared
registry (useful for isolated tests). Reconfigure the host only after a normal
shutdown when changing this path or enabling/disabling allocation.

### Optional statusline MCP server

The built plugin includes a standalone stdio MCP server. Add an entry like this
to your own MCP configuration when desired (the plugin does not edit it):

```json
{
  "mcpServers": {
    "copilot-mesh": {
      "type": "stdio",
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_USER\\AppData\\Local\\nvim-data\\lazy\\native-copilot.nvim\\dist\\statusline-mcp.js"
      ],
      "tools": ["*"]
    }
  }
}
```

Use your actual installed plugin directory; the legacy `native-copilot.nvim`
directory above is intentional. Build with `npm run build` first. The server
uses the same default per-user registry as the plugin. If you configured a
different `session_colors.database_path`, supply that exact path using the
server's `--database` argument or `NATIVE_COPILOT_COLOR_DATABASE` environment
variable. No daemon, network listener, SDK upgrade, or core database change is
involved. Existing MCP clients must reload their configuration normally to
discover these tools; installing the plugin does not load tools into an
already-running Copilot session.

| Tool | Required arguments | Effect |
|---|---|---|
| `copilot-mesh-get-statusline-color` | `sessionId` | Read `assigned`, `expired`, or `cleared` state, including the color and expiry where applicable. Does not create a registry, allocate, or renew. |
| `copilot-mesh-set-statusline-color` | `sessionId`, `color` | Choose `#RRGGBB` (case-insensitive), renew the lease, and select readable black/white text. Reject a color leased to another conversation. Explicitly re-enable a cleared tint. |
| `copilot-mesh-clear-statusline-color` | `sessionId` | Free the reservation and persistently opt out of tinting. Activity and reopening do not undo this; only an explicit `set` does. |

**Session targeting is deliberately caller-supplied, not authenticated.** Use
the stable SDK conversation ID, not the Mesh agent UUID, run ID, target, or
alias. Copilot can obtain the `sessionId` field from the existing
`real_agent_get` tool using its *known actual own Mesh alias* (`copilot` for the
default primary). Never guess that alias when identity is uncertain: obtain
the intended session ID from the user instead. No "latest" or foreground-window
heuristic is used. The target must already be known to this color registry from
opening a main conversation in the plugin; unknown IDs fail rather than creating
reservations. This is not a security boundary: a caller supplying another known
main ID can change its color. Subagents are instructed not to call these tools,
but that restriction cannot be enforced by a standalone server with an explicit
ID parameter. An old main ID remains known even if later adopted as a child.

Updated plugin hosts observe the registry read-only every 250ms and refresh the
existing statusline colors for their current main conversation, including other
windows showing the same SDK ID. These reads do not extend leases. `clear`
restores the underlying provider colors and `set` updates the tint without
changing any text, components, or layout. Tool results always say
`display: "not-verified"`: the standalone server cannot know whether a particular
window has a compatible loaded lualine, true color enabled, or tinting disabled.
Unsupported providers remain silent no-ops. Open a new Neovim instance to load
the updated adapter; hosts already running older code are not hot-patched and
do not implement MCP refresh or persistent opt-out.

## Install

Build the host:

```powershell
Set-Location E:\copilot-mesh.nvim
npm install
npm run build
```

Install with `lazy.nvim`:

```lua
{
  "searleser97/copilot-mesh.nvim",
  lazy = false,
  build = "npm install --no-audit --no-fund && npm run build",
  config = function()
    require("copilot_mesh").setup()
  end,
}
```

### Upgrading from native-copilot.nvim

The repository is now [searleser97/copilot-mesh.nvim](https://github.com/searleser97/copilot-mesh.nvim).
Use `require("copilot_mesh")` and `:CopilotMesh*` commands in new configuration.
`require("native_copilot")` and every `:NativeCopilot*` command remain supported aliases.
Both module namespaces, including `.blink`, `.buffers`, and `.protocol`, return the same
Lua objects and host; loading both does not start another instance.

For an existing Lazy installation, change the repository string but retain its installation
identity while hosts are running:

```lua
{
  "searleser97/copilot-mesh.nvim",
  name = "native-copilot.nvim",
  lazy = false,
  build = "npm install --no-audit --no-fund && npm run build",
  config = function()
    require("copilot_mesh").setup()
  end,
}
```

This intentionally keeps the `lazy/native-copilot.nvim` directory and the
`native-copilot.nvim` lockfile key. Do not install the old and new repositories as separate
plugins, or rename/delete a checkout used by a running host. Lazy identifies managed
installations by `name`, so changing only `dir` while using a new name is not sufficient.
Existing source checkouts can likewise keep their directory name. Set their remote to
`https://github.com/searleser97/copilot-mesh.nvim.git`. Running hosts stay on their loaded
code; new Neovim instances use the update without forcing a restart.

This is a branding change, not a state migration. SQLite remains under
`stdpath("data")/native-copilot/state.sqlite`, the voice environment under
`stdpath("data")/native-copilot/voice`, and diagnostics in `native-copilot.log`.
Existing `NATIVE_COPILOT_*` / `NVIM_COPILOT_*` environment controls, `native-copilot`
filetype and buffer URIs, `native_copilot_*` buffer markers, and `NativeCopilot*`
highlight groups remain unchanged for integrations and themes. Internal implementation
and voice-helper paths retain their legacy names. No database is copied, replaced, or
re-keyed: SDK session IDs, durable agent IDs, history, mailboxes, links, and approvals
continue to use the original persisted state.

UI and rendering defaults can be adjusted in `setup`:

```lua
require("copilot_mesh").setup({
  -- Defaults to NVIM_COPILOT_CMD_RESOLVER.
  runtime_command_resolver = nil,
  stream_flush_ms = 80,
  follow_bottom = true,
  bottom_padding = 2,
  tool_summary_max_length = 120,
  timestamp_format = '%H:%M:%S',
  conversation = {
    markdown = true,
    user_label = '👨',
    copilot_label = '🤖',
    task_label = '📝',
    tool_label = '🛠️ Tool',
    scheduler_label = '⏰ Scheduler',
    day_header_format = '%A, %B %d',
  },
  prompt_queue_height = 5,
  task_detail_height = 12,
  frontend = {
    completion = "native", -- "blink" when the optional source is configured
    picker = "native", -- "telescope" only when explicitly selected
  },
})
```

`runtime_command_resolver` is a shell expression that prints the fully resolved Copilot command.
Set `NVIM_COPILOT_CMD_RESOLVER` globally so both ordinary `nvim` and specialized launchers use the
same configuration. The resolver runs once per host start with the Neovim workspace as its current
directory, allowing repository-sensitive MCP exclusions to be generated dynamically:

```powershell
$env:NVIM_COPILOT_CMD_RESOLVER = @"
& {
  . 'C:\private\Invoke-ConfiguredCopilot.ps1'
  Get-ConfiguredCopilotCommand
}
"@
```

The plugin invokes the resolver, requires a nonempty command, launches that command as the SDK
transport, and maps supported CLI session flags
(`--allow-all`, tool filters, disabled MCP servers, `--additional-mcp-config`, model, and reasoning
effort) onto SDK session configuration because SDK-created sessions do not reliably inherit those
policies from process arguments. Every session — primary and spawned agents — is built from this one
parsed native policy, so children inherit it by default (see
[Inherited native configuration](#inherited-native-configuration)). The former
`vim.g.native_copilot_command`, `NVIM_COPILOT_CMD`, and `COPILOT_CLI_CMD` inputs are not read. If no
resolver is configured, the SDK's bundled Copilot runtime is used. No agent configuration file is
required: `real_agent_create` lets an authorized Copilot session provision one durable agent at a
time.
Reusable agent recipes can be stored as ordinary prompt snippets and submitted through the prompt
buffer.

Runtime state is stored at:

```text
%LOCALAPPDATA%\nvim-data\native-copilot\state.sqlite
```

New sessions use the regular ID generated by the Copilot SDK. The plugin does not encode workspace,
agent aliases, or UI-primary state into SDK session identity. Every participant receives a durable
UUID; reconnects and recovery persist and reuse both that UUID and `session.sessionId`.

The built-in `github-mcp-server` authenticates through `gh auth token` at session startup. The
token is read directly from the GitHub CLI credential store, passed to the SDK in memory, and is
never written to plugin configuration, logs, SQLite, or conversation buffers.

## Key bindings

| Binding | Action |
|---|---|
| `<leader>ait` | Toggle the Copilot Mesh tab; starts the primary Copilot agent when needed |
| `<leader>aif` | Stop an active agent or recover an inactive one |
| `<leader>ais` | Telescope picker for overview, status, member, and view |
| `[a` / `]a` | Previous/next member conversation or prompt recipient |
| `<Enter>` in `AI Prompt` | Submit to the selected recipient |
| `<C-s>` in `AI Prompt` | Submit from insert mode |
| `<C-p>` in `AI Prompt` | Open the existing prompt-snippet picker |
| `<C-v>` in `AI Prompt` | Paste text, or save and attach a Windows clipboard image |
| `<F24>` in `AI Prompt` | Handle an image-paste signal forwarded by a terminal |
| `<C-g>v` in `AI Prompt` | Enter Insert mode and start voice dictation; press again or `<Esc>` to finish |
| `/` in an empty `AI Prompt` | Browse commands from the active Copilot session |
| `/resume` | Resume a previous Copilot session from the current workspace |
| `<Tab>` in `AI Prompt` | Complete slash-command names, aliases, choices, or directories |
| `<C-q>` in `AI Prompt` | Explicitly queue the prompt for FIFO delivery after the active turn |
| `<Enter>` in an overview pane | Select that member as the prompt recipient |
| `<Enter>` on an inline `[task]`, `[tool]`, or `[schedule]` row | Open details in a floating pane |
| `<Enter>` in the prompt queue | Pause the queue and edit the selected prompt in `AI Prompt` |
| `dd` in the prompt queue | Cancel the selected queued prompt |
| `p` in the prompt queue | Pause or resume FIFO dispatch |
| `q` / `<BS>` in activity details | Close the floating detail pane |
| `dd` in task details | Cancel the running or waiting task |

Opening Copilot Mesh first shows the existing workspace session picker with `[New Session]`
selected. Choose it to start normally, choose a previous session to resume directly, or cancel
without creating a session. Listing still starts the SDK client and loads session metadata, but
primary-session creation and environment loading wait until selection. Reopening an active UI
keeps its current session; `/resume` retains its existing behavior and picker format.

Custom mappings can call the public member-cycling function. When invoked from `AI Prompt`, it
preserves the draft and returns focus to the prompt:

```lua
vim.keymap.set("i", "<M-l>", function()
  require("copilot_mesh").cycle_member(1)
end)
vim.keymap.set("i", "<M-h>", function()
  require("copilot_mesh").cycle_member(-1)
end)
```

Prompt submission is also exposed as a public function for user-defined buffer-local mappings:

```lua
vim.keymap.set({ "n", "i" }, "<M-CR>", function()
  require("copilot_mesh").submit_prompt()
end, { buffer = true })
```

`submit_prompt()` returns `false` and displays a warning when called outside the Copilot Mesh
prompt buffer or when the prompt cannot be submitted.

Submitting with `<Enter>` or `<C-s>` while the selected Copilot is busy steers its active turn.
The conversation renders a `-- steered by user prompt --` boundary before the new instruction,
then resumes subsequent reasoning and response output under a new Copilot actor heading. Use
`<C-q>` when the prompt is independent and should wait for FIFO delivery after the active turn.

On Windows, `<C-v>` checks for an image before falling back to ordinary clipboard text. Images are
saved as uniquely named PNG files under `~/Downloads` and inserted as an
`@image("absolute-path")` reference. The host sends each referenced image through the Copilot SDK
attachment API, including when a queued prompt is retried. Configure the destination or the
bounded capture timeout in `setup()`:

Terminals that retain `<C-v>` for ordinary text paste can send `<F24>` when the Windows clipboard
contains an image. Copilot Mesh handles `<F24>` identically inside `AI Prompt`; the terminal
remains responsible for detecting the clipboard format and leaves non-image paste unchanged. A
small Win32 clipboard-format probe is available at
`tools/windows-clipboard-image-probe.rs` for terminal configurations that need it.

```lua
require("copilot_mesh").setup({
  clipboard = {
    image_directory = "~/Downloads",
    capture_timeout_ms = 5000,
  },
  voice = {
    provider = "nemotron",
    preload = true,
    system_listen_timeout_ms = 30000,
    python_command = "python",
    model = "nemotron-speech-streaming-en-0.6b",
    language = "en",
  },
})
```

On Windows, run `:CopilotMeshVoiceSetup` once to create an isolated Python environment and
download the local Nemotron streaming speech model (about 731 MB). After setup, `<C-g>v` starts
live dictation through Foundry Local and the default microphone. By default, opening the Copilot
Mesh UI starts loading the model in the background so the first dictation does not pay the full
startup cost; set `voice.preload = false` to load it on first use instead. The model stays loaded in
a persistent helper between dictation sessions. Nemotron keeps listening until you explicitly stop
it. Partial recognition appears as temporary inline text while speaking, then the finalized
transcript replaces it with editable prompt text at the cursor position where dictation started.
Starting dictation places the prompt in Insert mode. Press `<Esc>` or `<C-g>v` again while listening
to stop recording and commit the final transcript; `<Esc>` also leaves Insert mode normally. Audio
and transcription remain on the machine. The prompt winbar also provides a clickable voice
control whose label shows whether dictation is idle, loading, listening, or finalizing.

Set `voice.provider = "system"` to explicitly use the legacy Windows `System.Speech` recognizer
without installing Nemotron. Copilot Mesh does not silently fall back when the configured
provider is unavailable. `voice.system_listen_timeout_ms` controls the legacy recognizer's
one-utterance timeout.

The conversation is also the chronological activity timeline. Background tasks, environment
initialization, foreground tools, schedules, and permission decisions appear as compact timeline
rows. Environment rows are unquoted. Lifecycle status appears in a one-cell Neovim sign column:
yellow/orange `●` is processing or waiting, green `✓` completed or approved, red `✕` failed,
gray/blue `○` cancelled, red `!` denied, and `?` unknown. Signs use theme-aware diagnostic colors
while line numbers retain their normal highlight. Each row keeps a stable position and updates in
place, so completion does not reorder earlier work.

Each fresh or resumed conversation prints `[SessionId][<session-id>]` after any restored history
and before environment discovery. The session marker begins a new block with at least one blank
line separating it from preceding conversation content.

Tools, Instructions, Skills, MCP servers, Plugins, Agents, and other environment initialization use
non-actionable `[environment]` rows. The initial `Copilot environment` row remains visible and
transitions from startup to `ready`. Foreground tools use `[tool]` rows. File reads and code searches
also show their target path or query directly in the compact row, making on-demand reads of nested
instruction files such as `CLAUDE.md` visible without opening details. Other arguments remain in the
`<Enter>` floating detail pane together with complete results and errors, including failure details
for failed tools and tasks. The active Copilot heading begins only after the SDK reports that the assistant turn started, then
cycles through `writing.`, `writing..`, and
`writing...`; when the response completes, that text is replaced by its completion time. Failed
responses retain a failed gutter sign. Permission requests use a transient running gutter row while
the picker is open; the row is removed after the user approves or rejects it and is not restored
from session history. Normal prompt
submission always uses immediate SDK delivery, including while Copilot is busy, so it can steer the
active interaction. Press `<C-q>` to place a prompt explicitly in the FIFO pane instead; that pane
supports pausing, editing, and cancelling before dispatch.
Slash commands are rendered as normal `👨` turns rather than duplicated `[command]` rows; their
text output remains under `🤖`, and any work they start is represented by the resulting
task, tool, environment, or schedule rows. Use `/tasks` or
`:CopilotMeshTasks` to browse all tracked tasks and open one in the same floating detail pane.

The resolved main Copilot command defines the primary session's initial permission policy.
`--allow-all` uses the SDK's `approveAll` decision behind the lifecycle guard; otherwise
permission requests are shown in Neovim. Dynamically generated agents may inherit that behavior,
request interactive approval, or define a stricter path/tool/action ceiling. A concrete child
profile is only a ceiling: disallowed requests are denied immediately, while matching requests
still use the main policy's approval posture. They auto-approve only when the main command grants
`--allow-all`; an interactive main policy continues through the normal Neovim prompt. Managed
approval requests that pass those ceilings also remain interactive, and the captured MCP subset is
checked before either prompting or approving. A child may request `approveAll` only when the main
command grants it, so the permission-free agent management tools cannot elevate a spawned agent.
While a busy session (or a prompt awaiting its first SDK turn) is silent, the host checks the SDK's event and
pending-permission state. Missed lifecycle events are replayed once, and each pending permission is
matched back to its original full request before the same generation/session-bound evaluator
applies MCP, path, tool, managed-approval, and `approveAll` rules. Requests whose original policy
inputs cannot be reconstructed are denied closed. Permission and MCP-auth callbacks are bound to
the exact agent generation and SDK session that created them; lifecycle transitions synchronously
invalidate old callbacks and reject their pending requests before disconnect begins.
Recovery uses bounded event-log pages rather than repeatedly downloading the entire conversation.
Each pass reads at most five pages of 200 events, with one outstanding recovery per session.
This bounds event count, not bytes; an individual tool result can still be large. A hung RPC
does not start replacement recovery requests. SDK cursors preserve append order, but ephemeral
events pruned by the SDK cannot be recovered indefinitely.
Recovered events are ordered using SDK event IDs, parent links and ordered pages, not timestamps
or turn numbers (which can repeat). Earlier output/errors are shown as **Recovered earlier**
entries in Activity without changing the current response, busy state or idle-triggered delivery.
If cursor expiry or missing ancestry prevents ordering, status reports **Recovery degraded:
ordering unknown**. Backfill pauses without advancing its committed cursor and does not poll
the same gap again without new ordering evidence. Live streaming remains active. The ordering
index holds at most 20,000 metadata records; unresolved content retention is capped at 1000
events and 8 MiB of serialized payload. Oversized unapplied payloads are explicitly reported
and must be reread from the preserved checkpoint, never marked applied. These limits do not
bound an individual SDK response's transient transport allocation. Known missing event IDs
remain unresolved even if the SDK expires their cursor, rather than reporting false recovery.
A later ordering anchor
can unblock recovery; restart cannot guarantee restoration of pruned SDK events. This is a
conservative recovery limitation, not permission to assume completion or resend a prompt.
After 60 seconds without foreground progress, the host records a diagnostic in the log, even if
a recovery RPC hangs. Stall/resume diagnostics do not add Activity messages or Neovim notifications.
Recovery-ordering degradation remains available in explicit `/status`, without unsolicited
notifications or Activity messages. Silence is not proof of failure: the host does not cancel,
restart, mark idle, or resend an accepted prompt.
Redacted `native-copilot.session-health` records in `native-copilot.log` correlate host/run/session
IDs, prompt acceptance IDs, lifecycle/tool boundaries, upstream error tracing IDs, and recovery
phase/timing. They exclude prompt text, tool arguments/results, reasoning, and raw error messages.
Repeated stall log records are limited to once every five minutes. Use these records when reporting a
stall; error-only SDK logs alone cannot distinguish a model/network wait from lost host events.
`:CopilotMeshAbort` requests cancellation of the selected foreground turn without resending it.
Cancellation still requires a responsive SDK transport; an earlier unacknowledged UI command can
also delay it because host commands are serialized.

Commands mirror the primary mappings:

```vim
:CopilotMeshToggle
:CopilotMeshSelect
:CopilotMeshAgents
:CopilotMeshStatus
:CopilotMeshTasks
:CopilotMeshAbort
:CopilotMeshCancelBackground
:CopilotMeshReloadMcp
```

Selection uses `vim.ui.select` by default. To use Telescope for Copilot command, session, task,
model, MCP, and agent pickers, install it separately and opt in explicitly:

```lua
require("copilot_mesh").setup({
  frontend = {
    picker = "telescope",
  },
})
```

The plugin does not select Telescope merely because it is installed, and it preserves Telescope's
configured layout. `/resume` displays sessions oldest-to-newest, initially selects the newest
session at the bottom, and keeps that entry visible. Session metadata is enriched through the SDK
before display, so the picker uses a user-assigned name or generated summary instead of degrading
to a raw session ID. Genuinely empty, unnamed sessions receive a compact `Untitled session` label.

## Configuration

Agents are not predefined and require no external configuration file. Every agent receives
`real_agent_create`, `real_agent_resume`, `real_agent_get`, `real_agent_list`, `real_agent_get_links`,
`real_agent_update_links`, `real_agent_stop`, `real_agent_remove`,
`real_agent_list_recipients`, `real_agent_send_message`, and `real_agent_read_activity`. Each create
call provisions exactly one agent and returns its Copilot SDK session ID; there is no batch or
`real_team_*` tool API.

The former `native_copilot_*` and `real_team_*` fleet tool names are intentionally not registered as
duplicate aliases, so the model sees one unambiguous API.

Every participant receives:

- A durable internal UUID used by the runtime and UI target: `agent:<uuid>`. The primary buffer
  discovers this target dynamically; no fixed participant target exists.
- A unique user-facing alias such as `planner` or `reviewer`.
- Its own top-level Copilot SDK session and `session.sessionId`.
- Its own SQLite run, recovery state, mailbox, execution configuration, and conversation buffer.

A call to `real_agent_create` accepts the agent's identity, persona, permissions, MCP subset, and
optional `workingDirectory`,
creates its SDK session once with that complete execution configuration, and returns the final
session ID without sending a task. To change execution access, its owner must first call
`real_agent_stop`, then call `real_agent_resume` with that SDK session ID and an optional complete
replacement `permissions` profile and/or `mcpServers` subset. The same durable agent and SDK
conversation are retained. The child starts with empty peer links, which its owner can configure
after all peer session IDs exist.

Ownership and host links are separate workspace-global durable SQLite records. Permissions and MCP
configuration remain in the run's creation definition, not in the link record. The creating durable
agent identity owns the child across replacement SDK sessions; another agent cannot relink or stop
it merely by knowing its session ID.

Aliases cannot collide between the primary and any persisted additional-agent definition in the
workspace. The primary prefers `copilot` and atomically falls back to `primary`, `primary_2`, and so
on when a persisted worker already reserves a candidate. Aliases are mutable selectors, not ACL
principals: UUID targets prevent routing ambiguity, and established grants remain valid when an
alias or display name changes.

Each Neovim process owns an independent host and runtime. Active runs record their owning host
process, so another Neovim instance never recovers or modifies live work. Runs whose owning host has
exited become individually recoverable.

### Per-agent working directories

Pass `workingDirectory` to `real_agent_create` to run that SDK session in a different existing
directory. Absolute paths and paths relative to the **host workspace** are accepted. The canonical
directory (resolving symbolic links and Windows junctions) is persisted in the run definition and
used again on reconnect, stop/resume, and host restart. Omission retains the host directory and
existing discovery behavior, including for older stored agents. Resume does not change directories;
create a new agent to select a different one.

Execution location does not move durable ownership: aliases, recovery, messaging, observation,
and links still belong to the original host workspace. Active and recoverable agent details report
`workingDirectory`. Managed workers in another directory are recovered through `real_agent_resume`
or the agent recovery UI, not the host-directory SDK `/resume` picker. Adoption of unmanaged SDK
sessions remains limited to the host workspace.

Changing directories does **not** grant access. The directory must be readable within both the
creator's and child's concrete path ceilings. Outside-host directories require a host explicitly
launched with `--allow-all`; otherwise use a host launched in the desired directory. Missing,
inaccessible, non-directory, or redirected recovery paths fail explicitly before changing the
stored run. `${workspace}` and relative permission roots always refer to the host workspace;
relative tool paths refer to the agent's execution directory. Concrete creator ceilings cannot be
discarded by choosing `prompt`, and prompting inherited from a creator survives child recovery.

**Cross-directory MCP limitation:** the SDK discovery API reports names and origins, not complete
server definitions. A matching name cannot authorize a different executable, endpoint, environment,
or argument list. Sessions using another directory therefore disable automatic configuration
discovery and use only explicitly requested, launch-approved `--additional-mcp-config` definitions,
within both creator and primary MCP subsets. Subprocess MCP working directories remain anchored
to the host configuration. Configuration fingerprints, not credentials, are persisted; recovery
rejects changed same-name definitions.

Target-directory MCP discovery runs for diagnostics only. Its definitions are ignored, including
same-name overrides, and creation returns actionable `configurationWarnings`. Unverifiable servers
(including built-in-only servers) cannot be selected for these sessions. To add one, the user must
configure and approve an explicit definition on the host, restart it, and create a new agent; no
agent self-approval or extra-server approval UI is provided. The host command resolver is not rerun
in the child directory. Unexpected target discovery failures stop creation or recovery before
changing durable state and report an actionable error without echoing potentially sensitive
configuration values.

If the requested subset includes the built-in `github-mcp-server`, creation names that server in
the error instead of silently dropping it. Omit it explicitly for cross-directory agents when
there is no trusted launch definition. An explicit replacement does not inherit the reserved
built-in server's GitHub authentication handling.

This safety boundary disables automatic skills, custom-agent, and plugin discovery, and defaults
repository file hooks off in cross-directory sessions. Explicit hook approval is described below;
it does not enable broader configuration discovery. On-demand
file instruction discovery is requested through the SDK's supported
`enableOnDemandInstructionDiscovery` switch. Its actual instruction-loading behavior has not been
verified end-to-end and is not guaranteed equivalent to normal repository discovery. Agents using
the original host directory retain the normal automatic discovery behavior.

### Explicit repository file hooks

`real_agent_create` and `real_agent_resume` accept the SDK's exact `enableFileHooks` boolean.
`true` enables native repository `.github/hooks` execution independently of config discovery;
`false` explicitly disables it. On creation, omission preserves SDK defaults in the host directory
and remains off in other directories. On resume, omission preserves the stored choice, including
an explicit `false`. Resume requires an inactive owned session; it does not interrupt active agents.
The choice and canonical execution directory are persisted and included in reconnect configuration.

**Repository hooks execute commands outside the SDK tool-permission callback.** Read permission,
selecting a working directory, MCP approval, and `--allow-all` alone do not authorize this opt-in.
The user must explicitly trust each exact directory in the host's Neovim setup, then restart that
host normally to apply it:

```lua
require("copilot_mesh").setup({
  file_hook_directories = { [[E:\sydney2]] },
})
```

This list grants permission to request hooks, not automatic enablement. The Node adapter uses the
equivalent `NATIVE_COPILOT_FILE_HOOK_DIRECTORIES` JSON string array; independent core consumers
pass `MeshHostOptions.fileHookDirectories` explicitly. Approval is exact-directory,
not recursive, and canonical paths are checked again on recovery. Removing an approval prevents
future hook-enabled connections; it does not terminate existing processes. Resume with
`enableFileHooks: false` to persist revocation for a stopped agent.

The host must also have `--allow-all`; the creator and child must have unrestricted, non-prompting
execution permissions. Concrete permission profiles and inherited prompting are rejected because
their tool, path, command, network, Git, or external-action restrictions cannot constrain native
hook processes. Non-primary creators additionally need their own hook approval for that same
directory. Hook trust is separate from MCP trust: cross-directory `enableConfigDiscovery` remains
false, explicit MCP definitions remain pinned, and disabled-server restrictions are unchanged.
Trust the repository's hooks themselves, including their subprocesses and external effects.

For an existing stopped worker, its owner can call:

```text
real_agent_resume({ sessionId: "<existing SDK session ID>", enableFileHooks: true })
```

Omitting `permissions` and `mcpServers` preserves both. Lifecycle delivery is handled by the SDK,
not synthesized by the host. Configuration regression tests alone do not prove that a repository
hook ran or that its application-specific identity state was repaired.

In a native SDK 1.0.11 / CLI 1.0.90 check against Sydney, `sessionStart` ran on the first
submitted prompt, not on the create/resume RPC itself. Cold resume with `suppressResumeEvent: true`
still delivered it with the correct SDK identity. Sydney's runtime index and session state matched
during the turn; its native `sessionEnd` then cleaned them up. Therefore a successful resume alone,
or an absent index after a completed turn, is not proof of the active turn's binding.

#### Persistent-session lifecycle limitation

**Native `sessionEnd` is not currently a reliable persistent-session termination signal.**
On 2026-10-07, isolated native-hook probes reproduced the same behavior with SDK 1.0.11 /
runtime 1.0.90 and released SDK 1.0.17 / runtime 1.0.93:

| Operation on one SDK session ID | Observed native hooks |
| --- | --- |
| Create RPC | No startup hook yet |
| First ordinary prompt | Prompt hook, `sessionStart(source=new)`, `agentStop`, `sessionEnd(reason=complete)` |
| Second ordinary prompt, same live connection | Prompt hook, `agentStop`, another `sessionEnd`; no new `sessionStart` |
| Abort an active turn | SDK `abort` acknowledged; native `sessionEnd(reason=complete)`; subsequent prompt succeeds |
| Harmless custom tool throws | Model handles the tool failure; subsequent prompt succeeds; no native `errorOccurred` in this probe |
| Disconnect after idle / stop the probe runtime with a live idle session | No additional native `sessionEnd` |
| Cold resume, with `suppressResumeEvent` either true or false | `sessionStart(source=resume)` on first prompt, then the same per-turn end behavior |

Every captured native hook carried the original SDK session ID and the isolated repository cwd.
These were real subprocess hooks, not SDK hook callbacks or mocked serialization tests. The
recoverable tool-error check does not establish behavior for fatal runtime crashes.

The [GitHub hook reference](https://docs.github.com/en/copilot/reference/hooks-reference)
distinguishes `agentStop` ("The main agent finishes a turn") from `sessionEnd` ("The session
terminates"). Public SDK session documentation separately says abort leaves the session usable,
and disconnect releases its in-memory resources while preserving resumable disk state. Neither
inspected SDK release exposes `deferSessionEnd` in its session configuration or request serializer.
Whether per-turn native delivery is intentional for SDK invocations needs upstream clarification;
the documented vocabulary alone does not establish a supported persistent-hook mode.

The plugin's ordinary `session.idle` path clears turn state and schedules queued messages; it
does not disconnect. Existing live connections are reused. Teardown occurs on explicit agent
stop, connection/recovery failure, primary replacement, configuration reconnect, or host shutdown.
The standalone probe below reproduces the issue without loading the plugin runtime at all.
`suppressResumeEvent` suppresses the SDK resume event, not native end hooks; toggling it is not
a remedy. SDK 1.0.17 changes disconnect's wire operation from `session.destroy` to `session.detach`,
but the tested upgrade still emits per-turn end hooks. No dependency upgrade or unsupported
runtime option has been applied as a workaround.

The older bundled native package 1.0.80 contains a readable per-turn `finally` branch that calls
`nativeHookProcessor.postSession` unless its internal `sessionScalarDeferSessionEnd` is set or
the session is a subagent. It also contains internal deferred-shutdown handling. That explains
the earlier hypothesis but is not a public SDK API or proof of the exact private call graph in
the newer executables: the inspected 1.0.90/1.0.93 platform releases ship compiled executables,
not that readable `app.js`. The live, plugin-independent traces establish their actual behavior.

Run the opt-in diagnostic from a **copilot-mesh core clone** with an explicitly chosen executable:

```powershell
node test\native-file-hooks-lifecycle.mjs --cli (Get-Command copilot.exe).Source --model gpt-6-astra --expect-persistent
```

Use an available model for `--model`. Optional `--sdk <absolute-path-to-dist\index.js>` selects
another SDK release without changing the project's dependencies. The script starts only its own
stdio runtime processes, creates an isolated Git repository under `.e2e-artifacts`, and records
authentic JSONL hook inputs plus `result.json`. It makes model calls, denies ordinary tool
permissions, disables configuration discovery and the built-in GitHub MCP server, and pins an
empty MCP set. The only allowed custom tool intentionally throws a harmless error. Hook commands
only append local trace records; no external repository hooks or application workflows are used.
It deletes its own SDK test conversation afterward and retains trace files for inspection.
The unpacked-release comparison tests stdio behavior, not full upgrade or embedded-FFI compatibility.

With `--expect-persistent`, the command currently **fails** on both tested version pairs because
the first ordinary turn already emitted `sessionEnd`. Omitting that option collects observations,
not proof of persistent-session correctness. This manual diagnostic is intentionally excluded
from `npm test`. An upstream correction needs native coverage for two sends, abort-and-continue,
recoverable errors, and cold resume, with deferred end delivery exactly once at genuine closure.

Applications whose end hook seals workflow outcomes or deletes execution identity must not treat
this as repaired by enabling hooks, suppressing resume events, delaying a marker, or restarting
the host. A separately approved integration would need an explicit, directory-scoped persistent
host profile with authentic session/connection-generation evidence: record nonterminal native
turn boundaries without performing terminal cleanup, and reserve terminal actions for explicit
workflow finalization, authenticated agent closure, or genuine durable-owner death. The workflow
delivery worker, root-state transition, and identity cleanup must agree on that distinction.
Other hosts must retain their existing semantics. This is an integration proposal, not an
implemented bypass or permission grant; no repository workflow code is changed by this plugin.

### Inherited native configuration

The host parses the resolved main Copilot command **once** into a single, typed native policy
object (`NativePolicy`) and builds every session — the primary agent and each spawned agent —
from one shared scaffold (`nativeSessionScaffold`). This is code-level reuse, not merely equivalent
behavior: there is exactly one parsed policy and one base builder, and agent-specific settings are
applied as overlays on that shared object. By default a child agent therefore receives exactly the
same native configuration as the main agent:

- **Working directory / config discovery / instruction files** — by default every session uses the same
  workspace `workingDirectory` with `enableConfigDiscovery`, so workspace `.mcp.json`, discovered
  instruction files, and skills resolve identically for children and the main agent.
- **MCP configuration** — servers discovered from the workspace plus every `--additional-mcp-config`
  source (parsed once into a single native MCP-server record) are inherited by all sessions. A
  user-provided `--additional-mcp-config` that is missing, unreadable, invalid JSON, or the wrong
  shape surfaces a clear error rather than being silently dropped. The reserved
  `github-mcp-server` name receives a `gh auth token` only when SDK discovery identifies the unique
  built-in server and its requested HTTPS URL exactly matches an allowlisted GitHub Copilot MCP
  endpoint. User, workspace, plugin, and launch-provided overrides fail closed.
- **Native tool / MCP policy** — `--available-tools`, `--excluded-tools`, and `--disable-mcp-server`
  from the main command apply to every session as a shared ceiling. A bare `*` pattern is normalized
  into SDK-valid source-qualified patterns (`builtin:*`, `custom:*`, `mcp:*`) before any session
  config is derived.
- **Model / reasoning effort** — `--model` and `--reasoning-effort` from the main command become the
  default for every session, including spawned agents.
- **Permission policy** — `--allow-all` uses the SDK `approveAll` decision through a
  generation/session-bound handler for the main session. Child modes may inherit it or force
  prompting; a concrete child profile narrows what is eligible but does not independently approve
  a request. When a profile disables `gitWrite`, shell decisions use the SDK's parsed executable
  identity and `readOnly` classification, so Git writes remain blocked through `git.exe`, absolute
  executable paths, and Git global options without confusing unrelated commands that merely
  mention Git.

Agent settings only **narrow or deliberately override** this single source of truth; they never
recreate a parallel definition:

- Delegated creation, adoption, and managed recovery are also bounded by the immediate caller.
  A child cannot receive a broader approval posture, tool/path/action profile, or MCP subset than
  its creator effectively has, even when the native host ceiling would allow more.
- A member's `permissions.tools.allow` becomes its `availableTools` allowlist and is **not** widened
  back by the native list. It must be a semantic **subset** of the native tool ceiling (an empty
  native allowlist means unrestricted; bare `*` and source wildcards such as `builtin:*` are
  expanded and matched). A member allowlist that requests tools outside the native ceiling is
  **rejected** when the agent is spawned or updated rather than silently intersected. Native
  `excludedTools`/`disabledMcpServers` still merge as a ceiling.
- An agent's captured MCP ceiling is the primary server set visible when it is created. Its
  `mcpServers` field may only narrow that set; when omitted, the captured set is the effective
  allowlist. Every child connection also explicitly disables currently visible primary servers
  outside that effective allowlist, so ordinary reconnecting cannot acquire servers added later.
  An explicit stopped-agent resume that supplies `mcpServers` recaptures the primary's current
  server ceiling and validates the complete replacement subset against it.
- An agent's `model` / `reasoningEffort` / `reasoningSummary` override the inherited defaults.
- Agents cannot supply replacement MCP definitions through the management tools. In a different
  working directory, inherited explicit definitions are pinned and directory-local same-name
  replacements are not loaded.

Omitting an override inherits the shared native default; omitting `mcpServers` specifically uses
the agent's durable primary-server snapshot rather than servers added later.

Neovim always starts one generic primary agent that stays connected for the host lifetime. Opening
Copilot Mesh starts a fresh SDK conversation; previous primary conversations are never resumed
automatically and remain available only through explicit `/resume`. The durable primary UUID,
alias, ACLs, mailbox, and monitor relationships carry forward to the fresh conversation. Agents
are created one at a time with `real_agent_create`, either from an ordinary prompt or from a saved
prompt snippet. Team prompts create every member with its final execution configuration, collect
the returned SDK session IDs, configure the intended peer links with `real_agent_update_links`, and
only then send initial prompts.

`real_agent_update_links` atomically replaces only the child's outgoing communication and
observation targets and the owner's links to that child. All relationship targets are Copilot
session IDs. Link changes are handled entirely by the host and never reconnect or recreate the SDK
session.

Recovery reconnects one agent run at a time with its durable UUID, SDK session ID, stored definition,
mailbox, and communication and observation ACLs. With no overrides, it also retains the original MCP
ceiling exactly. An inactive owned agent may instead atomically persist a complete replacement
permission profile and/or MCP subset as it transitions to active; validation failure leaves it
stopped and unchanged. Active runs owned by another Neovim instance are never offered. A persisted
SDK session may be owned by historical runs of only one durable agent UUID. Session pickers hide
every recoverable or currently-starting owned session; primary replacement accepts only an unowned
session or one already owned by that same primary UUID, and worker recovery rejects live,
externally in-use, or differently owned sessions.

The primary agent is reclaimed through the same stored context/session path on host restart.
`/resume` keeps its durable agent UUID and dynamic UI target while creating a coherent replacement
run for the selected SDK conversation. If a managed SDK session is missing, the host reports the
failure instead of silently creating an empty conversation and losing schedules or state.
Historical replay transfers only fields required to reconstruct the visible transcript and sends
them in bounded ordered chunks. The host keeps only one chunk outstanding until Neovim acknowledges
that it has rendered it, bounding Neovim's replay queue and decoded-history memory. Neovim renders
each chunk in cooperative approximately 8 ms slices so redraw, scrolling, and input continue
between slices. During replay, the visible conversation follows the newest rendered content at
throttled slice boundaries. Fold evaluation uses a cached row map instead of scanning every fold
extmark for every line during final reconciliation, leaving one complete continuously scrollable
conversation buffer without a long end-of-replay pause. Historical Tool rows load
their potentially large result payload only when their details window is opened.
Reasoning replay prefers standalone readable reasoning events, then normalized `reasoningText`,
then explicitly typed provider summary blocks; opaque, encrypted, and signature fields never cross
the UI boundary.
The old primary run retains its pending mail until the selected SDK session is connected; retiring
the old run, adopting its mail, and making the replacement recoverable then happen in one SQLite
transaction. If replacement fails after activation, pending mail is adopted back into the restored
run atomically; the failed replacement remains available for diagnostics but is excluded from
future startup recovery.

### Validation

A generated agent request is rejected before startup when it contains duplicate or unsafe aliases,
unknown or self-referential communication or observation targets, unavailable MCP servers,
malformed permission policies, or an `approveAll` request exceeding the primary policy ceiling.
Operating prompts and display names need not be unique; aliases must be unique across active and
recoverable agents. `caller` is reserved as a request-local selector and cannot be assigned to a
new agent.

### Models

`model`, `reasoningEffort`, and `reasoningSummary` are optional per generated agent.
`reasoningSummary` accepts `none`, `concise`, or `detailed` and defaults to `detailed`. When omitted,
the Copilot runtime chooses its default model.

## Messaging and recovery

Every agent, including the primary, receives the same stable communication tools:

- `real_agent_list` returns directly owned active and recoverable agents. Recoverable entries include
  the Copilot SDK session ID used for recovery. An agent open in another process is reported as
  `active_elsewhere` rather than being offered for recovery.
- `real_agent_resume` reconnects exactly one session by SDK session ID. A known managed session
  recovers its existing durable identity and configuration. While that session is stopped, optional
  `permissions` and `mcpServers` arguments replace those complete execution settings within the
  caller's effective permission/MCP ceilings and the primary host's native ceilings. An unowned
  local session is adopted as a generic real
  agent with inherited runtime configuration (or supplied replacements) and no initial
  communication or observation links; it preserves the existing conversation instead of creating a
  replacement SDK session. A session already open in another Neovim or Copilot process must be
  closed there first.
  An inactive former main/primary session can also be adopted by passing its SDK session ID.
  This opens the same conversation as a new real agent in the current workspace, without replacing
  the current main buffer or transferring the former primary's children, mailbox, or communication
  links. Existing adoption permission/MCP ceilings and file-hook approval rules still apply.
  Active primary sessions cannot be taken over. If adoption fails, the former primary's session
  reservation is restored.
- `real_agent_stop` disconnects one directly owned active agent while preserving its SDK session,
  durable identity, history, mailbox, and links for later recovery. `real_agent_remove` remains a
  backward-compatible stop alias.
- `real_agent_list_recipients` returns the agents it may message or observe with their alias,
  durable UUID, current SDK session ID, runtime state, and directional grant flags.
- `real_agent_send_message` sends to one of those recipients by alias, UUID, or current session
  ID.

There are no generated per-recipient tools. The model may retain aliases such as `reviewer1` and
`reviewer2` in conversation memory or a workspace coordination file, but the host's SQLite-backed
agent registry remains authoritative for delivery. The host resolves the supplied identifier and
rechecks the source agent's current `canTalkTo` ACL; possessing or guessing another session ID never
grants access. Identity resolution and authorization are separate: a known but unauthorized
alias, UUID, or session ID returns an explicit communication-rule denial, while an identifier that
does not resolve to an active managed agent returns an unknown-recipient error.

`real_agent_update_links` accepts `canTalkToSessionIds` and `canObserveSessionIds`; the host resolves
active or stopped managed sessions immediately to durable UUID ACL principals. Every grant is an
ordinary directional link: ownership controls lifecycle administration, but creates no implicit
communication or observation edge. An agent may replace its own outgoing links to directly owned
children, or replace the outgoing links of one directly owned child.

Resolved grants are persisted as durable agent UUIDs, not aliases. Renaming an alias therefore does
not invalidate an established link. Stopping an agent leaves UUID-backed grants intact and marks
that recipient inactive; recovering the same durable agent makes the links usable again.

## Passive agent activity

`canObserve` is independent from `canTalkTo`. It grants one agent permission to call
`real_agent_read_activity` for another active UUID-backed agent without sending that
session a prompt. The primary agent uses the same outgoing `canObserve` set as every other caller.
ACLs are revalidated on every read and may be replaced dynamically with
`real_agent_update_links`.

The activity tool reads the target's authoritative SDK event log with bounded cursor pagination and
returns raw chronological events so the caller can infer status generically. Completed user and
assistant messages, intents, reasoning summaries emitted by the model, tool activity, errors, and
future SDK event types pass through unchanged. Streaming message and reasoning deltas are omitted
because their completed durable events already contain the useful content. Private hidden
chain-of-thought is never exposed by the SDK.

Each caller-target pair has an independent acknowledged SDK event-log cursor. A read returns
`nextCursor`; the caller passes it as `acknowledgeCursor` on its next call. Only that later
acknowledgement becomes durable, so a page lost during result delivery is replayed instead of
silently skipped. Reads use the SDK's bounded event-log pagination rather than loading the complete
session history on every request. Both cursor keys are durable agent UUIDs, and every result
includes the target `agentId`.

Results are bounded to 100 complete events and approximately 30 KiB of serialized content. If more
remains, `hasMore` is true and the next acknowledged call continues from the returned cursor. A
single oversized event is returned whole rather than corrupted by truncation.

Messages store UUID-backed source/target identities and are written transactionally to SQLite
before delivery. Authorized peer messages automatically steer busy recipients using the same SDK
`immediate` send path as foreground user prompts. The SDK injects them at its next supported
processing boundary; it does not preempt a running tool or model call, abort, or restart the task.
Idle recipients wake normally. The send tool returns `status: "queued"` and
`deliveredToMailbox`, not evidence that the recipient has processed the instruction. Messages shows
**Queued for delivery** and then **Accepted by SDK**; the conversation labels actual SDK steering
events with **(steering)** and preserves the sender's identity. Acceptance is not processing,
completion, or a guarantee that a model will act on an instruction.

Each wake claims at most one message, with 100 ms between scheduled mailbox wakes. Peer messages
are FIFO within each recipient, including across multiple senders; unrelated recipients drain
independently. SDK sends to a recipient are serialized with foreground user sends. Explicitly queued
user prompts retain their existing idle-only behavior and do not block peer steering. Agents should
reply only when needed, not automatically acknowledge acknowledgements.

Schema v17 journals each peer transmission before calling the SDK and stores its acceptance receipt.
An accepted peer message is never resent simply because lease completion or a connection transition
failed. A known receipt can complete a newly claimed lease after recovery. The pinned SDK has no
caller-supplied idempotency key: if a send fails or the host exits after transmission starts but before
acceptance can be confirmed, delivery fails explicitly rather than guessing and duplicating work.
Inspect the recipient's SDK history before manually retrying such an unconfirmed message.
Failures before transmission retain bounded-backoff retry.
Every claim has a random attempt token bound to its exact run and target. Completion, failure, and
release require that current unexpired token while the row is still `delivering`, so a late SDK
send from a superseded generation cannot complete mail that was reset or adopted elsewhere.
Interrupted delivery returns to `pending` after restart, then peer receipts are reconciled without
another send; an unconfirmed prior attempt is reported as failed without automatic redelivery.

Copilot’s session store remains authoritative for full conversation history. SQLite stores
UUID/session mappings, all agent runs (including the primary), UUID-backed communication and
observation rules, durable mail, delivery leases, and per-caller activity cursors. Schema v11 adds
explicit startup durability to v10 state; schema v12 adds generation-safe delivery lease tokens
and indexed durable SDK-session ownership checks; schema v13 repairs startup and ACL state in
databases already stamped as v9-v12; schema v14 reruns and extends the primary repair for databases
already stamped as v13 and adds durable staged-primary claim links.
Migrations take the SQLite write lock before reading the schema version, migrate v8 worker
definitions and mailboxes in place, and choose the newest legacy Standard run that owns a persisted
SDK session as the primary source. Undelivered Standard mail and Standard ACL mappings move to that
UUID in the same migration transaction before startup classification. If no Standard session
exists, the newest Standard run supplies a staged primary UUID whose pending mail and ACLs are
retained until a fresh primary session adopts them. Migrations also enforce primary/non-primary
alias reservations atomically and keep failed or taskless startups out of recovery selection.
Before upgrading an older schema, the host checks the owner PID of every active run while holding
that lock. If any owner process is still live, startup fails with a restart-required error and the
migration transaction rolls back without rebuilding leases, resetting deliveries, or classifying
startup rows. Close every Neovim instance using the database and start again to perform the
upgrade; after the schema version advances, newly started older hosts reject the newer database,
while the v12 lease constraints make a concurrently started legacy writer fail closed instead of
storing an incompatible lease. The legacy-primary repair recognizes databases where an earlier
migration left a failed or staged generic primary beside legacy Standard rows. It retains the
generic primary UUID, alias, and ACL identity when possible, transfers the newest usable Standard
SDK session into that run, adopts pending mail, restores Standard ACL selectors, and disqualifies
the obsolete rows before classification and ghost scrubbing. If no generic identity exists, that
Standard run is converted in place. Ambiguous identities, malformed ACL records, and conflicting
session ownership abort the migration instead of being guessed through. The v13-to-v14 repair also
handles workspaces where no Standard row remains: a migration-failed or sessionless generic primary
is reconstructed with its durable UUID, a valid primary definition and alias, and every surviving
ACL mapping. When that generic identity has no usable session, a surviving Standard session is
adopted; otherwise the repaired identity is staged for a fresh SDK session. Mail is revived only
when the primary run carries the exact
incomplete-migration reason and the message update timestamp matches that migration failure;
unrelated failed mail stays failed, and missing evidence is surfaced rather than guessed. Neither
the v12-to-v13 nor v13-to-v14 upgrade rebuilds v12 delivery leases. A non-primary run is
recoverable only when it has both a persisted SDK session and an accepted first user task;
session-only rows are failed, release their
aliases, and are removed from related ACLs. On interrupted startup, a stale non-primary
`session_created` run is defensively promoted only when that ordered first user task is already
delivered. Primary rows retain their session-only startup semantics. A session-id index and startup
consistency check reject persisted ownership by multiple agent UUIDs while allowing historical
runs of the same UUID. The migration is idempotent and does not duplicate conversation or SDK
event history.

A staged primary is claimed and its successor run is inserted in one SQLite write transaction.
The predecessor and successor share a random claim token and an explicit predecessor link owned by
the host PID, while alias fallback (`copilot`, `primary`, `primary_2`, ...) is selected under the
same lock. A competing live host cannot reuse that staged UUID. Completing startup retires only the
linked predecessor, never another active primary. Interrupted-work recovery releases a dead
sessionless claim for retry, or promotes a claimed successor that had already persisted its SDK
session, adopts the predecessor mailbox, and leaves that successor resumable.

Restarting Neovim reclaims the primary agent and surfaces recoverable additional agents, but it
does not automatically restart those additional agents or spend credits on their behalf.
The loading buffer is displayed before the Node host starts and remains visible until history or
environment content has actually been rendered. It reports and animates the current startup stage,
including primary-agent preparation, runtime connection, session creation or opening, session
configuration, history loading, and environment discovery. Startup failures replace the progress
message with the concrete host error instead of leaving an empty or indefinitely loading pane.

## Rendering and observability

Conversation, mailbox, and status views are native plain-text `nofile` buffers with no Markdown
renderer dependency. Conversation message bodies receive lightweight, non-concealing Markdown
highlights for headings, emphasis, inline and fenced code, lists, quotes, and links after each
message completes. The underlying text and line layout never change; set
`conversation.markdown = false` to disable the highlights. User, Copilot, and Task turns place
emoji-only `👨`, `🤖`, and `📝` actor signs in the gutter, while each authored block names its actor
before the timestamp or Copilot's
animated `writing...` state. Delivered inter-agent prompts appear inline in the recipient's
conversation with the sender's name and Copilot sign; the Messages view remains the durable
delivery audit log. Actor signs, along with Tool and Scheduler headings, are configurable through `conversation`
setup options and must fit within Neovim's two-cell sign width. Inline
reasoning remains part of each conversation buffer as unlabeled text using Neovim's `Comment`
highlight group. Each reasoning section is a native fold that starts open and supports normal
fold commands such as `zc`, `zo`, and `za`. Errors remain visible in their related activity rows
and detail panes.
The buffers retain normal Neovim navigation, search, yank, folds, marks, and window mappings.

Participant signs use colorscheme-aware highlight groups: `NativeCopilotUserHeader` links to
`DiagnosticInfo`, `NativeCopilotAssistantHeader` links to `Special`, and timestamps or writing state
use `NativeCopilotHeaderMeta`, linked to `Comment`. Override any group after setup with
`vim.api.nvim_set_hl()` to choose explicit colors.

Streaming deltas are batched and appended only to the changed buffer tail. Configure the batching
interval with `stream_flush_ms`. Conversation content is flush with the buffer text column; actor
and lifecycle identity remains in the dedicated sign column.

Conversation windows move to the final line when opened, switched, or reopened. Subsequent
streaming and timeline updates preserve the cursor line while it remains visible. When continued
following would push that line outside the viewport, the cursor advances to the top visible line
so the transcript can keep following EOF. Explicit cursor movement or scrolling away disables
following; moving the cursor to EOF restores it. `bottom_padding` controls the preferred display
rows below followed output, and `follow_bottom = false` disables automatic viewport following.
Switching reuses the existing conversation buffers and fold metadata. Fold setup leaves unchanged
window options alone and calls the Lua fold function directly, avoiding redundant full-transcript
fold recalculation and per-line module-table conversion.

Conversation turns and timeline rows show local timestamps. Tool rows show their lifetime in place
as `[start - …]` while running and `[start - end]` when terminal; their status is represented only
by the colored gutter sign, never duplicated as `processing`, `completed`, or `failed` text. Other
timeline events retain a single event timestamp, and a streamed Copilot response receives its final
timestamp when the response completes. Reasoning summaries omit timestamps. Customize the display
with `timestamp_format`, using an `os.date` format string. The conversation starts with a local-date
divider and adds another before the first newly rendered item after midnight.
`conversation.day_header_format` controls that divider without repeating the date on every row.
Shell Tool rows update in place and omit their native call ID while they remain ordinary synchronous
invocations. When an SDK Task is correlated with a Tool, that original row gains the concrete Task
ID at the end of the row and the latest background metadata in its detail pane. Native Tool call IDs
remain internal for every Tool row; extmark metadata preserves clickability without displaying them.
Non-clickable lifecycle notices render as Task-authored messages and
use the concrete runtime identity, such as `shell_cmd_<shell-id>` or `agent_<agent-id>`, without a
status icon. During history replay, unmatched Task-authored messages render at their original event
position; prompts already represented by `task`, `write_agent`, or `real_agent_send_message` Tool
rows are suppressed in place rather than collected and appended after the replay. A transition from
`executionMode: "sync"` to
`executionMode: "background"` produces a separate `moved to background` notice; no transition is
inferred when the first observed snapshot is already background-managed. The original Tool row
remains the clickable source for arguments, results, and correlated background details.
When reasoning or answer text follows a Task-authored lifecycle message, a new Copilot actor header
is rendered so content never appears to belong to the Task actor.
Shell IDs remain internal for ordinary synchronous invocations and become visible as
`[shell_cmd_<shell-id>]` only when the invocation is explicitly asynchronous or background-managed.
A `running` Task snapshot with `executionMode: "sync"` does not override a terminal Tool event;
Task status becomes authoritative only after the shell is background-managed.
Shell lifecycle behavior is enabled exclusively by `tool.execution_start.shellToolInfo`; Tool
names and shell-like arguments or results never classify an invocation as a shell launcher.
When an invocation provides `description` or `summary`, that human-readable text appears beside the
Tool name. Inline summaries collapse whitespace and truncate to `tool_summary_max_length`
characters; complete arguments remain available by pressing Enter on the row. Tool-specific
fallbacks continue to show paths for file reads, creates, and edits; patterns and queries for
searches; and shortened agent prompts/messages.
The conversation winbar shows live Copilot activity, the effective model, and cumulative AI
credits (AIC) used by the session. Activity advances through event-backed phases such as
`Thinking`, `Running tool: <name>`, `Processing result`, `Writing`, `Waiting for permission`,
`Idle`, and `Error`. Active phases include an elapsed-seconds counter, while model and AIC values
refresh from SDK usage events after every model call.

SDK-provided reasoning summaries, intent, errors, tools, prompts, schedules, tasks, and environment status
appear inline in the conversation, similar to Copilot CLI's timeline. Whether reasoning content is
emitted depends on the selected model and GitHub
Copilot runtime. The plugin does not manufacture or expose private hidden chain-of-thought.

Each session reports runtime/configuration discovery and loaded counts for tools, instructions,
skills, MCP servers, plugins, and agents through conversation rows that update in place. MCP
connection-state changes update the original server row without disturbing chronology. Discovered
instruction sources are additionally listed as one compact `[environment] Instruction <label>` row
per source, showing the source label and its file path (like Copilot CLI) rather than only a count.
Instruction file **contents** are never rendered; sources flagged as disabled by default are marked
accordingly. When Copilot discovers a nested instruction file on demand while traversing the
codebase, the ordinary `view`/read tool row shows that path as well.

Slash commands are listed and invoked through the active Copilot SDK session. Nothing is hardcoded for `/autopilot`: built-ins, aliases, skills, plugins, and future runtime commands are discovered dynamically. Enter a slash command directly or press `/` in an empty prompt to browse the commands available to the selected agent. `<Tab>` completes command names and aliases, SDK-provided argument choices, and directory arguments declared by the command metadata. `/tasks` is added as a client-native command because the SDK exposes typed task APIs but omits the CLI-owned slash command; it opens a task picker. The SDK-provided `/fleet` command is intentionally omitted, and direct `/fleet` input is rejected; standalone teams are provisioned explicitly with the `real_agent_*` tools, typically through a saved prompt snippet. `/resume` is also client-native because session listing and recovery are typed SDK client APIs rather than session slash commands; it opens a workspace-scoped picker, while `/resume <session-id>` resumes directly. The picker enriches lightweight SDK metadata before display, preferring a user-assigned name and then the generated session summary. It marks sessions locked by another live process as `[active elsewhere]`, prevents unsafe recovery of those sessions, and shows relative time based only on the session's last-modified timestamp.

The client-native command set is intentionally small:

- `/tasks` browses typed SDK background tasks and opens their floating details.
- `/resume` lists and safely resumes workspace sessions.
- `/model` opens the selected session's model picker; `/model <id>` switches directly.
- `/reasoning` shows the selected model's supported reasoning efforts; `/reasoning <level>`
  switches the active session without changing models.
- `/mcp` opens a server/action picker. `/mcp list`, `show`, `tools`, `enable`, `disable`, and
  `reload` are also available directly.
- `/mcp-reload` reloads MCP connections without replacing the current session.

All other commands use the active runtime's dynamic command catalog and invocation result.

`/mcp-reload` and `:CopilotMeshReloadMcp` call the SDK's session-scoped
`session.rpc.mcp.reload()` API. They stop and reconnect the selected session's MCP servers,
refresh the inline environment rows, and do not restart or replace the Copilot session.

Native scheduled prompts and session-store support are enabled for every SDK session. The model can
therefore use `manage_schedule` and `sql` when the connected Copilot runtime exposes them. `todos`
and `todo_deps` are tables in the per-session SQLite database used through `sql`; they are not
separate tools. Availability is still subject to the installed Copilot CLI/runtime version and its
feature policy.

`/every`, `/after`, and model-created `manage_schedule` entries appear as stable `[schedule]` rows.
Creation, re-arming, and cancellation update the original row. When a schedule fires, its message
appears as a `👨` turn and its active response state appears beside `🤖`. Press `<Enter>`
on a schedule row to inspect its prompt and cadence without expanding that content in the main
timeline.

Command behavior follows the result returned by the SDK:

- Text and completion results are appended to the conversation.
- Agent-prompt results are submitted to the selected agent as a normal turn.
- Commands requiring a subcommand open a picker; repeated `select-subcommand` results support nested
  command selection, while SDK-provided argument choices remain available through completion.

Other than the explicit client-native `/tasks`, `/resume`, `/model`, `/reasoning`, and `/mcp`
integrations, commands come from `session.rpc.commands.list()`. The model and MCP overrides use
typed session RPCs so commands that are interactive in Copilot CLI remain actionable rather than
returning an inert completion. CLI-owned general session navigation such as `/new` and `/clear` is
not currently exposed by the SDK session command registry. Standalone-agent recovery remains
available through `<leader>aif` and `:CopilotMeshSelect`, which restore plugin-owned UUID,
mailbox, ACL, and SDK-session state.

The SDK does expose typed task-management RPCs, which the plugin uses directly:

- `:CopilotMeshTasks` opens a picker for the selected session's tracked tasks.
- `:CopilotMeshCancelBackground` cancels every background subagent in the selected session.
- `:CopilotMeshAbort` aborts the selected session's foreground turn while keeping the session usable.

Cancelling all background agents does not terminate promoted attached shell processes. A running
shell tracked by the task registry can instead be selected through `:CopilotMeshTasks` and
cancelled from its floating detail pane.

### Optional blink.cmp source

`blink.cmp` is not a plugin dependency. To use it as the completion frontend, set `frontend.completion = "blink"` above and register the source in your own blink configuration:

```lua
sources = {
  default = function()
    if vim.b.native_copilot_prompt then return { "copilot_mesh", "path" } end
    return { "lsp", "buffer", "snippets", "path" }
  end,
  providers = {
    copilot_mesh = {
      name = "Copilot",
      module = "copilot_mesh.blink",
      enabled = function() return vim.b.native_copilot_prompt == true end,
      async = true,
      score_offset = 100,
    },
    path = {
      opts = {
        get_cwd = function(context)
          if vim.b[context.bufnr].native_copilot_prompt then return vim.uv.cwd() end
          return vim.fn.expand(("#%d:p:h"):format(context.bufnr))
        end,
      },
    },
  },
}
```

The native source remains the default and does not load blink. With the blink frontend selected, the plugin leaves `/` and `<Tab>` unmapped so the user's blink keymap remains authoritative.

## Lifecycle

`VimLeavePre` sends a graceful shutdown request and waits for the host. The host:

1. Marks active runs interrupted.
2. Preserves pending mailbox messages.
3. Disconnects SDK sessions without deleting session history.
4. Stops the SDK-owned Copilot runtime.
5. Closes SQLite.

stdin closure, parent-process loss, `SIGINT`, and `SIGTERM` trigger the same bounded cleanup. If graceful SDK shutdown exceeds four seconds, the host calls `forceStop()`.

## Testing

The supported test workflow combines focused Node adapter regressions with visible UI E2E. The
visible suite launches a maximized WezTerm window with a real Neovim instance, plugin Lua, Node
host, NDJSON protocol, SQLite database, prompt buffer, and conversation rendering. Copilot replies,
MCP initialization, permissions, Tasks, and Tool events are scripted at the runtime boundary so
scenarios remain fast and deterministic.

Prerequisites:

- Node.js matching `package.json`
- PowerShell 7 (`pwsh`)
- WezTerm
- Neovim available as `nvim`
- Telescope and Plenary installed under Neovim's `stdpath("data")\lazy` for the real picker profile

Run the complete visible matrix:

```powershell
npm test
```

`npm test` first runs Node adapter and persistence-selection regressions. Run only
those integration checks with:

```powershell
npm run test:adapter
```

Core SQLite, lifecycle, ACL, permission, steering and state regressions run with
`npm test` in a **copilot-mesh core clone**. They are not copied into this plugin.

Run the recovery UI regressions here with `npm run test:session-health`. The opt-in live probe
starts its own disposable SDK process and makes three real model requests; it never attaches to
an existing host. It holds one harmless test tool while replaying an older terminal event, then
checks recovery with notifications withheld. Results are saved under
`.e2e-artifacts\session-recovery-live\`.

```powershell
Set-Location <copilot-mesh-core-clone>
npm run build
node test\session-recovery-live.mjs --cli (Get-Command copilot).Source
```

Run `npm run test:agent-switch` for actual bracket-key switching, the per-line fold-call budget,
native reasoning folds, prompt preservation, following, streaming/replay updates, and overview windows.

Run `npm run test:rename` for shared Lua module identity, command aliases, idempotent setup,
and the real host's legacy/default/explicit database selection. Set
`COPILOT_MESH_LEGACY_FIRST=1` when running `test\rename-compat.lua` to check legacy-first loading.
These tests use isolated fixtures and never open the user's state database.

Run `npm run test:peer-steering` here for Neovim steering/user-queue UI regressions.
Core tests cover mailbox ordering, serialization, durable receipts and lifecycle
races. The opt-in live peer probe in the **core clone** creates two new
disposable SDK sessions and calls the real `real_agent_send_message` tool while the recipient is
inside a gated tool. It asserts that the changed instruction executes before the first idle, with
one durable message, one acceptance, no task restart/resend, and intact sender attribution:

```powershell
Set-Location <copilot-mesh-core-clone>
npm run build
node test\peer-steering-live.mjs --cli (Get-Command copilot).Source
```

Evidence is written under `.e2e-artifacts\peer-steering-live\`. The separate
`test\peer-steering-startup-live.lua` smoke test exercises isolated Neovim `:AI`, the actual Node
host, a newly created SDK session, a harmless model reply, and the status UI. Set
`PEER_STEERING_ROOT` to the plugin path, `PEER_STEERING_WORKSPACE` to a fresh disposable directory,
and optionally `PEER_STEERING_RESOLVER` to a command resolver, then run it with
`nvim --headless -u NONE -l test\peer-steering-startup-live.lua`. It never resumes an existing
session; `startup-result.json` is saved in the disposable workspace. This isolated command alias
does not validate a user's personal `:AI` mapping or live Neovim configuration.

Run one launch profile while developing:

```powershell
npm run test:e2e:allow-all
npm run test:e2e:allow-all-mcp
npm run test:e2e:manual-permissions
npm run test:e2e:telescope
```

Use observation mode to slow the scripted events and leave the completed maximized window open:

```powershell
npm run test:e2e:observe
```

Each profile opens an independent visible window, drives prompts through the real prompt mapping,
writes assertions and conversation snapshots under `.e2e-artifacts\`, and closes immediately when
the scenario finishes. `allow-all` omits MCP servers, `allow-all-mcp` renders connected and failed
mock servers, and `manual-permissions` exercises the interactive approval picker. `telescope`
loads the real installed Telescope, Plenary, and Blink plugins and covers command
pickers, direct command forms, newest-session selection, locked sessions, session restoration, and
constrained UI layouts. Resume coverage also verifies that sub-agent prompts retain Task ownership
without duplicating the initial `task` or later `write_agent` tool arguments, and that internal
sub-agent responses do not appear as primary Copilot output. Tool-only historical responses also
retain their original timestamp instead of using the time at which `/resume` was invoked.
Instruction-discovery events share one unquoted timeline representation in live and resumed flows.
The Telescope profile also verifies that `smear-cursor` is neither loaded nor available.
Shared scenarios cover streamed reasoning folds, fold open/close behavior, Tool ownership, and
Task deferral.
Observation mode runs the `allow-all` profile, writes timestamped artifacts, and leaves Neovim open
until the user closes it.

`npm run check` remains available for a TypeScript-only compile check, and `npm run build` emits the
Node host required by the visible suite. Neither command replaces the visible E2E matrix.

The host’s stdout is protocol-only NDJSON. Diagnostics are written to stderr; Neovim appends them to:

```text
stdpath("state")\native-copilot.log
```
