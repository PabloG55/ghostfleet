// The PEEK section against the engine (`claude plugin test mods/ghostfleet`): a pasted
// `[Image #N]` previewed on hover, from the row above the prompt while it is written and from
// the sent prompt after, in a window by the pointer on macOS, drawn by kitty or Ghostty
// themselves, or as cells; behind the `peek` experimental switch, and nothing while it is off.
//
// Nothing here can hover for real: the harness drives each chip's surface module
// (./hooks/peek-chip.js) with pointer events by its key, which is the same `ui.message` path a
// terminal's pointer takes. The draft is in the box at the start (a test cannot type into it),
// or put there mid-session for the half-second look to find.
import { test, expect, mock } from 'claude-code/testing'

// Synthetic, made by ffmpeg's lavfi colour source: a 16x8 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAG0lEQVR4nGNkYDghwMBAPGJhUGAgCYxqIAYAAEplArYbLAx3AAAAAElFTkSuQmCC'

const XD = '/home/u/.config/ghostfleet'
const CWD = '/w/acme-api'
const FOLDER = '/tmp/claude-501/-w-acme-api/sess-1'
// Inside tmux on a Mac, as every fleet session is: no picture in the terminal, a window.
const MAC_TMUX = { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color', TMUX: '/tmp/tmux-501/cf-acme-api,1,0' }

type Opts = { peek?: string | null; draft?: string; env?: Record<string, string>; system?: string; images?: Record<string, string>; window?: 'shown' | 'error'; api?: any[] }

function world(on: any, { peek = 'on', draft = '', env = MAC_TMUX, system = 'Darwin', images = { '3.png': PNG }, window = 'shown', api = [] }: Opts = {}) {
  const files = new Map<string, string>()
  if (peek !== null) files.set(`${XD}/peek.enabled`, `${peek}\n`)
  for (const [name, b64] of Object.entries(images)) files.set(`${FOLDER}/images/${name}`, b64)
  const box = { text: draft }
  const w = { files, box, runs: [] as string[][], reads: [] as string[], windows: [] as { argv: string[]; env: Record<string, string>; isEnded: boolean }[], api: { reads: 0 } }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_FLEET_DIR: '/fleet', ...env })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('session.messages', (_$: any, e: any) => { if (e && e.as === 'api') w.api.reads++; return { value: e && e.as === 'api' ? api : [] } })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('fs.read', (_$: any, e: any) => {
    w.reads.push(e.path)
    const t = files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: e.as === 'bytes' || e.options?.as === 'bytes' ? { base64: t } : t }
  })
  on('fs.stat', (_$: any, e: any) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: Math.floor(t.length * 3 / 4), mtimeMs: 1, isLink: false } }
  })
  on('fs.list', (_$: any, e: any) => {
    const names = [...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1)).filter(k => !k.includes('/'))
    if (!names.length) throw new Error(`ENOENT ${e.path}`)
    return { value: names.map(name => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    let stdout = '', exitCode = 0
    if (argv[0] === 'id') stdout = '501\n'
    else if (argv[0] === 'uname') stdout = `${system}\n`
    else if (argv[0] === 'tmux') exitCode = 1
    else if (argv[0] === '/bin/sh' && /base64 -d >/.test(argv[2] || '')) files.set(argv[4], e.init?.stdin ?? e.stdin ?? '')
    else if (argv[0] === '/bin/sh' && argv[2] === 'echo $PPID') stdout = '4242\n'
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The window program: `shown` (or an error), then `.` every tenth of a second till ended.
  on('process.spawn', async function* (_$: any, e: any) {
    const opened = { argv: [...e.argv], env: { ...e.env }, isEnded: false }
    w.windows.push(opened)
    try {
      if (window === 'error') {
        yield { stream: 'stdout' as const, text: 'error: no display\n' }
        return { value: { code: 1, signal: null } }
      }
      yield { stream: 'stdout' as const, text: 'shown\n' }
      for (;;) {
        await clock.sleep(100)
        yield { stream: 'stdout' as const, text: '.\n' }
      }
    } finally {
      opened.isEnded = true
    }
  })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('prompt.edit', (_$: any, e: any) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.message', () => ({}))
  // The engine's own drawing, so a slot or a row the mod left alone is told from one it drew.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, `engine ${e.component}`)
  })
  return { ...w, clock }
}

const SCREEN = { columns: 120, rows: 40, isFullscreen: true }
const BAND = { component: 'AbovePrompt' as const, viewport: SCREEN, props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} } }
const SENT = (text: string, requestId = 'm-1') => ({ component: 'UserMessage' as const, requestId, viewport: SCREEN, props: { text, origin: { kind: 'composer' }, isExpanded: false } })
const COMPLETE = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }

