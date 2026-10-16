-- Run only against an explicitly configured isolated development host.
assert(vim.env.MESH_SHARED_URL and vim.env.MESH_SHARED_TOKEN_FILE, 'isolated shared host required')
vim.opt.runtimepath:prepend(vim.fn.getcwd())
local native = require('native_copilot')
local protocol = require('native_copilot.protocol')
local buffers = require('native_copilot.buffers')
local target, session_id
local answered = false
local errors = {}
vim.notify = function(message, level)
  if level == vim.log.levels.ERROR then table.insert(errors, message) end
end
vim.ui.select = function(items, _, callback)
  for _, item in ipairs(items) do
    if item.session then callback(item) return end
  end
  callback(items[2])
end
native.setup({
  voice = { preload = false }, session_colors = { enabled = false },
  shared_host = { url = vim.env.MESH_SHARED_URL, token_file = vim.env.MESH_SHARED_TOKEN_FILE },
})
local on_event = native._on_event
native._on_event = function(event)
  if event.type == 'conversation.message' and event.payload.content == 'MESH_NVIM_OK' then
    answered = true
  end
  if event.type == 'hello' then
    local primary = event.payload.status.primary
    if primary then target, session_id = primary.target, primary.sessionId end
  end
  on_event(event)
end
native.open({ reuse_current_tab = true })
assert(vim.wait(30000, function()
  local member = target and buffers.get_member(target)
  return member and table.concat(vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false), '\n')
    :find('MESH_SHARED_OK', 1, true) ~= nil
end, 50), 'shared history did not appear: ' .. table.concat(errors, '; '))
protocol.send('prompt.send', {
  target = target,
  content = 'Isolated editor connectivity test. Do not use tools. Reply with exactly MESH_NVIM_OK.',
})
assert(vim.wait(60000, function()
  local member = buffers.get_member(target)
  return answered and table.concat(vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false), '\n')
    :find('MESH_NVIM_OK', 1, true) ~= nil
end, 50), 'editor did not render shared answer: ' .. table.concat(errors, '; '))
assert(#errors == 0, table.concat(errors, '; '))
protocol.stop_sync()
print('PASS live shared editor attach/send/replay/detach SDK ' .. session_id)
vim.cmd('qa!')
