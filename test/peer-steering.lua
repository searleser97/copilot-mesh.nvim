vim.opt.runtimepath:prepend(vim.fn.getcwd())
local sent = {}
package.loaded['native_copilot.protocol'] = {
  is_running = function() return true end,
  stop_sync = function() end,
  send = function(kind, payload)
    table.insert(sent, { kind = kind, payload = payload })
    return tostring(#sent)
  end,
}
local native = require('native_copilot')
local buffers = require('native_copilot.buffers')
native.setup({ voice = { preload = false } })
native._on_event({
  type = 'primary.ready',
  payload = { target = 'agent:test', agentId = 'test', sessionId = 'test-session' },
})
local function emit(kind, payload)
  native._on_event({ type = kind, memberId = 'agent:test', payload = payload })
end
emit('member.state', { state = 'busy', turnId = 'turn' })
native.open()
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_get_name(buf):match('AI Prompt$') then
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { 'Queued user task' })
  end
end
native.enqueue_prompt()
emit('conversation.delta', { messageId = 'response', content = 'Working ' })
local member = buffers.get_member('agent:test')
local response = member.views.conversation.active_message
emit('mailbox.queued', { source = 'peer', target = 'test', content = 'Update' })
emit('mailbox.delivered', { source = 'peer', target = 'test', content = 'Update' })
assert(member.state == 'busy', 'acceptance must not mark idle or complete a response')
assert(member.views.conversation.active_message == response)
emit('agent.prompt', { source = 'peer', sourceAgentId = 'peer-id', content = 'New instruction', delivery = 'steering' })
assert(member.state == 'busy')
emit('conversation.delta', { messageId = 'response', content = 'with new instruction.' })
vim.wait(150)
local function text(view)
  return table.concat(vim.api.nvim_buf_get_lines(member.views[view].buf, 0, -1, false), '\n')
end
assert(text('messages'):find('Queued for delivery', 1, true))
assert(text('messages'):find('Accepted by SDK', 1, true))
assert(text('conversation'):find('peer (steering)', 1, true))
assert(text('conversation'):find('New instruction', 1, true))
assert(text('conversation'):find('with new instruction.', 1, true))
native.show_status()
assert(member.state == 'busy', 'status rendering cannot complete the turn')
assert(#vim.tbl_filter(function(request) return request.kind == 'prompt.send' end, sent) == 0,
  'peer acceptance/injection must not dispatch a queued user prompt')
emit('member.foreground_idle', {})
local prompts = vim.tbl_filter(function(request) return request.kind == 'prompt.send' end, sent)
assert(#prompts == 1 and prompts[1].payload.content == 'Queued user task',
  'queued user prompt must wait for the real foreground idle event')
print('PASS peer steering attribution, acceptance labels, active response and status')
vim.cmd('qa!')
