vim.opt.runtimepath:prepend(vim.fn.getcwd())
package.loaded['native_copilot.protocol'] = {
  is_running = function() return true end,
  send = function() return 'test-request' end,
}
local native = require('native_copilot')
local buffers = require('native_copilot.buffers')
local notifications = {}
vim.notify = function(message, level) table.insert(notifications, { message, level }) end
local activity_blocks = {}
local append_activity_block = buffers.append_activity_block
buffers.append_activity_block = function(...)
  table.insert(activity_blocks, { ... })
  return append_activity_block(...)
end
native.setup({ voice = { preload = false } })
native._on_event({
  type = 'primary.ready',
  payload = { target = 'agent:test', agentId = 'test', sessionId = 'test-session' },
})
local function emit(kind, payload)
  native._on_event({ type = kind, memberId = 'agent:test', payload = payload, target = 'activity' })
end
emit('member.state', { state = 'busy', turnId = 'turn' })
local notification_count = #notifications
local activity_count = #activity_blocks
emit('member.stalled', { message = 'No progress; request still pending.' })
local member = buffers.get_member('agent:test')
assert(member.state == 'busy', 'warning must not mark the SDK idle')
assert(member.health_warning == nil)
assert(#notifications == notification_count, 'silence must not trigger a Neovim notification')
assert(#activity_blocks == activity_count, 'silence must not append an activity message')
native.show_status()
local status_buffer = vim.api.nvim_get_current_buf()
local function status_text()
  return table.concat(vim.api.nvim_buf_get_lines(status_buffer, 0, -1, false), '\n')
end
assert(not status_text():find('No progress; request still pending.', 1, true))
emit('member.progress', { message = 'Copilot activity resumed.' })
assert(#notifications == notification_count)
assert(#activity_blocks == activity_count, 'resumed progress must remain quiet')
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
activity_count = #activity_blocks
emit('member.recovery_warning', { message = 'Recovery degraded: ordering unknown.' })
assert(member.state == 'busy')
assert(status_text():find('Recovery degraded: ordering unknown.', 1, true))
emit('member.recovery_resumed', { message = 'Ordering established.' })
assert(not status_text():find('Recovery degraded: ordering unknown.', 1, true))
assert(#notifications == notification_count, 'recovery diagnostics must not notify')
assert(#activity_blocks == activity_count, 'recovery diagnostics belong only in explicit status')
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
