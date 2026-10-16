vim.opt.runtimepath:prepend(vim.fn.getcwd())
local native = require('native_copilot')
native.setup({ voice = { preload = false }, session_colors = { enabled = false } })
local buffers = require('native_copilot.buffers')
local history = require('native_copilot.shared_history')
local sent = {}
history.setup(function(kind, payload) sent[#sent + 1] = { kind, payload } end)
buffers.ensure_member('agent:test', 'Paging test')
vim.api.nvim_win_set_buf(0, buffers.buffer('agent:test'))
history.reset('journal')
history.shown('agent:test')
assert(#sent == 1 and sent[1][1] == 'shared.history')
local function page(start, finish, older)
  local records = {}
  for i = start, finish do
    records[#records + 1] = { id = 'm' .. i, ordinal = i, revision = i,
      kind = 'assistant', title = 'Copilot', text = 'Message ' .. i .. '\nSecond line', bytes = 20 }
  end
  history.event({ type = 'shared.history.page', memberId = 'agent:test',
    payload = { journalId = 'journal', records = records, before = start, hasMore = start > 1, older = older } })
end
page(961, 1000, false)
local buf = buffers.buffer('agent:test')
assert(vim.api.nvim_buf_line_count(buf) == 162)
vim.api.nvim_win_set_cursor(0, { 15, 0 })
vim.cmd('normal! zt')
local before = vim.fn.winsaveview()
local anchor = vim.api.nvim_buf_get_lines(buf, before.topline - 1, before.topline, false)[1]
history.moved(vim.api.nvim_get_current_win())
assert(sent[#sent][2].before == 961)
page(921, 960, true)
local after = vim.fn.winsaveview()
assert(after.topline == before.topline + 160, vim.inspect({ before, after }))
assert(vim.api.nvim_buf_get_lines(buf, after.topline - 1, after.topline, false)[1] == anchor)
history.event({ type = 'shared.history.records', memberId = 'agent:test',
  payload = { records = {{ id = 'm1001', ordinal = 1001, revision = 1001,
    kind = 'assistant', title = 'Copilot', text = 'Live message', bytes = 12 }} } })
assert(vim.fn.winsaveview().topline == after.topline)
history.event({ type = 'shared.history.error', memberId = 'agent:test', payload = { message = 'test failure' } })
assert(vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1]:match('gR retries'))
print('Shared history: 40 initial records, 40 older, viewport anchor preserved, live append and retry state passed.')
vim.cmd('qa!')
