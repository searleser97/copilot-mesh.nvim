vim.opt.runtimepath:prepend(vim.fn.getcwd())
vim.o.termguicolors = true
local notices = {}
vim.notify = function(text) table.insert(notices, text) end
local colors = require('copilot_mesh.statusline')
local main_tab = vim.api.nvim_get_current_tabpage()
local function visible(win) return vim.api.nvim_win_get_tabpage(win) == main_tab end
local assignment = {
  sessionId = 'main-stable-id', bg = '#56b4e9', fg = '#000000',
  expiresAt = (vim.uv.gettimeofday() + 604800) * 1000,
}
local original_statusline = vim.o.statusline
colors.setup({}, visible)
colors.update(assignment)
assert(package.loaded.lualine == nil, 'must not load absent provider')
assert(vim.o.statusline == original_statusline)
package.loaded.lualine = {}
package.loaded['lualine.highlight'] = {}
colors.setup({}, visible)
assert(#notices == 0, 'unsupported provider must be silent')
package.loaded.lualine = nil
package.loaded['lualine.highlight'] = nil

local root = vim.env.MESH_LUALINE_ROOT
if not root then
  print('PASS missing/unsupported provider no-op (set MESH_LUALINE_ROOT for renderer integration)')
  vim.cmd('qa!')
  return
end
vim.opt.runtimepath:append(root)
local lualine = require('lualine')
if vim.env.MESH_NVIM_CONFIG then
  local specs
  package.loaded.lazy = { setup = function(items) specs = items end }
  package.loaded.myutils = { Is_Windows = function() return true end }
  dofile(vim.env.MESH_NVIM_CONFIG .. '/lua/plugins.lua')
  local found = false
  for _, spec in ipairs(specs) do
    if spec[1] == 'nvim-lualine/lualine.nvim' then spec.config(); found = true end
  end
  assert(found, 'actual lualine config not found')
else
  lualine.setup({
    sections = { lualine_a = { 'mode' }, lualine_c = { 'filename', 'filetype' }, lualine_z = { 'location' } },
    inactive_sections = { lualine_a = { 'mode' }, lualine_c = { 'filename', 'filetype' }, lualine_z = { 'location' } },
  })
end
colors.clear()
local config = vim.deepcopy(lualine.get_config())
local hl = require('lualine.highlight')
local baseline_format = hl.format_highlight
local function render(active)
  vim.g.actual_curwin = active and vim.api.nvim_get_current_win() or -1
  local text = lualine.statusline(active)
  assert(active or text:find('lualine_c_inactive', 1, true), 'inactive section must actually be rendered')
  return vim.api.nvim_eval_statusline(text, { winid = vim.api.nvim_get_current_win(), maxwidth = 160, highlights = true })
end
local baseline = { render(true), render(false) }
colors.update(assignment)
colors.setup({}, visible)
colors.setup({}, visible)
assert(#vim.api.nvim_get_autocmds({ group = 'CopilotMeshStatusline' }) == 5)
assert(vim.deep_equal(config, lualine.get_config()), 'provider configuration must stay exactly unchanged')
assert(hl.format_highlight('c', true) == baseline_format('c', true),
  'tabline/winbar highlight resolution outside statusline must remain untouched')
local function verify(active, expected_text)
  local output = render(active)
  assert(output.str == expected_text, 'only colors may change: ' .. output.str)
  local tinted = 0
  for i, item in ipairs(output.highlights) do
    if item.group:match('^CopilotMeshSession_') then
      local attributes = vim.api.nvim_get_hl(0, { name = item.group, link = false })
      assert(attributes.bg == tonumber(assignment.bg:sub(2), 16), vim.inspect({ item, attributes }))
      assert(attributes.fg == tonumber(assignment.fg:sub(2), 16), vim.inspect({ item, attributes }))
      tinted = tinted + ((output.highlights[i + 1] or {}).start or #output.str) - item.start
    end
  end
  assert(tinted > 80, 'center/fill tint should cover most of 160-column statusline: ' .. tinted)
end
verify(true, baseline[1].str)
verify(false, baseline[2].str)
vim.o.termguicolors = false
assert(colors.color() == nil, 'unsupported non-true-color mode must quietly preserve the provider')
vim.o.termguicolors = true
vim.cmd('colorscheme default')
verify(true, baseline[1].str)
if vim.fn.exists(':SetStatusLineBG') == 2 then
  vim.cmd('SetStatusLineBG orange')
else
  lualine.setup({ options = { theme = 'auto' } })
end
verify(true, baseline[1].str)
vim.cmd('tabnew')
local unrelated = render(true)
for _, item in ipairs(unrelated.highlights) do
  assert(not item.group:find('CopilotMeshSession_', 1, true), 'unrelated tab must not inherit color')
end
vim.cmd('tabclose')
local expired = vim.deepcopy(assignment)
expired.expiresAt = 0
colors.update(expired)
assert(colors.color() == nil, 'idle redraw must not renew expired lease')
for _, item in ipairs(render(true).highlights) do
  assert(not item.group:find('CopilotMeshSession_', 1, true))
end
colors.update(assignment)
colors.setup({ enabled = false }, visible)
assert(hl.format_highlight == baseline_format, 'disable must unhook provider')
assert(colors.color() == nil)
colors.setup({}, visible)
colors.update(assignment)
colors.clear()
assert(hl.format_highlight == baseline_format, 'teardown must restore provider')
assert(#notices == 0, vim.inspect(notices))
print('PASS actual lualine rendered colors, center coverage, text/config preservation, refresh, expiry and teardown')
vim.cmd('qa!')
