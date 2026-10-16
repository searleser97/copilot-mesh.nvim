local M = {}
local state = { conversations = {}, rows = {} }

local function render()
  if not state.buf or not vim.api.nvim_buf_is_valid(state.buf) then return end
  local lines = { 'Running chats', 'Enter: open  n: new', '' }
  state.rows = {}
  for _, chat in ipairs(state.conversations) do
    if chat.live then
      lines[#lines + 1] = ('%s [%s]'):format(chat.displayName, chat.state)
      state.rows[#lines] = chat
      lines[#lines + 1] = '  ' .. chat.sessionId:sub(1, 8)
      state.rows[#lines] = chat
    end
  end
  if #lines == 3 then lines[#lines + 1] = 'No running chats' end
  vim.bo[state.buf].modifiable = true
  vim.api.nvim_buf_set_lines(state.buf, 0, -1, false, lines)
  vim.bo[state.buf].modifiable = false
end

function M.update(conversations)
  state.conversations = conversations
  render()
end

function M.is_window(win)
  return win == state.win and vim.api.nvim_win_is_valid(win)
end

function M.show(main_win, select, create)
  if state.win and vim.api.nvim_win_is_valid(state.win) then return end
  if not state.buf or not vim.api.nvim_buf_is_valid(state.buf) then
    state.buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_name(state.buf, 'native-copilot://shared-chats')
    vim.bo[state.buf].buftype = 'nofile'
    vim.bo[state.buf].bufhidden = 'hide'
    vim.bo[state.buf].swapfile = false
    vim.bo[state.buf].filetype = 'native-copilot'
    vim.keymap.set('n', '<CR>', function()
      local chat = state.rows[vim.api.nvim_win_get_cursor(0)[1]]
      if chat then select(chat) end
    end, { buffer = state.buf, desc = 'Attach hosted conversation' })
    vim.keymap.set('n', 'n', create, { buffer = state.buf, desc = 'New hosted conversation' })
  end
  local previous = vim.api.nvim_get_current_win()
  vim.api.nvim_set_current_win(main_win)
  vim.cmd('topleft vsplit')
  state.win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(state.win, state.buf)
  vim.api.nvim_win_set_width(state.win, math.max(12, math.min(30, math.floor(vim.o.columns / 3))))
  vim.wo[state.win].winfixwidth = true
  vim.wo[state.win].number = false
  vim.wo[state.win].relativenumber = false
  vim.wo[state.win].wrap = false
  render()
  if vim.api.nvim_win_is_valid(previous) then vim.api.nvim_set_current_win(previous) end
end

return M
