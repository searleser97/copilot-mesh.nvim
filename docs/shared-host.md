# Opt-in shared-host development adapter

Embedded mode is unchanged and remains the default. This development adapter uses
a separate Node transport process, but that process **does not own the SDK**.
Exiting the editor only detaches. Closing a view does not stop a shared session.

Build this branch in an isolated plugin directory. Do not update a daily Lazy
installation to try it. Configure a separate `NVIM_APPNAME` and XDG directories
with a minimal init that loads only this plugin (no daily init or plugin manager).

```lua
require('copilot_mesh').setup({
  shared_host = {
    url = 'https://YOUR-PRIVATE-TUNNEL.devtunnels.ms',
    token_file = 'PRIVATE-PATH-TO-MESH-DEVICE-TOKEN',
    tunnel_token_file = 'PRIVATE-PATH-TO-TUNNEL-CONNECT-TOKEN',
  },
  frontend = { picker = 'native', completion = 'native' },
  session_colors = { enabled = false },
  voice = { preload = false },
})
```

Use an `http://127.0.0.1:47321` URL and omit `tunnel_token_file` for isolated local
testing. The token files are read by the adapter; contents never enter argv or
the event log. Each connection replays the shared durable journal before following
live events. Existing live sessions are attachable, not "in use elsewhere".
Selecting a stopped managed session explicitly resumes it.

Prompts are rendered from shared acceptance events rather than optimistic local
echo, so other clients see them without duplicate local messages. Drafts, folds,
scroll and selection remain editor-local. Model, MCP, tasks and native permission
operations use the shared host. Spawn-by-UI is not supported in this first adapter;
Mesh agent tools retain their normal ACL/permission behavior.

An event connection retries from its last applied cursor. Commands are not
automatically submitted again after a connection error: inspect shared history
before creating a new request. Credentials authorize human control of the host,
not agent-to-agent access. See the core shared-host guide for isolated startup and
private Dev Tunnels configuration. No autostart or everyday deployment is installed.
