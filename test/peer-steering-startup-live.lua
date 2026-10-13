-- Opt-in isolated :AI -> real Node host -> new SDK session smoke test.
local root = assert(vim.env.PEER_STEERING_ROOT)
local directory = assert(vim.env.PEER_STEERING_WORKSPACE)
local result_path = directory .. '\\startup-result.json'
vim.opt.runtimepath:prepend(root)
vim.env.NATIVE_COPILOT_E2E_PROFILE = nil
vim.ui.select = function(items, _, choose)
  for _, item in ipairs(items) do
    if item.new_session then
      vim.schedule(function() choose(item) end)
      return
    end
  end
  error('Smoke test must only select a new session')
end
local native = require('native_copilot')
local protocol = require('native_copilot.protocol')
local buffers = require('native_copilot.buffers')
local events = {}
local ready
local errors = {}
local original = native._on_event
native._on_event = function(event)
  table.insert(events, event.type)
  if event.type == 'primary.ready' then ready = event.payload end
  if event.type == 'host.error' or event.type == 'member.error' or event.type == 'prompt.failed' then
    table.insert(errors, event.payload)
  end
  original(event)
end
native.setup({
  workspace = directory, database_path = directory .. '\\startup.sqlite',
  runtime_command_resolver = vim.env.PEER_STEERING_RESOLVER,
  voice = { preload = false },
})
vim.api.nvim_create_user_command('AI', function() native.open({ reuse_current_tab = true }) end, {})
local ok, failure = xpcall(function()
  vim.cmd('AI')
  assert(protocol.is_running(), 'actual Node host must be running')
  assert(vim.wait(90000, function() return ready ~= nil or #errors > 0 end, 50), 'new SDK session startup timed out')
  assert(#errors == 0, vim.inspect(errors))
  assert(ready and not ready.recovered, 'must create, never adopt or resume an existing session')
  local prompt
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(buf):match('AI Prompt$') then prompt = buf break end
  end
  assert(prompt, 'prompt UI must exist')
  vim.api.nvim_buf_set_lines(prompt, 0, -1, false, {
    'Do not use any tools. Reply with exactly LIVE_STARTUP_OK.',
  })
  native.submit_prompt()
  assert(vim.wait(90000, function()
    local member = buffers.get_member(ready.target)
    local content = table.concat(vim.api.nvim_buf_get_lines(member.views.conversation.buf, 0, -1, false), '\n')
    return member.state == 'idle' and content:find('LIVE_STARTUP_OK', 1, true) ~= nil
      and vim.tbl_contains(events, 'conversation.message')
  end, 50), 'live model reply/completion timed out')
  assert(#errors == 0, vim.inspect(errors))
  native.show_status()
  local status = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\n')
  assert(status:find(ready.sessionId, 1, true), 'status must expose the new SDK session')
end, debug.traceback)
protocol.stop_sync(15000)
vim.fn.writefile({ vim.json.encode({
  success = ok, failure = not ok and failure or nil, events = events,
  sessionId = ready and ready.sessionId, usedExistingSession = false,
  realHost = true, realSdk = true, isolatedAICommand = true,
}) }, result_path)
if not ok then
  print(failure)
  vim.cmd('cquit 1')
else
  print('PASS isolated :AI startup, real SDK response and status: ' .. ready.sessionId)
  vim.cmd('qa!')
end
