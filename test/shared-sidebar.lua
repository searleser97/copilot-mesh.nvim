vim.opt.runtimepath:prepend(vim.fn.getcwd())
vim.o.columns = 120
vim.o.lines = 40
local requests = {}
package.loaded['native_copilot.protocol'] = {
  is_running = function() return true end,
  send = function(kind) requests[#requests + 1] = kind; return 'request' end,
  stop_sync = function() end,
}
local native = require('native_copilot')
local buffers = require('native_copilot.buffers')
native.setup({ voice = { preload = false }, session_colors = { enabled = false },
  shared_host = { url = 'http://127.0.0.1:1', token_file = 'not-read-by-mock' } })
for index, name in ipairs({ 'first', 'second', 'child' }) do
  native._on_event({ type = index == 1 and 'primary.ready' or 'agent.ready',
    payload = { target = 'agent:' .. name, agentId = name, displayName = name, sessionId = 'sdk-' .. name } })
end
local function catalog(second_live)
  native._on_event({ type = 'shared.catalog', payload = { conversations = {
    { target = 'agent:first', displayName = 'First chat', state = 'idle', live = true, sessionId = 'sdk-first' },
    { target = 'agent:second', displayName = 'Second chat', state = second_live and 'busy' or 'stopped',
      live = second_live, sessionId = 'sdk-second' },
  } } })
end
catalog(true)
native.show_member('agent:first')
local main = vim.api.nvim_get_current_win()
local sidebar, prompt
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  local buf = vim.api.nvim_win_get_buf(win)
  if vim.api.nvim_buf_get_name(buf):find('shared-chats', 1, true) then sidebar = win end
  if vim.b[buf].native_copilot_prompt then prompt = win end
end
assert(sidebar and prompt and main ~= sidebar)
assert(vim.api.nvim_win_get_position(sidebar)[2] == 0)
assert(vim.api.nvim_win_get_position(main)[2] > 0)
assert(vim.api.nvim_win_get_position(prompt)[2] > 0)
local sidebar_buf = vim.api.nvim_win_get_buf(sidebar)
local text = table.concat(vim.api.nvim_buf_get_lines(sidebar_buf, 0, -1, false), '\n')
assert(text:find('First chat') and text:find('Second chat') and not text:find('child'))
local width = vim.api.nvim_win_get_width(sidebar)
local prompt_buf = vim.api.nvim_win_get_buf(prompt)
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { 'first draft' })
local count = #requests
vim.api.nvim_set_current_win(sidebar)
vim.api.nvim_win_set_cursor(sidebar, { 6, 0 })
vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes('<CR>', true, false, true), 'xt', false)
assert(vim.api.nvim_get_current_win() == main)
assert(vim.api.nvim_win_get_buf(main) == buffers.buffer('agent:second'))
assert(#requests == count, 'view selection must not resume or recreate any runtime')
assert(vim.api.nvim_buf_get_lines(prompt_buf, 0, -1, false)[1] == '')
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, { 'second draft' })
native.show_member('agent:first')
assert(vim.api.nvim_buf_get_lines(prompt_buf, 0, -1, false)[1] == 'first draft')
assert(vim.api.nvim_win_get_width(sidebar) == width)
vim.api.nvim_set_current_win(prompt)
catalog(false)
assert(vim.api.nvim_get_current_win() == prompt, 'catalog updates must not steal focus')
text = table.concat(vim.api.nvim_buf_get_lines(sidebar_buf, 0, -1, false), '\n')
assert(not text:find('Second chat') and text:find('First chat'))
assert(buffers.get_member('agent:child'), 'agent hierarchy remains separate and accessible')
native.close()
assert(#requests == count, 'closing the view must not stop a session')
print('PASS shared-only sidebar, catalog updates, local drafts, focus, width and detach')
vim.cmd('qa!')
