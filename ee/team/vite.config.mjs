import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The browser only ever talks to server/index.mjs; in development vite proxies /api to it.
//
// The shared screens are the MIT core's web/ui/ (its README says what they are), and ansi.js,
// grid.js and md.js are the repo's own web/ files (the phone client's), imported by web/ui's
// ui.jsx and session.jsx rather than copied, so a glyph is the same number of cells here as on
// the phone. All of it is imported by a relative path. It sits outside this package, and still nothing below
// widens server.fs.allow, on purpose. The build follows a relative import anywhere. The dev
// server's allow list stops at ee/team (its own pnpm-workspace.yaml makes it the workspace
// root), but vite serves any file that a served module imports whatever that list says: its
// import analysis adds each resolved import to a safe set before the list is consulted. So
// web/ansi.js, web/grid.js (through ansi.js) and web/md.js load in dev, while a direct request
// for web/app.js, which nothing here imports, is refused, which is the only thing a wider allow
// list would change. The brand's tokens.css (the repo's brand/, imported by web/src/main.jsx)
// is served the same way, and brand/manual.html beside it is refused.
//
// `dedupe` is what keeps that one app. A file in web/ui resolves 'preact' by walking up from
// web/ui, which finds the repo root's node_modules (the phone client's build, another version)
// before it could ever find this package's: two Preacts, and a hook called in a shared screen
// reads a component tree the other copy is rendering, so every useFleet() throws. Deduped, every
// 'preact' and 'preact/*' resolves from this package's root. A checkout with no root install
// would have failed the other way, by not resolving at all.
export default defineConfig({
  root: 'web',
  plugins: [preact()],
  resolve: { dedupe: ['preact'] },
  server: { port: 5190, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8790' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