async function start($: any, clock: any) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await clock.settle()
}
const mount = ($: any, what: any) => $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', ...what })
const point = (ui: any, key: string, type: 'enter' | 'leave' = 'enter') => ui.pointer({ type, x: 0, y: 0, in: key })
const click = async (ui: any, key: string) => {
  await ui.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: key })
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: key })
}

test('off (a new install has no switch file): no row, the slot and the prompt left alone, no image read', async ($, on) => {
  const w = world(on, { peek: null, draft: 'what is wrong here? [Image #3]' })
  await start($, w.clock)
  await w.clock.advance(1000)
  const band = await mount($, BAND)
  expect(await band.find({ key: 'chip:3' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: 'hover to preview · click to open' })).toBeUndefined()
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine AbovePrompt')
  const sent = await mount($, SENT('look at [Image #3]'))
  expect(await sent.find({ key: 'token:3' })).toBeUndefined()
  expect(await sent.find({ key: 'sent:3' })).toBeUndefined()
  // An edit goes through untouched, and nothing was looked at or started.
  const box = await $.prompt.edit({ origin: { kind: 'composer' }, text: 'x', cursor: 1, start: 1, end: 1, inputText: ' [Image #3]' } as any)
  expect((box as any).text).toBe('x [Image #3]')
  expect(w.reads.filter(p => p.startsWith(FOLDER))).toEqual([])
  expect(w.runs.some(a => a[0] === 'uname' || a[0] === 'sips' || a[0] === 'osascript')).toBe(false)
  expect(w.windows).toHaveLength(0)
})

test('...and so is a switch written down as off', async ($, on) => {
  const w = world(on, { peek: 'off', draft: '[Image #3]' })
  await start($, w.clock)
  const band = await mount($, BAND)
  expect(await band.find({ key: 'chip:3' })).toBeUndefined()
  expect(w.windows).toHaveLength(0)
})

test('a draft with a pasted [Image #3]: a chip row above the prompt, the slot still drawn under it', async ($, on) => {
  const w = world(on, { draft: 'what is wrong here? [Image #3]' })
  await start($, w.clock)
  const band = await mount($, BAND)
  expect(await band.find({ key: 'chip:3' })).toMatchObject({ type: 'Client' })
  expect(await band.find({ type: 'Text', text: '[Image #3]', in: 'chip:3' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'hover to preview · click to open' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'engine AbovePrompt' })).toBeDefined()
})

test('a draft without one: no chip row', async ($, on) => {
  const w = world(on, { draft: 'just words, and a [Image #x]' })
  await start($, w.clock)
  const band = await mount($, BAND)
  expect(await band.findAll({ type: 'Client' })).toHaveLength(0)
  expect(await band.find({ type: 'Text', text: 'hover to preview · click to open' })).toBeUndefined()
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine AbovePrompt')
})

test('a paste lands with no edit event: the half-second look at the box finds it', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  w.box.text = 'and now? [Image #3]'
  await w.clock.advance(500)
  const band = await mount($, BAND)
  expect(await band.find({ key: 'chip:3' })).toBeDefined()
})

test('off the fullscreen layout no pointer is reported: the slot is the engine\'s alone', async ($, on) => {
  const w = world(on, { draft: '[Image #3]' })
  await start($, w.clock)
  const band = await mount($, { ...BAND, viewport: { ...SCREEN, isFullscreen: false } })
  expect(await band.find({ key: 'chip:3' })).toBeUndefined()
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine AbovePrompt')
})

test('on macOS inside tmux the preview is a window by the pointer, ended when the pointer leaves', async ($, on) => {
  const w = world(on, { draft: '[Image #3]' })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.advance(100)
  expect(w.windows).toHaveLength(1)
  expect(w.windows[0].argv.slice(0, 4)).toEqual(['osascript', '-l', 'JavaScript', '-e'])
  expect(w.windows[0].env).toMatchObject({ PEEK_FILE: `${FOLDER}/images/3.png`, PEEK_SIZE: '800', PEEK_LIFE: '120' })
  // Nothing drawn in the terminal meanwhile.
  expect(await band.find({ key: 'image-3' })).toBeUndefined()
  expect(w.windows[0].isEnded).toBe(false)
  await point(band, 'chip:3', 'leave')
  await w.clock.advance(200)
  expect(w.windows[0].isEnded).toBe(true)
})

