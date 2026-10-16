local M = {}
local chats = {}
local journal
local send
local buffers = require('native_copilot.buffers')

local function chat(target)
  chats[target] = chats[target] or { records = {}, pending = {}, more = true }
  return chats[target]
end

local function render(target, first)
  local state = chat(target)
  local buf = buffers.buffer(target)
  if not buf or not vim.api.nvim_buf_is_valid(buf) then return end
  local saved = {}
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    local view = vim.api.nvim_win_call(win, vim.fn.winsaveview)
    local anchor, offset
    local closed = {}
    for _, record in ipairs(state.order or {}) do
      local line = state.lines and state.lines[record.id]
      if line and line <= view.topline then anchor, offset = record.id, view.topline - line end
      if line and vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(line) end) == line then closed[record.id] = true end
    end
    saved[win] = { view = view, anchor = anchor, offset = offset, closed = closed,
      bottom = view.topline + vim.api.nvim_win_get_height(win) >= vim.api.nvim_buf_line_count(buf) }
  end
  state.order = {}
  for _, record in pairs(state.records) do table.insert(state.order, record) end
  table.sort(state.order, function(a, b) return a.ordinal < b.ordinal end)
  local lines = { state.error and ('History error: ' .. state.error .. ' (gR retries)')
    or state.loading and 'Loading older history...'
    or state.more and 'Older messages load near the top. gR: retry/load older; gH: more content'
    or 'Beginning of conversation. gH: more content', '' }
  state.lines = {}
  for _, record in ipairs(state.order) do
    state.lines[record.id] = #lines + 1
    table.insert(lines, '## ' .. record.title)
    for _, line in ipairs(vim.split(record.text, '\n', { plain = true })) do table.insert(lines, line) end
    if record.nextOffset ~= nil and record.nextOffset ~= vim.NIL then
      table.insert(lines, ('[Content preview; %d bytes total. gH loads the next part.]'):format(record.bytes))
    end
    table.insert(lines, '')
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
  for win, item in pairs(saved) do
    if vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_win_call(win, function()
        vim.wo.foldmethod = 'manual'
        vim.cmd('normal! zE')
        for index, record in ipairs(state.order) do
          local start = state.lines[record.id]
          local finish = state.order[index + 1] and state.lines[state.order[index + 1].id] - 2 or #lines - 1
          if finish > start and (record.kind == 'tool' or record.kind == 'reasoning' or record.kind == 'event') then
            vim.cmd(('%d,%dfold'):format(start, finish))
            if not item.closed[record.id] then vim.cmd(start .. 'foldopen') end
          end
        end
        if first or item.bottom then
          vim.api.nvim_win_set_cursor(win, { #lines, 0 })
          vim.cmd('normal! zb')
        else
          local delta = item.anchor and state.lines[item.anchor]
            and (state.lines[item.anchor] + item.offset - item.view.topline) or 0
          item.view.topline = math.max(1, item.view.topline + delta)
          item.view.lnum = math.min(#lines, item.view.lnum + delta)
          vim.fn.winrestview(item.view)
        end
      end)
    end
  end
end

function M.setup(sender) send = sender end
function M.reset(id) chats, journal = {}, id end

function M.load(target, older)
  local state = chat(target)
  if state.loading or (older and not state.more) or (not older and state.loaded) then return end
  state.loading, state.error = true, nil
  send('shared.history', { target = target, before = older and state.before or nil })
end

local function retry(target)
  local state = chat(target)
  state.error = nil
  if next(state.pending) then
    local ids = vim.tbl_keys(state.pending)
    send('shared.history.records', { target = target, ids = ids })
  else M.load(target, state.loaded) end
end

function M.shown(target)
  local buf = buffers.buffer(target)
  if not buf then return end
  local state = chat(target)
  if state.saved then vim.fn.winrestview(state.saved) end
  vim.keymap.set('n', 'gR', function() retry(target) end, { buffer = buf, desc = 'Retry/load older shared history' })
  vim.keymap.set('n', 'gH', function()
    local state, current = chat(target), vim.api.nvim_win_get_cursor(0)[1]
    local selected
    for _, record in ipairs(state.order or {}) do
      if state.lines[record.id] <= current then selected = record end
    end
    if selected and selected.nextOffset ~= nil and selected.nextOffset ~= vim.NIL then
      send('shared.history.content', { target = target, recordId = selected.id,
        offset = selected.nextOffset, revision = selected.revision })
    end
  end, { buffer = buf, desc = 'Load next part of shared record' })
  M.load(target, false)
  if chat(target).loaded then render(target, false) end
end

function M.moved(win)
  if not vim.api.nvim_win_is_valid(win) then return end
  local buf = vim.api.nvim_win_get_buf(win)
  for target, state in pairs(chats) do
    if buffers.buffer(target) == buf and state.loaded and not state.error then
      state.saved = vim.api.nvim_win_call(win, vim.fn.winsaveview)
      local top = vim.api.nvim_win_call(win, function() return vim.fn.line('w0') end)
      if top <= 30 then M.load(target, true) end
    end
  end
end

function M.event(message)
  local target, payload = message.memberId, message.payload or {}
  if payload.journalId and journal and payload.journalId ~= journal then return end
  if not target or not chats[target] then return end
  local state = chat(target)
  if message.type == 'shared.history.changed' then
    for _, id in ipairs(payload.ids or {}) do state.pending[id] = true end
    if #(payload.ids or {}) > 0 then send('shared.history.records', { target = target, ids = payload.ids }) end
    return
  elseif message.type == 'shared.history.error' then
    state.loading, state.error = false, payload.message
  elseif message.type == 'shared.history.content' then
    local record = state.records[payload.id]
    if record and record.revision == payload.revision then
      record.text = record.text .. payload.text
      record.nextOffset = payload.nextOffset
    end
  else
    local first = not state.loaded and message.type == 'shared.history.page'
    for _, record in ipairs(payload.records or {}) do
      local old = state.records[record.id]
      if message.type ~= 'shared.history.records' or not state.before or record.ordinal >= state.before or old then
        if not old or record.revision > old.revision then state.records[record.id] = record end
      end
      state.pending[record.id] = nil
    end
    if message.type == 'shared.history.page' then
      state.before, state.more = payload.before ~= vim.NIL and payload.before or nil, payload.hasMore
      state.loaded, state.loading = true, false
    end
    state.error = nil
    render(target, first)
    return
  end
  render(target, false)
end

return M
