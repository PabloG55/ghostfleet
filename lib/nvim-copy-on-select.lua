-- nvim-copy-on-select.lua — a mouse drag in the editor tab copies, like every other pane.
--
-- Loaded by bin/fleet-tab with `nvim -c "luafile <this>"`, so it reaches the editor tab
-- and nothing else: never ~/.config/nvim, never an nvim somebody starts by hand.
--
-- WHY THE EDITOR NEEDS ITS OWN. Everywhere else in the fleet a drag ends in tmux's
-- copy-mode, where MouseDragEnd1Pane pipes it to fleet-copy (tmux/cf.tmux.conf). An nvim
-- with `mouse=a` (LazyVim sets it) asks the terminal for the mouse, so tmux's default
-- MouseDrag1Pane sees #{mouse_any_flag} and hands the drag to nvim instead: nvim makes a
-- visual selection, tmux never enters copy-mode, and the clipboard is never touched.
--
-- MOUSE ONLY. Measured through an attached client with cf.tmux.conf: a drag arrives as
-- <LeftMouse> and <LeftDrag> in normal mode, then <LeftDrag> and <LeftRelease> in VISUAL
-- mode — and a keyboard `v`/`V` selection never produces a visual-mode <LeftRelease>, so
-- hooking that one key is what tells the two apart. A plain click releases in normal
-- mode and copies nothing. Editing must never overwrite the clipboard behind your back.
--
-- THROUGH fleet-copy, NOT the `+` register. fleet-copy is the fleet's one clipboard path
-- across macOS, Wayland, X11 and WSL; nvim's clipboard provider may be absent inside
-- tmux, or be a different tool from the one the rest of the fleet writes with.

-- The binding's own resolution, `#{?#{@cf_bin},#{@cf_bin}/,}fleet-copy`, read from the
-- server this pane lives on ($TMUX), not from nvim's PATH.
local function fleet_copy()
  local bin = ''
  if (vim.env.TMUX or '') ~= '' then
    bin = vim.fn.system({ 'tmux', 'show-options', '-gqv', '@cf_bin' }):gsub('%s+$', '')
    if vim.v.shell_error ~= 0 then bin = '' end
  end
  return bin ~= '' and (bin .. '/fleet-copy') or 'fleet-copy'
end

-- Exactly what `y` would yank: linewise ends in a newline, blockwise is one line per row.
local function selected(mode)
  if vim.fn.exists('*getregion') == 1 then
    local text = table.concat(vim.fn.getregion(vim.fn.getpos('v'), vim.fn.getpos('.'), { type = mode }), '\n')
    return mode == 'V' and text .. '\n' or text
  end
  -- Before nvim 0.10 there is no getregion, so yank into a scratch register and put
  -- everything back. noautocmd keeps TextYankPost quiet (LazyVim flashes on it, and a
  -- clipboard plugin may copy on it), and the unnamed register is restored WITH what it
  -- pointed to, or the next `p` would paste the scratch register instead of your yank.
  local z, unnamed = vim.fn.getreginfo('z'), vim.fn.getreginfo('"')
  vim.cmd('silent noautocmd normal! "zy')
  local text = vim.fn.getreg('z')
  vim.fn.setreg('z', z)
  vim.fn.setreg('"', unnamed)
  vim.cmd('silent noautocmd normal! gv')        -- the selection stays highlighted
  return text
end

local function copy()
  local mode = vim.fn.mode()
  if not mode:match('^[vV\22]') then return end
  local text = selected(mode)
  if text == '' then return end
  local cmd = fleet_copy()
  local err = {}
  local job = vim.fn.jobstart({ cmd }, {
    on_stderr = function(_, data) vim.list_extend(err, data) end,
    -- fleet-copy names the missing clipboard tool on stderr; from a mouse release a
    -- silent failure is indistinguishable from a binding that never fired.
    on_exit = function(_, code)
      if code ~= 0 then
        vim.notify('fleet-copy: ' .. vim.trim(table.concat(err, '\n')), vim.log.levels.WARN)
      end
    end,
  })
  if job <= 0 then
    vim.notify('fleet-copy: cannot run ' .. cmd, vim.log.levels.WARN)
    return
  end
  vim.fn.chansend(job, text)
  vim.fn.chanclose(job, 'stdin')
end

-- An expr map that hands back the release itself, so nvim's own release still runs and
-- the copy reads the selection after it has settled. Alt is how a mouse makes a BLOCK
-- selection, and its release arrives as <A-LeftRelease>, which <LeftRelease> does not
-- match — measured: an Alt-drag left `-- VISUAL BLOCK --` on screen and copied nothing.
for _, key in ipairs({ '<LeftRelease>', '<A-LeftRelease>' }) do
  vim.keymap.set('x', key, function()
    vim.schedule(copy)
    return key
  end, { expr = true, desc = 'ghostfleet: copy a mouse selection' })
end
