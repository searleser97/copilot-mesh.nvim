local M = {}
local assignment
local enabled = true
local visible = function() return false end
local provider, original, wrapper, lualine_provider, original_statusline, statusline_wrapper
local rendering = false
local highlights = {}

local function refresh()
  vim.cmd('redrawstatus')
  local lualine = package.loaded.lualine
  if type(lualine) == 'table' and type(lualine.refresh) == 'function' then
    lualine.refresh({ place = { 'statusline' } })
  end
end

function M.color()
  local seconds, micros = vim.uv.gettimeofday()
  if not enabled or not vim.o.termguicolors or not assignment
    or seconds * 1000 + micros / 1000 >= assignment.expiresAt then return nil end
  local win = tonumber(vim.g.statusline_winid) or vim.api.nvim_get_current_win()
  if not visible(win) then return nil end
  return { bg = assignment.bg, fg = assignment.fg }
end

local function detach()
  if provider and provider.format_highlight == wrapper then provider.format_highlight = original end
  if lualine_provider and lualine_provider.statusline == statusline_wrapper then
    lualine_provider.statusline = original_statusline
  end
  provider, original, wrapper, lualine_provider, original_statusline, statusline_wrapper = nil, nil, nil, nil, nil, nil
end

local function attach()
  if not enabled then return end
  -- Optional provider: never require/load lualine on the user's behalf.
  local candidate = package.loaded['lualine.highlight']
  local lualine = package.loaded.lualine
  if type(lualine) ~= 'table' or type(lualine.statusline) ~= 'function' or type(candidate) ~= 'table'
    or type(candidate.format_highlight) ~= 'function' then return end
  if candidate == provider and candidate.format_highlight == wrapper
    and lualine.statusline == statusline_wrapper then return end
  detach()
  provider, original = candidate, candidate.format_highlight
  lualine_provider, original_statusline = lualine, lualine.statusline
  local base = original
  wrapper = function(section, focused)
    local result = base(section, focused)
    local color = rendering and section == 'c' and M.color() or nil
    local name = type(result) == 'string' and result:match('^%%#([%w_]+)#$')
    if not color or not name then return result end
    local tinted = 'CopilotMeshSession_' .. name
    local attrs = vim.api.nvim_get_hl(0, { name = name, link = false })
    attrs.bg, attrs.fg = tonumber(color.bg:sub(2), 16), tonumber(color.fg:sub(2), 16)
    if not vim.deep_equal(vim.api.nvim_get_hl(0, { name = tinted, link = false }), attrs) then
      vim.api.nvim_set_hl(0, tinted, attrs)
    end
    highlights[tinted] = true
    return '%#' .. tinted .. '#'
  end
  local draw = original_statusline
  statusline_wrapper = function(...)
    local previous = rendering
    rendering = true
    local ok, result = pcall(draw, ...)
    rendering = previous
    if not ok then error(result, 0) end
    return result
  end
  provider.format_highlight = wrapper
  lualine.statusline = statusline_wrapper
end

function M.clear()
  assignment = nil
  for name in pairs(highlights) do vim.api.nvim_set_hl(0, name, {}) end
  highlights = {}
  detach()
  refresh()
end

function M.setup(opts, is_visible)
  enabled = opts.enabled ~= false
  visible = is_visible
  if not enabled then M.clear() end
  local group = vim.api.nvim_create_augroup('CopilotMeshStatusline', { clear = true })
  vim.api.nvim_create_autocmd({ 'ColorScheme', 'WinEnter', 'BufWinEnter' }, {
    group = group,
    callback = function(args)
      if args.event == 'ColorScheme' then highlights = {} end
      attach()
    end,
  })
  vim.api.nvim_create_autocmd('User', {
    group = group, pattern = { 'LazyLoad', 'VeryLazy' }, callback = attach,
  })
  attach()
  refresh()
end

function M.update(color)
  if not enabled or type(color.sessionId) ~= 'string' then M.clear(); return end
  assignment = color
  attach()
  refresh()
end

return M
