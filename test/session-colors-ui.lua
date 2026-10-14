vim.opt.runtimepath:prepend(vim.env.MESH_PLUGIN_ROOT or vim.fn.getcwd())
vim.opt.runtimepath:append(assert(vim.env.MESH_LUALINE_ROOT))
vim.o.termguicolors = true
local notices = {}
vim.notify = function(text) table.insert(notices, text) end
local native = require('copilot_mesh')
native.setup({
  voice = { preload = false },
  database_path = assert(vim.env.MESH_TEST_DATABASE),
  session_colors = { database_path = assert(vim.env.MESH_TEST_COLORS) },
  workspace = assert(vim.env.MESH_TEST_WORKSPACE),
})
local specs
package.loaded.lazy = { setup = function(items) specs = items end }
package.loaded.myutils = { Is_Windows = function() return true end }
dofile(assert(vim.env.MESH_NVIM_CONFIG) .. '/lua/plugins.lua')
for _, spec in ipairs(specs) do
  if spec[1] == 'nvim-lualine/lualine.nvim' then spec.config() end
end
local lualine = require('lualine')
local before = vim.deepcopy(lualine.get_config())
local identity
local on_event = native._on_event
native._on_event = function(event)
  on_event(event)
  if event.type == 'session.color' and event.payload.sessionId then identity = event.payload end
end
local choice = assert(vim.env.MESH_TEST_SESSION)
vim.ui.select = function(items, _, callback)
  if choice == 'new' then callback(items[1]); return end
  for _, item in ipairs(items) do
    if item.session and item.session.sessionId == choice then callback(item); return end
  end
  error('Requested isolated scripted session missing: ' .. choice)
end
native.open({ reuse_current_tab = true })
local expected = choice == 'new' and 'e2e-primary-session' or choice
assert(vim.wait(20000, function() return identity and identity.sessionId == expected end, 20),
  'Timed out: ' .. vim.inspect(notices))
