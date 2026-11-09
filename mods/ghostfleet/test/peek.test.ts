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

// The clients tmux lists for this pane's window (`peek-shape.js CLIENT_FORMAT`): its last input,
// the window it shows, its XTVERSION answer, its TERM.
const client = (at: number, termtype: string, termname = 'xterm-256color', win = '@1') => `${at}\t${win}\t${termtype}\t${termname}`
// A Linux machine reached over SSH, the session in the fleet's tmux there, as `fleet-spawn` starts it.
const SSH_TMUX = { TERM_PROGRAM: 'tmux', TERM: 'tmux-256color', TMUX: '/tmp/tmux-1000/cf-acme-api,1,0', TMUX_PANE: '%1', SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }

type Opts = {
  peek?: string | null; draft?: string; env?: Record<string, string>; system?: string; images?: Record<string, string>; window?: 'shown' | 'error'; api?: any[]
  /** list-clients rows, for a tmux that answers; absent, every tmux call fails. */
  clients?: string[]
  /** What `$.ui.blit` answers: the engine drawing the picture ({}), or its alt. */
  blit?: any
  /** What a shrinker writes, by the side it is asked for (`as-is` for none). */
  shrunk?: Record<string, string>
}

function world(on: any, { peek = 'on', draft = '', env = MAC_TMUX, system = 'Darwin', images = { '3.png': PNG }, window = 'shown', api = [], clients, blit = {}, shrunk = {} }: Opts = {}) {
  const files = new Map<string, string>()
  if (peek !== null) files.set(`${XD}/peek.enabled`, `${peek}\n`)
  for (const [name, b64] of Object.entries(images)) files.set(`${FOLDER}/images/${name}`, b64)
  const box = { text: draft }
  const w = { files, box, runs: [] as string[][], reads: [] as string[], windows: [] as { argv: string[]; env: Record<string, string>; isEnded: boolean }[], api: { reads: 0 }, looks: { n: 0 }, blits: [] as any[] }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_FLEET_DIR: '/fleet', ...env })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('session.messages', (_$: any, e: any) => { if (e && e.as === 'api') w.api.reads++; return { value: e && e.as === 'api' ? api : [] } })
  on('prompt.read', () => { w.looks.n++; return { value: { text: box.text, cursor: box.text.length } } })
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
    else if (argv[0] === 'tmux' && clients && argv.includes('list-clients')) stdout = `${argv.includes('display-message') ? '@1\n' : ''}${clients.join('\n')}\n`
    else if (argv[0] === 'tmux') exitCode = 1
    else if (argv[0] === 'sips') {
      const side = argv.includes('-Z') ? argv[argv.indexOf('-Z') + 1] : 'as-is'
      // As before for a test that names nothing: it says it worked and writes nothing.
      if (shrunk[side] !== undefined) files.set(argv[argv.indexOf('--out') + 1], shrunk[side])
    }
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
  on('ui.blit', (_$: any, e: any) => { w.blits.push(e); return { value: blit } })
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

test('...but on a Mac inside tmux the window comes first, Ghostty attached or not, and tmux is not asked', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', env: { ...MAC_TMUX, KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'ghostty' }, clients: [client(5, 'ghostty 1.1.3')] })
  await start($, w.clock)
  await point(await mount($, BAND), 'chip:3')
  await w.clock.advance(100)
  expect(w.windows.map(x => x.argv[0])).toEqual(['osascript'])
  expect(w.runs.filter(a => a[0] === 'tmux' && a.includes('list-clients'))).toEqual([])
})

// A PNG that says it is 4000x3000 and is more than the engine takes (2 MiB decoded).
const BIG = 'iVBORw0KGgoAAAANSUhEUgAAD6AAAAu4' + 'A'.repeat(3_000_000)

test('over SSH into tmux, Ghostty attached: the terminal draws the picture, sent as PNG bytes, never as a file', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', system: 'Linux', env: SSH_TMUX, clients: [client(5, 'ghostty 1.1.3')] })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Image', props: { source: { png: PNG }, columns: 16, rows: 4 } })
  // tmux was asked which terminal looks, as UTF-8, about this pane's window, as the preview opened.
  const asked = w.runs.filter(a => a[0] === 'tmux' && a.includes('list-clients'))
  expect(asked.length).toBeGreaterThanOrEqual(2)
  expect(asked[0].slice(0, 9)).toEqual(['tmux', '-u', '-S', '/tmp/tmux-1000/cf-acme-api', 'display-message', '-p', '-t', '%1', '#{window_id}'])
  // The engine was asked whether it drew it, with the source it already had: it did.
  await w.clock.advance(1100)
  expect(w.blits[0]).toMatchObject({ requestId: 'above-prompt', key: 'image-3', source: { png: PNG } })
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Image' })
  expect(await band.find({ type: 'Text', text: /cells:/ })).toBeUndefined()
})

test('...and of two terminals on the window, the one with the latest input is looking: an xterm is cells', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', system: 'Linux', env: SSH_TMUX, clients: [client(5, 'ghostty 1.1.3'), client(9, 'XTerm(390)')] })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster', props: { columns: 16, rows: 4 } })
  expect(w.blits).toEqual([])
})

test('tmux is asked as each preview opens: an xterm looking is cells, Ghostty looking at the next one draws it', async ($, on) => {
  const clients = [client(5, 'XTerm(390)')]
  const w = world(on, { draft: '[Image #3]', system: 'Linux', env: SSH_TMUX, clients })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster' })
  await point(band, 'chip:3', 'leave')
  await w.clock.settle()
  // Ghostty attaches over another SSH connection, and it is where the next hover comes from.
  clients.push(client(9, 'ghostty 1.1.3'))
  await point(band, 'chip:3')
  await w.clock.settle()
  await w.clock.advance(1100)
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Image', props: { source: { png: PNG } } })
})

