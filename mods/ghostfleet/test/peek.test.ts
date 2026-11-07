// The PEEK section against the engine (`claude plugin test mods/ghostfleet`): the session's
// pictures in a pane beside the chat and as hover chips under the rows that name them, behind
// the `peek` experimental switch, and nothing at all while it is off.
import { test, expect, mock } from 'claude-code/testing'

// Synthetic, made by ffmpeg's lavfi colour source: a 16x8 PNG and the same as a JPEG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAICAIAAAB/FOjAAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAG0lEQVR4nGNkYDghwMBAPGJhUGAgCYxqIAYAAEplArYbLAx3AAAAAElFTkSuQmCC'

const XD = '/home/u/.config/ghostfleet'
const CWD = '/w/acme-api'

type World = { files: Map<string, string>; links: Set<string>; reads: string[]; opened: string[]; registered: string[]; apiReads: number; msgs: any[]; api: any[] }

function world(on: any, { peek = 'on' as string | null, msgs = [] as any[], api = [] as any[] } = {}): World {
  const w: World = { files: new Map(), links: new Set(), reads: [], opened: [], registered: [], apiReads: 0, msgs, api }
  if (peek !== null) w.files.set(`${XD}/peek.enabled`, `${peek}\n`)
  mock.env(on, { HOME: '/home/u', CLAUDE_FLEET_DIR: '/fleet' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: CWD }))
  on('session.messages', (_$: any, e: any) => {
    if (e && e.as === 'api') { w.apiReads++; return { value: w.api } }
    return { value: w.msgs }
  })
  on('fs.read', (_$: any, e: any) => {
    w.reads.push(e.path)
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: e.as === 'bytes' || e.options?.as === 'bytes' ? { base64: t } : t }
  })
  on('fs.stat', (_$: any, e: any) => {
    const t = w.files.get(e.path)
    if (t === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: Math.floor(t.length * 3 / 4), mtimeMs: 1, isLink: w.links.has(e.path) } }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv]
    let stdout = '', exitCode = 0
    if (argv[0] === 'id') stdout = '501\n'
    else if (argv[0] === '/bin/sh' && argv[2] === 'echo $PPID') stdout = '4242\n'
    else if (argv[0] === '/bin/sh') exitCode = 127 // no ffmpeg in this world
    else if (argv[0] === 'tmux') exitCode = 1
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$: any, e: any) => { w.registered.push(e.name); return { value: { command: e.name } } })
  on('ui.open', (_$: any, e: any) => { w.opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', () => ({ value: undefined }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  // The engine's own row, so a row the mod leaves alone is told from one it drew.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, `engine ${e.component}`)
  })
  return w
}

const COMPLETE = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }
const JPG = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABdAAEBAAAAAAAAAAAAAAAAAAAFBwEBAQEAAAAAAAAAAAAAAAAABgQHEAACAwEBAAAAAAAAAAAAAAAABQcjojJCEQACAgEFAQAAAAAAAAAAAAAABgQjQTEyoYFRQv/AABEIAAgAEAMBEgACEgADEgD/2gAMAwEAAhEDEQA/ACFMVc0ZKEp8jWY4a2chqZkNrb7st8yEFv46BFMVc0ZKCp8l8xw1s5DUzJt62+7LfMhBb+Oj/9k='
const PANE = (bodyColumns = 40, bodyRows = 20) => ({
  component: 'Pane' as const, requestId: 'peek',
  props: { title: 'Picture', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
})
const FULL = { columns: 120, rows: 40, isFullscreen: true }
const ROW = (text: string, viewport: any = FULL) => ({
  component: 'UserMessage' as const, viewport,
  props: { text, origin: { kind: 'human' }, isExpanded: false },
})

async function start($: any, clock: any) {
  await $.session.start({ cwd: CWD, surface: null, isInteractive: true })
  for (let i = 0; i < 4; i++) await clock.advance(10)
}

test('off (a new install has no switch file): no command, no pane, no messages read, rows untouched', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { peek: null, msgs: [{ role: 'user', text: '[Image #1] look at /pics/shot.png', toolUses: [] }] })
  w.files.set('/pics/shot.png', PNG)
  await start($, clock)
  await $.turn.complete(COMPLETE as any)
  await clock.advance(50)
  expect(w.registered).not.toContain('peek')
  expect(w.opened).not.toContain('peek')
  expect(w.reads).not.toContain('/pics/shot.png')
  const ui = await $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', ...ROW('[Image #1] look at /pics/shot.png') } as any)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine UserMessage')
  await ui.unmount()
})

test('...and so is a switch written down as off', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { peek: 'off', msgs: [{ role: 'assistant', text: 'saved /pics/shot.png', toolUses: [] }] })
  w.files.set('/pics/shot.png', PNG)
  await start($, clock)
  expect(w.registered).not.toContain('peek')
  expect(w.opened).not.toContain('peek')
  expect(w.reads).not.toContain('/pics/shot.png')
})

