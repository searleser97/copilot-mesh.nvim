vim.opt.runtimepath:prepend(vim.fn.getcwd())
local calls = {}
local original_create = vim.api.nvim_create_user_command
vim.api.nvim_create_user_command = function(name, callback, opts)
  calls[name] = callback
  return original_create(name, callback, opts)
end

local started, starts, running = nil, 0, false
package.loaded['native_copilot.protocol'] = {
  is_running = function() return running end,
  start = function(opts)
    started, starts, running = opts, starts + 1, true
    return true
  end,
  send = function() return 'test-request' end,
  stop_sync = function() running = false end,
}

-- Exercise both import orders in different fresh Neovim processes.
local legacy_first = vim.env.COPILOT_MESH_LEGACY_FIRST == '1'
local first = require(legacy_first and 'native_copilot' or 'copilot_mesh')
assert(first == require(legacy_first and 'copilot_mesh' or 'native_copilot'))
for _, suffix in ipairs({ 'buffers', 'protocol', 'commands', 'clipboard', 'voice', 'blink' }) do
  assert(require('copilot_mesh.' .. suffix) == require('native_copilot.' .. suffix), suffix)
end
vim.cmd('runtime! plugin/*.lua')
assert(vim.g.loaded_copilot_mesh_nvim and vim.g.loaded_native_copilot_nvim)
first.setup({ voice = { preload = false } })
local count = #vim.api.nvim_get_autocmds({ group = 'CopilotMesh' })
require('native_copilot').setup({ voice = { preload = false } })
assert(#vim.api.nvim_get_autocmds({ group = 'CopilotMesh' }) == count,
  'setup through either alias must not duplicate autocmds')
assert(count == 5)
local suffixes = {
  'Toggle', 'Select', 'Agents', 'Status', 'Tasks', 'Abort',
  'CancelBackground', 'ReloadMcp', 'VoiceSetup',
}
for _, suffix in ipairs(suffixes) do
  assert(calls['CopilotMesh' .. suffix] == calls['NativeCopilot' .. suffix], suffix)
  assert(vim.fn.exists(':CopilotMesh' .. suffix) == 2)
  assert(vim.fn.exists(':NativeCopilot' .. suffix) == 2)
end
vim.cmd('CopilotMeshToggle')
assert(started.database_path == vim.fn.stdpath('data') .. '/native-copilot/state.sqlite',
  'the rename must keep the original persistence location')
vim.cmd('NativeCopilotToggle')
vim.cmd('CopilotMeshToggle')
assert(starts == 1, 'both command aliases must reuse the same host')
first.close()
first.shutdown()
local custom = vim.fn.tempname() .. '.sqlite'
first.setup({ database_path = custom, voice = { preload = false } })
first.open()
assert(started.database_path == custom, 'explicit database selection must be retained')
first.close()
first.shutdown()
vim.api.nvim_create_user_command = original_create
print('PASS canonical and legacy module/command identity, singleton startup and persistence')
vim.cmd('qa!')
