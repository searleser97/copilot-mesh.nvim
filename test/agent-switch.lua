vim.opt.runtimepath:prepend(vim.fn.getcwd())
local requests = {}
package.loaded['native_copilot.protocol'] = {
  is_running = function() return true end,
  send = function(kind)
    requests[#requests + 1] = kind
    return 'isolated-request'
  end,
  stop_sync = function() end,
}
local native = require('native_copilot')
local buffers = require('native_copilot.buffers')
native.setup({ voice = { preload = false }, session_colors = { enabled = false } })
native._on_event({
  type = 'primary.ready',
  payload = { target = 'agent:short', agentId = 'short', sessionId = 'isolated-short' },
})
native._on_event({
  type = 'agent.ready',
  payload = { target = 'agent:long', agentId = 'long', sessionId = 'isolated-long' },
})
local long = buffers.get_member('agent:long').views.conversation
local fold_ns = vim.api.nvim_create_namespace('native_copilot_activity_fold')
buffers.begin_history_replay('agent:long')
for i = 1, 80 do
  buffers.append_block('agent:long', 'conversation', 'User', 'Synthetic request ' .. i)
  buffers.append_activity_block('agent:long', 'Reasoning summary',
    'First reasoning line.\n' .. string.rep('Another reasoning line.\n', 9))
  buffers.append_block('agent:long', 'conversation', 'Copilot',
    '## Answer\n\n**Summary** and `code`.\n\n- One\n- Two\n\n```lua\nreturn true\n```')
end
buffers.finish_history_replay('agent:long')
native.show_member('agent:short')
local main_win = vim.api.nvim_get_current_win()
local prompt_win
for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
  if vim.b[vim.api.nvim_win_get_buf(win)].native_copilot_prompt then prompt_win = win end
end
assert(prompt_win, 'prompt window missing')
local prompt_buf = vim.api.nvim_win_get_buf(prompt_win)
local draft = { 'An unsent draft.', 'Keep this second line.' }
vim.api.nvim_buf_set_lines(prompt_buf, 0, -1, false, draft)

local fold_calls = {}
local original_foldexpr = buffers.foldexpr
buffers.foldexpr = function(lnum)
  local buf = vim.api.nvim_get_current_buf()
  fold_calls[buf] = (fold_calls[buf] or 0) + 1
  return original_foldexpr(lnum)
end
local function press(keys)
  vim.api.nvim_feedkeys(keys, 'xt', false)
  vim.cmd('redraw')
end
local function assert_fold_setup(win)
  assert(vim.wo[win].foldmethod == 'expr')
  assert(vim.wo[win].foldexpr == "v:lua.require'native_copilot.buffers'.foldexpr(v:lnum)",
    'use the direct Lua module-call prefix, not a converted Vimscript dictionary')
  assert(vim.wo[win].foldenable and vim.wo[win].foldminlines == 0)
end
local requests_before = #requests
vim.api.nvim_set_current_win(prompt_win)
for _ = 1, 3 do
  fold_calls = {}
  press(']a')
  assert(vim.api.nvim_win_get_buf(main_win) == long.buf)
  assert(vim.api.nvim_get_current_win() == prompt_win, 'switch must preserve prompt focus')
  assert(vim.b[prompt_buf].native_copilot_target == 'agent:long')
  assert(vim.deep_equal(vim.api.nvim_buf_get_lines(prompt_buf, 0, -1, false), draft))
  assert_fold_setup(main_win)
  local count = vim.api.nvim_buf_line_count(long.buf)
  assert((fold_calls[long.buf] or 0) <= count,
    ('switch must not scan the transcript twice: %d calls for %d lines'):format(
      fold_calls[long.buf] or 0, count))
  assert(vim.api.nvim_win_get_cursor(main_win)[1] == count, 'switch must follow EOF')
  press('[a')
  assert(vim.b[prompt_buf].native_copilot_target == 'agent:short')
end
assert(#requests == requests_before, 'switch must not request or replay SDK history')

vim.api.nvim_set_current_win(main_win)
press(']a')
local marks = vim.api.nvim_buf_get_extmarks(long.buf, fold_ns, 0, -1, { details = true })
assert(#marks == 80, 'fixture must contain real rendered reasoning folds')
local first = marks[1][2] + 1
local first_end = marks[1][4].end_row
local function first_closed()
  return vim.api.nvim_win_call(main_win, function() return vim.fn.foldclosed(first) end)
end
vim.api.nvim_win_set_cursor(main_win, { first, 0 })
press('zc')
assert(first_closed() == first)
assert(vim.fn.foldclosedend(first) == first_end, 'only reasoning should be folded')
press('zo')
assert(first_closed() == -1)
press('za')
assert(first_closed() == first)
local closed_level = vim.wo[main_win].foldlevel
fold_calls = {}
buffers.on_shown(long.buf)
vim.cmd('redraw')
assert(first_closed() == first, 're-show must preserve a manually closed fold')
assert(vim.wo[main_win].foldlevel == closed_level, 're-show must not reset foldlevel')
assert((fold_calls[long.buf] or 0) == 0, 'unchanged fold setup must not invalidate fold calculations')
press('[a')
press(']a')
assert(first_closed() == first, 'round-trip switching must preserve closed folds')

buffers.append_activity_delta('agent:long', 'visible-stream', 'Visible reasoning.\nMore detail.')
buffers.complete_activity('agent:long', 'visible-stream', 'Visible reasoning.\nMore detail.')
assert(first_closed() == first, 'visible streaming must preserve other closed folds')
local function assert_last_fold(win)
  local folds = vim.api.nvim_buf_get_extmarks(long.buf, fold_ns, 0, -1, { details = true })
  local last = folds[#folds]
  assert(last and last[4].end_row > last[2] + 1, 'reasoning must remain a multi-line native fold')
  vim.api.nvim_win_call(win, function()
    assert(vim.fn.foldlevel(last[2] + 1) == 1, 'updated reasoning start must be foldable')
    assert(vim.fn.foldlevel(last[4].end_row) == 1, 'updated reasoning end must be foldable')
  end)
end
assert_last_fold(main_win)
press('[a')
buffers.append_block('agent:long', 'conversation', 'Copilot', 'Separate the next reasoning block.')
buffers.append_activity_delta('agent:long', 'hidden-stream', 'Hidden reasoning.\nMore detail.')
buffers.complete_activity('agent:long', 'hidden-stream', 'Hidden reasoning.\nMore detail.')
press(']a')
assert_last_fold(main_win)

press('[a')
buffers.begin_history_replay('agent:long')
buffers.append_block('agent:long', 'conversation', 'User', 'An incremental historical request.')
buffers.append_activity_block('agent:long', 'Reasoning summary', 'Historical reasoning.\nMore detail.')
buffers.append_block('agent:long', 'conversation', 'Copilot', 'Historical answer.')
buffers.finish_history_replay('agent:long')
press(']a')
assert_last_fold(main_win)
assert(vim.api.nvim_win_get_cursor(main_win)[1] == vim.api.nvim_buf_line_count(long.buf))

buffers.begin_history_replay('agent:long')
buffers.append_block('agent:long', 'conversation', 'User', 'A visible replay request.')
buffers.append_activity_block('agent:long', 'Reasoning summary', 'Visible replay reasoning.\nMore detail.')
buffers.append_block('agent:long', 'conversation', 'Copilot', 'Visible replay answer.')
buffers.finish_history_replay('agent:long')
assert_last_fold(main_win)
assert(vim.api.nvim_win_get_cursor(main_win)[1] == vim.api.nvim_buf_line_count(long.buf))

vim.api.nvim_win_set_cursor(main_win, { 2, 0 })
buffers.on_view_moved(main_win, 'CursorMoved')
buffers.append_block('agent:long', 'conversation', 'Copilot', 'Update while scrolled away.')
assert(vim.api.nvim_win_get_cursor(main_win)[1] == 2, 'stream updates must respect manual scrolling')
buffers.setup({ follow_bottom = false })
buffers.on_shown(long.buf)
assert(vim.api.nvim_win_get_cursor(main_win)[1] == 2, 'disabled following must remain disabled')
buffers.setup({ follow_bottom = true })
buffers.scroll_to_bottom('agent:long')
assert(vim.api.nvim_win_get_cursor(main_win)[1] == vim.api.nvim_buf_line_count(long.buf))

native.show_overview()
for _, id in ipairs({ 'agent:short', 'agent:long' }) do
  local wins = vim.fn.win_findbuf(buffers.buffer(id))
  assert(#wins == 1, 'overview must show both conversation buffers')
  assert_fold_setup(wins[1])
end
local long_win = vim.fn.win_findbuf(long.buf)[1]
assert_last_fold(long_win)
native.show_member('agent:long')
assert(#vim.fn.win_findbuf(buffers.buffer('agent:short')) == 0)
assert(#vim.fn.win_findbuf(long.buf) == 1)
assert(vim.deep_equal(vim.api.nvim_buf_get_lines(prompt_buf, 0, -1, false), draft))
local restored_win = vim.fn.win_findbuf(long.buf)[1]
vim.wo[restored_win].foldexpr = '0'
vim.wo[restored_win].foldlevel = 0
vim.wo[restored_win].foldminlines = 2
vim.wo[restored_win].foldenable = false
vim.wo[restored_win].signcolumn = 'no'
buffers.on_shown(long.buf)
assert_fold_setup(restored_win)
assert(vim.wo[restored_win].foldlevel == 99, 'changed fold setup must still initialize unfolded')
assert(vim.wo[restored_win].signcolumn == 'yes:1')
buffers.foldexpr = original_foldexpr
print('PASS agent switch fold-call budget, native folds, prompt, following, streaming, replay and overview')
vim.cmd('qa!')