test('a picture path an agent printed: the pane opens on it, drawn as cells', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { msgs: [{ role: 'assistant', text: 'took the screenshot: /pics/shot.png.', toolUses: [] }] })
  w.files.set('/pics/shot.png', PNG)
  await start($, clock)
  expect(w.registered).toContain('peek')
  expect(w.opened).toContain('peek')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'ghostfleet', surface, ...PANE(40) } as any)
    expect((await ui.find({ type: 'Text', text: /shot\.png/ }))?.text).toBe('shot.png · 16×8 · PNG · 1 KB')
    // The terminal draws cells (any terminal, through tmux): 16x8 pixels fit 40 columns as
    // 40 wide and 20 tall in pixels, two to a cell. An app has no Raster and says so.
    const r = await ui.find({ type: 'Raster' })
    if (surface === 'terminal') { expect(r?.props.columns).toBe(40); expect(r?.props.rows).toBe(10) }
    else { expect(r).toBeUndefined(); expect(await ui.find({ type: 'Text', text: 'drawn in the terminal' })).toBeDefined() }
    await ui.unmount()
  }
})

test('a pasted [Image #N]: its bytes from the transcript, paired by number', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, {
    msgs: [{ role: 'user', text: 'see [Image #4] and [Image #3]', toolUses: [] }],
    api: [{ role: 'user', content: [
      { type: 'text', text: 'see [Image #4] and [Image #3]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPG } },
    ] }],
  })
  await start($, clock)
  expect(w.apiReads).toBe(1)
  const ui = await $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', ...PANE(20) } as any)
  // #4 is the newest (the later paste, wherever the text puts it), and the SECOND image
  // block: #3 was pasted first. It is the JPEG, and this world has no ffmpeg: words, not cells.
  expect((await ui.find({ type: 'Text', text: /Image #4/ }))?.text).toBe('[Image #4] · 16×8 · JPEG · 1 KB')
  expect((await ui.find({ type: 'Text', text: /ffmpeg/ }))?.text).toBe('no ffmpeg on PATH to decode it')
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  // Picking #3 from the list draws the PNG.
  await ui.press({ key: 'pick-img-3' })
  expect((await ui.find({ type: 'Raster' }))?.props.columns).toBe(20)
  await ui.unmount()
})

test('hover chips: under a row that names a picture, fullscreen only', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { msgs: [{ role: 'user', text: 'what about /pics/shot.png', toolUses: [] }] })
  w.files.set('/pics/shot.png', PNG)
  await start($, clock)
  const ui = await $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', ...ROW('what about /pics/shot.png') } as any)
  const chip = await ui.find({ type: 'Button', text: /shot\.png/ })
  expect(chip?.text).toBe('▣ shot.png')
  // The engine's row is kept, and the picture is already drawn, hidden until hovered.
  expect(await ui.find({ type: 'Text', text: 'engine UserMessage' })).toBeDefined()
  const card = (await ui.findAll({ type: 'Box' })).find(b => b.props.display === 'none')
  // (A tree's `hover` is the surface's and never crosses to a found element.)
  expect(card?.props.position).toBe('absolute')
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  // A click puts it in the pane.
  w.opened.length = 0
  await ui.press({ key: 'peek-' + chip!.key!.slice('peek-'.length) })
  expect(w.opened).toContain('peek')
  await ui.unmount()
  // On the main screen nothing reports the pointer: the row is the engine's alone.
  const plain = await $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', ...ROW('what about /pics/shot.png', { columns: 120, rows: 40, isFullscreen: false }) } as any)
  expect(await plain.findAll({ type: 'Button' })).toHaveLength(0)
  await plain.unmount()
})

test('only what the session named, and never through a symbolic link', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { msgs: [{ role: 'assistant', text: 'look at /pics/link.png', toolUses: [] }] })
  w.files.set('/pics/link.png', PNG)
  w.files.set('/pics/other.png', PNG)
  w.links.add('/pics/link.png')
  await start($, clock)
  expect(w.reads).not.toContain('/pics/link.png')
  expect(w.reads).not.toContain('/pics/other.png')
  const ui = await $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', ...PANE(40) } as any)
  expect((await ui.find({ type: 'Text', text: /symbolic/ }))?.text).toBe('a symbolic link: not followed')
  await ui.unmount()
})

test('/peek lists the pictures newest first and /peek <n> shows one', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { msgs: [
    { role: 'assistant', text: 'first /pics/a.png', toolUses: [] },
    { role: 'assistant', text: 'then /pics/b.png', toolUses: [] },
  ] })
  w.files.set('/pics/a.png', PNG); w.files.set('/pics/b.png', PNG)
  await start($, clock)
  const list = await $.command.run({ command: 'peek', args: '' } as any)
  expect((list as any).text.split('\n').slice(1).map((l: string) => l.trim())).toEqual(['1    /pics/b.png', '2    /pics/a.png'])
  const two = await $.command.run({ command: 'peek', args: '2' } as any)
  expect((two as any).text).toBe('peek: showing a.png · 16×8 · PNG · 1 KB')
  const ui = await $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', ...PANE(40) } as any)
  expect((await ui.find({ type: 'Text', text: /a\.png ·/ }))?.text).toBe('a.png · 16×8 · PNG · 1 KB')
  await ui.unmount()
})

test('turning the switch off mid-session closes the pane and forgets the pictures', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, { msgs: [{ role: 'assistant', text: 'saved /pics/shot.png', toolUses: [] }] })
  w.files.set('/pics/shot.png', PNG)
  await start($, clock)
  w.files.set(`${XD}/peek.enabled`, 'off\n')
  await $.turn.complete(COMPLETE as any)
  await clock.advance(10)
  const r = await $.command.run({ command: 'peek', args: '' } as any)
  expect((r as any).text).toBe('peek is experimental and disabled — enable with: fleet-experimental enable peek')
  const ui = await $.ui.mount({ plugin: 'ghostfleet', surface: 'terminal', ...ROW('saved /pics/shot.png') } as any)
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  await ui.unmount()
})
