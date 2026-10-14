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
native.shutdown()
assert(require('copilot_mesh.statusline').color() == nil)
assert(#notices == 0, vim.inspect(notices))
vim.fn.writefile({ vim.json.encode(result) }, assert(vim.env.MESH_TEST_RESULT))
print('PASS isolated adapter identity and real lualine renderer: ' .. identity.sessionId)
vim.cmd('qa!')