test('the engine drawing it as its alt (the session started with no terminal attached): cells from then on, and why', async ($, on) => {
  const deny = 'the Image draws its alt here: the terminal draws neither kitty placeholder images (probe: tmux passthrough on, but tmux does not know which terminal is outside) nor iTerm2 inline images'
  const w = world(on, { draft: '[Image #3]', system: 'Linux', env: SSH_TMUX, clients: [client(5, 'ghostty 1.1.3')], blit: { deny } })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  await w.clock.advance(1100)
  await w.clock.settle()
  // Never the alt alone where cells draw.
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster', props: { columns: 16, rows: 4 } })
  expect(await band.find({ type: 'Text', text: /^cells: started with no terminal attached/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^\[Image #3\] · 16×8 · PNG/ })).toBeDefined()
  // ...and the next preview does not try again: the engine decided when it started.
  const tried = w.blits.length
  await point(band, 'chip:3', 'leave')
  await w.clock.settle()
  await point(band, 'chip:3')
  await w.clock.settle()
  await w.clock.advance(1100)
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster' })
  expect(w.blits.length).toBe(tried)
})

test('Ghostty over SSH with no tmux draws it too, from bytes: the file is this machine\'s, a blank box over there', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', system: 'Linux', env: { TERM: 'xterm-ghostty', SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' } })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Image', props: { source: { png: PNG } } })
  expect((await band.find({ key: 'image-3' }))?.props.source.file).toBeUndefined()
})

test('CLAUDE_FLEET_PEEK=kitty is taken inside tmux over SSH, with no terminal tmux can name: bytes', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', system: 'Linux', env: { ...SSH_TMUX, CLAUDE_FLEET_PEEK: 'kitty' } })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Image', props: { source: { png: PNG } } })
})

test('a picture larger than the engine takes is shrunk, side by side, till its PNG fits, and sent as those bytes', async ($, on) => {
  // The card's widest side still comes out too big; the next one fits.
  const w = world(on, { draft: '[Image #3]', system: 'Darwin', env: { ...SSH_TMUX }, clients: [client(5, 'ghostty 1.1.3')],
    images: { '3.png': BIG }, shrunk: { '1600': BIG, '1200': PNG } })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  const sides = w.runs.filter(a => a[0] === 'sips').map(a => a[a.indexOf('-Z') + 1])
  expect(sides).toEqual(['1600', '1200'])
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Image', props: { source: { png: PNG } } })
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

// What an earlier copy of the mod left in $.state, the way a reload hands it to the new one: the
// host keeps a plugin's state across /reload-plugins, the module starts over. Read from the seed
// until the mod writes the value itself.
function seeded(on: any, values: Record<string, unknown>) {
  const written = new Set<string>()
  on('state.get', (_$: any, e: any, next: any) => (e.key in values && !written.has(e.key) ? { value: { value: values[e.key], version: 1 } } : next(e)))
  on('state.set', (_$: any, e: any, next: any) => { written.add(e.key); return next(e) })
}

// Measured on a scratch session: [Image #1] read, /reload-plugins, and the new copy's look found
// #1 already read and never read it again, with no pixels to draw: a card that said loading.
test('after a reload a paste the copy before read is read again by this one, and drawn', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', env: { ...MAC_TMUX, CLAUDE_FLEET_PEEK: 'cells' } })
  seeded(on, {
    peekOn: true, peekDraft: [3], peekShown: null,
    peekPics: { 3: { label: '[Image #3]', file: `${FOLDER}/images/3.png`, format: 'png', bytes: 120, width: 16, height: 8, ready: true } },
  })
  await start($, w.clock)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(w.reads).toContain(`${FOLDER}/images/3.png`)
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster' })
  expect(await band.find({ type: 'Text', text: /loading/ })).toBeUndefined()
  // And this copy looks at the box, once a half second: a paste after the reload is found.
  await point(band, 'chip:3', 'leave')
  const before = w.looks.n
  w.box.text = '[Image #3] [Image #4]'
  await w.clock.advance(2000)
  expect(w.looks.n - before).toBe(4)
  expect(await band.find({ key: 'chip:4' })).toBeDefined()
})

// One look every half second, however many times the session starts again in one module (/clear).
test('one poll at a time: starting again, and turns ending, never add a second look', async ($, on) => {
  const w = world(on)
  await start($, w.clock)
  for (let i = 0; i < 3; i++) await start($, w.clock)
  await $.turn.complete(COMPLETE as any)
  await $.turn.complete(COMPLETE as any)
  const before = w.looks.n
  await w.clock.advance(2000)
  expect(w.looks.n - before).toBe(4)
})

// A copy of the module the engine started in place of a lost one: no session.start reaches it
// before the turn that was running ends. It learns from the session that it is drawn in a
// terminal, looks at the box from then on, and reads the paste there itself.
test('a copy whose first event is a turn\'s end still looks at the box, once every half second', async ($, on) => {
  const w = world(on, { draft: '[Image #3]', env: { ...MAC_TMUX, CLAUDE_FLEET_PEEK: 'cells' } })
  on('session.surfaces', () => ({ value: ['terminal'] }))
  await $.turn.complete(COMPLETE as any)
  await w.clock.settle()
  const before = w.looks.n
  await w.clock.advance(2000)
  expect(w.looks.n - before).toBe(4)
  const band = await mount($, BAND)
  await point(band, 'chip:3')
  await w.clock.settle()
  expect(await band.find({ key: 'image-3' })).toMatchObject({ type: 'Raster' })
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