assert(vim.deep_equal(before, lualine.get_config()))
local function capture(focused)
  vim.g.actual_curwin = focused and vim.api.nvim_get_current_win() or -1
  local raw = lualine.statusline(focused)
  assert(focused or raw:find('lualine_c_inactive', 1, true), 'inactive section not rendered')
  local output = vim.api.nvim_eval_statusline(raw, {
    winid = vim.api.nvim_get_current_win(), maxwidth = 160, highlights = true,
  })
  local spans = {}
  for i, item in ipairs(output.highlights) do
    if item.group:match('^CopilotMeshSession_') then
      local hl = vim.api.nvim_get_hl(0, { name = item.group, link = false })
      assert(hl.bg == tonumber(identity.bg:sub(2), 16))
      table.insert(spans, {
        start = item.start,
        finish = (output.highlights[i + 1] or {}).start or #output.str,
        bg = hl.bg, fg = hl.fg,
      })
    end
  end
  assert(#spans > 0, 'actual renderer did not use main-session color')
  return { text = output.str, spans = spans }
end
local result = { identity = identity, active = capture(true), inactive = capture(false) }
if vim.env.MESH_TEST_MCP == '1' then
  -- Both initial automatic allocations must exist before either test releases one.
  local barrier = vim.env.MESH_TEST_COLORS .. '.'
  vim.fn.writefile({ 'ready' }, barrier .. expected .. '.ready')
  assert(vim.wait(10000, function()
    return vim.fn.filereadable(barrier .. 'e2e-primary-session.ready') == 1
      and vim.fn.filereadable(barrier .. 'e2e-cli-session.ready') == 1
  end, 20), 'Concurrent test peer did not become ready')
  local function watcher_saw(phase)
    if expected ~= 'e2e-cli-session' then return end
    assert(vim.wait(10000, function()
      return vim.fn.filereadable(barrier .. 'watch.' .. phase) == 1
    end, 20), 'Second same-session Neovim did not observe ' .. phase)
  end
  watcher_saw('ready')
  local function call(verb, args)
    local request = { jsonrpc = '2.0', id = 1, method = 'tools/call',
      params = { name = 'copilot-mesh-' .. verb .. '-statusline-color', arguments = args } }
    local initialize = { jsonrpc = '2.0', id = 0, method = 'initialize',
      params = { protocolVersion = '2025-06-18', capabilities = {},
        clientInfo = { name = 'mesh-nvim-test', version = '1' } } }
    local process = vim.system({
      'node', (vim.env.MESH_PLUGIN_ROOT or vim.fn.getcwd()) .. '/dist/statusline-mcp.js',
      '--database', vim.env.MESH_TEST_COLORS,
    }, { stdin = vim.json.encode(initialize) .. '\n' .. vim.json.encode(request) .. '\n', text = true }):wait(10000)
    assert(process.code == 0, process.stderr)
    local response = vim.json.decode(vim.split(vim.trim(process.stdout), '\n')[2])
    assert(not response.result.isError, vim.inspect(response))
    return response.result.structuredContent
  end
  local requested = expected == 'e2e-primary-session' and '#123456' or '#234567'
  local changed = call('set', { sessionId = expected, color = requested })
  assert(changed.display == 'not-verified')
  assert(vim.wait(3000, function() return identity.bg == requested end, 20),
    'MCP edit did not refresh live adapter/UI')
  result.mcp_set = { active = capture(true), inactive = capture(false) }
  assert(result.mcp_set.active.text == result.active.text)
  watcher_saw('set')
  assert(call('clear', { sessionId = expected }).state == 'cleared')
  assert(vim.wait(3000, function() return require('copilot_mesh.statusline').color() == nil end, 20))
  local cleared = vim.api.nvim_eval_statusline(lualine.statusline(true), {
    winid = vim.api.nvim_get_current_win(), maxwidth = 160, highlights = true,
  })
  for _, hl in ipairs(cleared.highlights) do assert(not hl.group:match('^CopilotMeshSession_')) end
  assert(cleared.str == result.active.text)
  result.mcp_cleared = true
  watcher_saw('clear')
  assert(call('get', { sessionId = expected }).state == 'cleared')
  call('set', { sessionId = expected, color = result.identity.bg })
  assert(vim.wait(3000, function() return identity.bg == result.identity.bg end, 20))
  assert(vim.deep_equal(before, lualine.get_config()), 'MCP modified provider configuration')
elseif vim.env.MESH_TEST_MCP == 'watch' then
  local barrier = vim.env.MESH_TEST_COLORS .. '.watch.'
  vim.fn.writefile({ 'ready' }, barrier .. 'ready')
  assert(vim.wait(10000, function() return identity.bg == '#234567' end, 20),
    'Second window did not observe MCP set')
  result.mcp_set = { active = capture(true), inactive = capture(false) }
  assert(result.mcp_set.active.text == result.active.text)
  vim.fn.writefile({ 'set' }, barrier .. 'set')
  assert(vim.wait(10000, function() return require('copilot_mesh.statusline').color() == nil end, 20),
    'Second window did not observe MCP clear')
  local cleared = vim.api.nvim_eval_statusline(lualine.statusline(true), {
    winid = vim.api.nvim_get_current_win(), maxwidth = 160, highlights = true,
  })
  for _, hl in ipairs(cleared.highlights) do assert(not hl.group:match('^CopilotMeshSession_')) end
  assert(cleared.str == result.active.text)
  assert(vim.deep_equal(before, lualine.get_config()))
  result.mcp_cleared = true
  vim.fn.writefile({ 'clear' }, barrier .. 'clear')
end
native.shutdown()
assert(require('copilot_mesh.statusline').color() == nil)
assert(#notices == 0, vim.inspect(notices))
vim.fn.writefile({ vim.json.encode(result) }, assert(vim.env.MESH_TEST_RESULT))
print('PASS isolated adapter identity and real lualine renderer: ' .. identity.sessionId)
vim.cmd('qa!')
