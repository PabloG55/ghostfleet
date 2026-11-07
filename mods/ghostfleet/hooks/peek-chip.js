// PEEK's pointer target, a surface module (`Client`, module "./peek-chip.js"): it runs on the
// drawing thread, has no `$`, and its one way to reach the hooks in register.js is
// `surface.post`, which arrives there as a `ui.message` naming this instance's key.
//
// It posts `{ isOver }` when the pointer comes onto it, moves on it and leaves it, and
// `{ isOver: true, isClicked: true }` for a click; register.js opens and closes the preview,
// or opens the picture in the system's viewer. With a `label` prop it draws a chip (the row
// above the prompt); with none it is an unpainted region laid over text the engine drew
// (`[Image #N]` in a sent prompt, and the rows listed under it), so that text shows exactly as
// the engine drew it and still takes the pointer.
//
// Its two non-obvious moves follow the chip of the Image Preview mod in midudev/better-claude
// (plugins/image-preview/hooks/chip.tsx), MIT, Copyright (c) 2026 Miguel Ángel Durán (midudev);
// the notice is in ./peek-window.js. A CLICK is the left button let go over the chip it went
// down on, because after a `down` the instance holds the pointer and its `up` may land
// anywhere. And an ENTER says so again a frame later: going straight from one chip to the
// next, the first one's leave and the second one's enter can post in the same frame, and a
// later post in a frame replaces the earlier, so the enter can be lost and the preview with it.

const AGAIN_MS = 50

export default function PeekChip(props, surface) {
  const label = props && typeof props.label === 'string' ? props.label : undefined
  surface.onPointer(event => {
    const st = surface.state || {}
    if (event.type === 'down') {
      if (event.button === 'left') surface.setState({ isOver: true, isPressed: true })
      return
    }
    if (event.type === 'up') {
      // A region not laid out yet (0 by 0) cannot say where the pointer is: take it as inside.
      const inside = surface.columns === 0
        || (event.x >= 0 && event.y >= 0 && event.x < surface.columns && event.y < surface.rows)
      if (st.isPressed && inside) surface.post({ isOver: true, isClicked: true })
      surface.setState({ isOver: inside, isPressed: false })
      return
    }
    // A move says it again, so a preview a keystroke closed comes back on the next move.
    const isOver = event.type !== 'leave'
    surface.post({ isOver })
    if (isOver !== Boolean(st.isOver)) surface.setState({ isOver, isPressed: Boolean(st.isPressed) })
    if (event.type === 'enter') {
      const stop = surface.every(AGAIN_MS, () => {
        stop()
        if (surface.state && surface.state.isOver) surface.post({ isOver: true })
      })
    }
  })
  const { Box, Text } = surface.elements
  if (label === undefined) return h(Box, {})
  return h(Text, { color: 'cyan', inverse: Boolean(surface.state && surface.state.isOver) }, label)
}
