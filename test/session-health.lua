vim.opt.runtimepath:prepend(vim.fn.getcwd())
package.loaded['native_copilot.protocol'] = {
  is_running = function() return true end,
  send = function() return 'test-request' end,
}
local native = require('native_copilot')
local buffers = require('native_copilot.buffers')
local notifications = {}
vim.notify = function(message, level) table.insert(notifications, { message, level }) end
native.setup({ voice = { preload = false } })
native._on_event({
  type = 'primary.ready',
  payload = { target = 'agent:test', agentId = 'test', sessionId = 'test-session' },
})
local function emit(kind, payload)
  native._on_event({ type = kind, memberId = 'agent:test', payload = payload, target = 'activity' })
end
emit('member.state', { state = 'busy', turnId = 'turn' })
emit('member.stalled', { message = 'No progress; request still pending.' })
local member = buffers.get_member('agent:test')
assert(member.state == 'busy', 'warning must not mark the SDK idle')
assert(member.health_warning == 'No progress; request still pending.')
assert(notifications[#notifications][2] == vim.log.levels.WARN)
native.show_status()
local status_buffer = vim.api.nvim_get_current_buf()
local function status_text()
  return table.concat(vim.api.nvim_buf_get_lines(status_buffer, 0, -1, false), '\n')
end
assert(status_text():find('No progress; request still pending.', 1, true))
emit('member.progress', { message = 'Copilot activity resumed.' })
assert(member.health_warning == nil)
assert(not status_text():find('No progress; request still pending.', 1, true))
assert(member.state == 'busy', 'resumed progress is not turn completion')
emit('conversation.delta', { messageId = 'new-reply', content = 'New response ' })
local conversation = member.views.conversation
local active_message = conversation.active_message
local awaiting_response = conversation.awaiting_response
for _, kind in ipairs({ 'session.idle', 'assistant.turn_end', 'session.error', 'assistant.message', 'tool.execution_complete' }) do
  emit('recovery.historical_event', {
    eventId = 'old-' .. kind, eventType = kind,
    data = { content = 'Recovered old text', message = 'Recovered old error', turnId = 'turn' },
  })
  assert(member.state == 'busy', 'historical event must not change current UI state')
  assert(conversation.active_message == active_message, 'historical event must not complete current output')
  assert(conversation.awaiting_response == awaiting_response)
end
emit('member.recovery_warning', { message = 'Recovery degraded: ordering unknown.' })
assert(member.state == 'busy')
assert(status_text():find('Recovery degraded: ordering unknown.', 1, true))
emit('member.recovery_resumed', { message = 'Ordering established.' })
assert(not status_text():find('Recovery degraded: ordering unknown.', 1, true))
emit('conversation.delta', { messageId = 'new-reply', content = 'continues.' })
assert(conversation.active_message == active_message)
emit('member.error', { message = 'SDK error' })
assert(member.state == 'error')
emit('member.state', { state = 'idle' })
assert(member.state == 'idle')
emit('recovery.historical_event', {
  eventId = 'older-error-after-completion', eventType = 'session.error', data = { message = 'Old error' },
})
assert(member.state == 'idle', 'historical error must not reopen a completed turn')
print('PASS stalled/resumed/error/completion UI state')
vim.cmd('qa!')