test('typing ends the window a chip opened: the box can move the chip from under the pointer', async ($, on) => {
  const w = world(on, { draft: '[Image #3]' })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.advance(100)
  await $.prompt.edit({ origin: { kind: 'composer' }, text: '[Image #3]', cursor: 10, start: 10, end: 10, inputText: '?' } as any)
  await w.clock.advance(200)
  expect(w.windows[0].isEnded).toBe(true)
})

test('a window program that shows nothing hands the session to cells', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', window: 'error' })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.advance(500)
  await point(band, 'chip:3', 'leave')
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(w.windows).toHaveLength(1)
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster' })
})

test('over SSH the window would open on the other machine: a card of cells above the chips', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', env: { ...MAC_TMUX, SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' } })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(w.windows).toHaveLength(0)
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster', props: { columns: 16, rows: 4 } })
  // In the flow, not floated: the slot clips what leaves it. The card, then the chips' row.
  expect(await band.find({ key: 'float-3' })).toBeUndefined()
  const texts = (await band.findAll({ type: 'Text' })).map((t: any) => t.text)
  expect(texts.findIndex((t: string) => /^\[Image #3\] · 16×8/.test(t))).toBeLessThan(texts.indexOf('hover to preview · click to open'))
  expect(await band.find({ type: 'Text', text: /^\[Image #3\] · 16×8 · PNG/ })).toBeDefined()
  await point(band, 'chip:3', 'leave')
  await w.clock.settle()
  expect(await band.find({ key: 'image-3' })).toBeUndefined()
})

test('in Ghostty outside tmux the terminal draws the picture itself, from the file', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', env: { TERM_PROGRAM: 'ghostty', TERM: 'xterm-ghostty' } })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(w.windows).toHaveLength(0)
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Image', props: { source: { file: `${FOLDER}/images/3.png`, format: 'png' } } })
})

test('...but Ghostty\'s variables inside tmux are a window: the picture would need passthrough', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', env: { ...MAC_TMUX, KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'ghostty' } })
  await start($, w.clock)
  await point(await mount($, BAND), 'chip:3')
  await w.clock.advance(100)
  expect(w.windows.map(x => x.argv[0])).toEqual(['osascript'])
})

test('on Linux the card is cells (no native window there)', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', system: 'Linux', env: { TERM: 'xterm-256color', DISPLAY: ':0' } })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(w.windows).toHaveLength(0)
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster' })
})

test('a click opens the picture in Preview, and closes the window', async ($, on) => {
  const w = world(on, { draft: '[Image #3]' })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.advance(100)
  await click(band, 'chip:3')
  await w.clock.advance(200)
  expect(w.runs).toContainEqual(['open', '-a', 'Preview', `${FOLDER}/images/3.png`])
  expect(w.windows[0].isEnded).toBe(true)
})

test('sending takes the chips away', async ($, on) => {
  const w = world(on, { draft: '[Image #3]' })
  await start($, w.clock)
  const band = await mount($, BAND)
  // At once, not at the next look at the box (the box is left as it was to tell the two apart).
  await $.prompt.submit({ text: '[Image #3]', wait: false, origin: { kind: 'composer' } } as any)
  await w.clock.settle()
  expect(await band.find({ key: 'chip:3' })).toBeUndefined()
})

test('a sent prompt: a target over its first line\'s [Image #N] and over each row listing one', async ($, on) => {
  const w = world(on, { images: { '1.png': PNG, '2.png': PNG } })
  await start($, w.clock)
  const sent = await mount($, SENT('look at [Image #1] and [Image #2] [Image #1]\nthen [Image #9]'))
  await w.clock.settle()
  expect(await sent.find({ type: 'Text', text: /^engine UserMessage$/ })).toBeDefined()
  expect(await sent.find({ key: 'token:1' })).toMatchObject({ type: 'Client', props: { width: 10, height: 1 } })
  expect(await sent.find({ key: 'token:2' })).toBeDefined()
  expect(await sent.findAll({ key: 'token:1' })).toHaveLength(1)
  expect(await sent.find({ key: 'sent:1' })).toBeDefined()
  expect(await sent.find({ key: 'sent:2' })).toBeDefined()
  // #9 is past the first line, and the session never stored it: no target of either kind.
  expect(await sent.find({ key: 'token:9' })).toBeUndefined()
  expect(await sent.find({ key: 'sent:9' })).toBeUndefined()
  // The targets are unpainted: what shows is the engine's own row.
  expect(await sent.find({ type: 'Text', in: 'sent:1' })).toBeUndefined()

  await point(sent, 'token:2')
  await w.clock.advance(100)
  expect(w.windows.at(-1)!.env.PEEK_FILE).toBe(`${FOLDER}/images/2.png`)
  await point(sent, 'token:2', 'leave')
  await point(sent, 'sent:1')
  await w.clock.advance(300)
  expect(w.windows.map(x => [x.env.PEEK_FILE, x.isEnded])).toEqual([[`${FOLDER}/images/2.png`, true], [`${FOLDER}/images/1.png`, false]])
  await click(sent, 'token:1')
  await w.clock.settle()
  expect(w.runs).toContainEqual(['open', '-a', 'Preview', `${FOLDER}/images/1.png`])
})

test('in cells a sent prompt\'s [Image #N] opens its card above the prompt, not over the transcript', async ($, on) => {
  const w = world(on, { env: { ...MAC_TMUX, CLAUDE_FLEET_PEEK: 'cells' } })
  await start($, w.clock)
  const sent = await mount($, SENT('look at [Image #3]'))
  const band = await mount($, BAND)
  await w.clock.settle()
  expect(await band.findAll({ type: 'Client' })).toHaveLength(0)
  await point(sent, 'token:3')
  await w.clock.settle()
  expect(w.windows).toHaveLength(0)
  expect(await sent.find({ key: 'image-3' })).toBeUndefined()
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster' })
  expect((await band.findAll({ type: 'Text' })).at(-1)?.text).toBe('engine AbovePrompt')
  await point(sent, 'token:3', 'leave')
  await w.clock.settle()
  expect(await band.find({ key: 'image-3' })).toBeUndefined()
})

test('a paste Claude Code kept no copy of: the transcript\'s bytes, written into the mod\'s folder', async ($, on) => {
  const w = world(on, {
    images: {},
    api: [{ role: 'user', content: [{ type: 'text', text: 'see [Image #4]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }],
  })
  await start($, w.clock)
  const sent = await mount($, SENT('see [Image #4]'))
  await w.clock.advance(3000)
  expect(w.api.reads).toBeGreaterThanOrEqual(1)
  expect(w.files.get(`${FOLDER}/ghostfleet-peek/4.png`)).toBe(PNG)
  await point(sent, 'token:4')
  await w.clock.advance(100)
  expect(w.windows[0].env.PEEK_FILE).toBe(`${FOLDER}/ghostfleet-peek/4.png`)
})

test('a stored file that is not a picture is said so, never shown', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', images: { '3.png': 'bm90IGEgcGljdHVyZSBhdCBhbGwsIGp1c3Qgd29yZHM=' }, env: { ...MAC_TMUX, CLAUDE_FLEET_PEEK: 'cells' } })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(await band.find({ type: 'Text', text: /^\[Image #3\] no preview: not a picture this can read/ })).toBeDefined()
  expect(w.windows).toHaveLength(0)
})

test('turning the switch off mid-session takes the row away at the turn\'s end', async ($, on) => {
  const w = world(on, { draft: '[Image #3]' })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.advance(100)
  expect(w.windows[0].isEnded).toBe(false)
  w.files.set(`${XD}/peek.enabled`, 'off\n')
  await $.turn.complete(COMPLETE as any)
  await w.clock.advance(200)
  // The row is gone, the window it opened is ended, and the box is no longer looked at.
  expect(await band.find({ key: 'chip:3' })).toBeUndefined()
  expect(w.windows[0].isEnded).toBe(true)
  const looked = w.runs.length
  w.box.text = '[Image #3] [Image #4]'
  await w.clock.advance(1000)
  expect(w.windows).toHaveLength(1)
  expect(w.runs.length).toBe(looked)
})
