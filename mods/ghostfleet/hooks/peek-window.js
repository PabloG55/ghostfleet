// The macOS preview window PEEK (register.js) opens by the pointer: a JavaScript for Automation
// program, run as `osascript -l JavaScript -e <PEEK_WINDOW>`, that draws one borderless AppKit
// panel. Nothing to install: osascript and AppKit ship with every macOS.
//
// Ported from the window program of the Image Preview mod in midudev/better-claude
// (plugins/image-preview/hooks/window.ts), changed here only in its variable names:
//
//   MIT License
//
//   Copyright (c) 2026 Miguel Ángel Durán (midudev)
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this
//   software and associated documentation files (the "Software"), to deal in the Software
//   without restriction, including without limitation the rights to use, copy, modify, merge,
//   publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
//   to whom the Software is furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies or
//   substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
//   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
//   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
//   FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
//   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
//
// WHAT IT IS TOLD, in its environment: PEEK_FILE the picture (any format NSImage reads: PNG,
// JPEG, GIF, WebP), PEEK_SIZE its longest side at most in points, PEEK_LIFE how many seconds at
// most it stays. WHAT IT SAYS on stdout: `shown` once the panel is up (or a line starting
// `error`), then `.` every tenth of a second. That tick is the whole of the protocol: the mod's
// `$.process.spawn` loop wakes on each one, sees the pointer has left, leaves the loop, and
// leaving the loop is what kills the child. A program that never ticked could only be ended
// by its own clock, so a preview would outstay the pointer by up to PEEK_LIFE.
//
// THE PANEL never takes the focus or the pointer (an accessory app, a non-activating panel that
// ignores mouse events), so the person keeps typing and hovering in the terminal; it stands
// over every window, full-screen spaces included; and it shows the picture's own pixels at the
// screen's scale, shrunk only to fit PEEK_SIZE and 70% of the screen, never enlarged, which is
// why a screenshot of text reads as it was.

export const PEEK_WINDOW = String.raw`
ObjC.import('Cocoa')

function run () {
  const env = $.NSProcessInfo.processInfo.environment
  const read = key => { const value = env.objectForKey(key); return value.isNil() ? '' : ObjC.unwrap(value) }
  const say = text => $.NSFileHandle.fileHandleWithStandardOutput.writeData($(text + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  const largest = Number(read('PEEK_SIZE')) || 800
  // An accessory app: no Dock icon, never the active one.
  $.NSApplication.sharedApplication.setActivationPolicy(1)
  const image = $.NSImage.alloc.initWithContentsOfFile(read('PEEK_FILE'))
  if (image.isNil() || image.representations.count === 0) { say('error: cannot read the image'); return }
  const pixels = image.representations.firstObject
  const mouse = $.NSEvent.mouseLocation
  const screens = $.NSScreen.screens
  let screen = $.NSScreen.mainScreen
  for (let i = 0; i < screens.count; i++) {
    const frame = screens.objectAtIndex(i).frame
    if (mouse.x >= frame.origin.x && mouse.x < frame.origin.x + frame.size.width && mouse.y >= frame.origin.y && mouse.y < frame.origin.y + frame.size.height) screen = screens.objectAtIndex(i)
  }
  const area = screen.visibleFrame
  let width = pixels.pixelsWide / screen.backingScaleFactor
  let height = pixels.pixelsHigh / screen.backingScaleFactor
  const fit = Math.min(1, largest / Math.max(width, height), (area.size.width * 0.7) / width, (area.size.height * 0.7) / height)
  width = Math.round(width * fit)
  height = Math.round(height * fit)
  const pad = 6
  const gap = 18
  const outer = { width: width + pad * 2, height: height + pad * 2 }
  const top = area.origin.y + area.size.height
  const right = area.origin.x + area.size.width
  // Above the pointer and to its right; under it, or to its left, where there is no room: never
  // over the pointer, which stays on the terminal.
  let x = mouse.x + gap
  let y = mouse.y + gap
  if (y + outer.height > top) y = mouse.y - gap - outer.height
  if (x + outer.width > right) x = mouse.x - gap - outer.width
  x = Math.max(area.origin.x, Math.min(x, right - outer.width))
  y = Math.max(area.origin.y, Math.min(y, top - outer.height))
  // Borderless and non-activating; over every app window, on every space, full-screen ones too.
  const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(x, y, outer.width, outer.height), 128, 2, false)
  panel.level = 25
  panel.ignoresMouseEvents = true
  panel.hasShadow = true
  panel.opaque = false
  panel.backgroundColor = $.NSColor.clearColor
  panel.collectionBehavior = 1 | 16 | 256
  const backdrop = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, outer.width, outer.height))
  backdrop.material = 13
  backdrop.state = 1
  backdrop.wantsLayer = true
  backdrop.layer.cornerRadius = 10
  backdrop.layer.masksToBounds = true
  const view = $.NSImageView.alloc.initWithFrame($.NSMakeRect(pad, pad, width, height))
  view.image = image
  view.imageScaling = 3
  backdrop.addSubview(view)
  panel.contentView = backdrop
  panel.orderFrontRegardless
  say('shown')
  const end = Date.now() + (Number(read('PEEK_LIFE')) || 120) * 1000
  while (Date.now() < end) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1))
    say('.')
  }
}
`
