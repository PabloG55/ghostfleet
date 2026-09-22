// vite.config.mjs — the phone client's build, deliberately the smallest one that can
// compile a component.
//
// WHAT IS BUILT AND WHAT IS NOT. Exactly one entry: web/src/screens.jsx, which holds the
// two ported screens (Projects and the grid), emitted as web/screens.js. web/app.js,
// api.js, grid.js, ansi.js, md.js, passkey.js and sw.js are NOT built — they are served as
// written, the way they have been since there was no build at all. That remains the point:
// a phone-only bug in any of them is still diagnosed by reading the file the phone actually
// fetched, and only one file in web/ is a thing you cannot read that way.
//   ONE ENTRY FOR TWO SCREENS, NOT ONE PER SCREEN, because they share Btn, Icon, VerbBtn,
// Header, ConfirmBar and CardList. Two entries would either duplicate all six into both
// bundles or need a third shared chunk and a third name in sw.js's SHELL list, to save
// nothing: the phone fetches both screens in the same session anyway.
//
// ── NO CONTENT HASHING IN THE FILENAMES, AND THIS IS LOAD-BEARING ──────────────────────
// web/sw.js precaches a hand-written 26-entry SHELL list and carries a CLIENT-HASH digest
// pinned to the bytes of everything in it (test/helpers/pwa-check.mjs enforces the pin).
// A hashed name would make that list build-generated and re-pinned on every build, which
// turns a guard that catches "you changed the client and forgot to bump VERSION" into a
// line somebody re-pastes without reading. Stable names keep the list hand-written, short
// and readable, and keep the pin meaningful.
//   Cache-busting is already solved for this app and not by filenames: the shell is served
// cache-first, and sw.js's VERSION is what makes install() refetch and activate() drop the
// old cache. A hashed filename would be a second, weaker mechanism sitting beside the one
// that works.
//
// ── UNMINIFIED, ALWAYS ────────────────────────────────────────────────────────────────
// The runtime's copy of the client is currently readable, and that is how every phone-only
// bug in this repo has been diagnosed: open the file the device fetched and read it. Losing
// that is the main cost of introducing a build at all, so it is not paid. There is no
// minified mode to turn on by accident — the output is the source, laid out flat, and a
// stack trace from a phone still names something you can find.

import path from 'node:path';

// ── the client's own modules stay OUT of the bundle ───────────────────────────────────
// grid.js and api.js are imported by the ported screen and by app.js alike. Bundling them
// would put a SECOND copy of each inside screens.js, and two copies of grid.js is two
// answers to "how wide is this card" — exactly the split that cells() and the pane view
// exist to prevent. So they are marked external and left as real `import` statements in
// the output, resolved by the browser against web/ at runtime.
//
// THE SPECIFIER MOVES, AND THAT IS WHY `paths` IS HERE. The source lives in web/src/, so
// it imports '../grid.js' — which is what an editor, a type checker and a human reader all
// resolve correctly. The OUTPUT lives in web/, one directory up, where the same file is
// './grid.js'. `output.paths` does that rewrite. Without it the built bundle asks for
// web/../grid.js — the repository root — and the browser gets a 404 for a file that is
// sitting right next to it.
const CLIENT_MODULES = /^\.\.\/(grid|api|ansi|md|passkey)\.js$/;

/** @type {import('vite').Plugin} */
// IT GOES IN THE TOP-LEVEL `plugins`, NOT IN `build.rollupOptions.plugins`, and the
// difference is not cosmetic: rollupOptions.plugins are appended AFTER vite's own
// resolver, so `enforce: 'pre'` is ignored there and vite has already turned '../grid.js'
// into an absolute path before this hook is asked. The failure is silent and looks like
// success — the build exits 0 and quietly inlines a copy of grid.js, which is the exact
// duplication this plugin exists to prevent. Caught by reading the output; nothing else
// would have said so.
const clientModulesStayExternal = {
  name: 'ghostfleet:client-modules-stay-external',
  // `pre`, so this decides before vite's own resolver turns the specifier into an absolute
  // path on disk. Once it has been resolved there is no specifier left to preserve.
  enforce: 'pre',
  resolveId(source) {
    return CLIENT_MODULES.test(source) ? { id: source, external: true } : null;
  },
};

export default {
  plugins: [
    // Rewrites pnpm's content-addressed path back to the flat one, so an npm build and a
    // pnpm build of the same commit are byte-identical. Output-only: it touches comments
    // vite emits, never code.
    {
      name: 'normalise-node-modules-paths',
      renderChunk(code) {
        const out = code.replace(/node_modules\/\.pnpm\/[^/]+\/node_modules\//g, 'node_modules/');
        return out === code ? null : { code: out, map: null };
      },
    },clientModulesStayExternal],
  root: path.resolve(import.meta.dirname),
  // No index.html, no public/. This build has one JS entry and emits one JS file; a public
  // dir would copy web/ over itself.
  publicDir: false,
  esbuild: {
    // The JSX runtime, from preact rather than react. No babel, no @preact/preset-vite:
    // esbuild does the whole transform, which is why the whole toolchain is two direct
    // dependencies and 15 packages on disk, installed in a few seconds.
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  build: {
    outDir: 'web',
    // web/ is the CLIENT, not a build directory: emptying it would delete app.js, the
    // fixtures, the icons and the service worker. Every other guard in this repo would
    // then go red at once, which is small comfort at that point.
    emptyOutDir: false,
    // See the header. There is no mode in which this is true.
    minify: false,
    // iOS is the target and an installed PWA is the case that matters. 16.4 is the floor
    // web/README.md already names (it is where iOS learned Web Push), so it is the floor
    // here too.
    target: 'safari16',
    // A preload polyfill is a second script injected into a page this build does not own —
    // index.html is hand-written and loads app.js itself.
    modulePreload: false,
    // The size table costs a gzip pass over the output on every build, and cf-sync runs
    // this on the way to the phone.
    reportCompressedSize: false,
    rollupOptions: {
      input: { screens: path.resolve(import.meta.dirname, 'web/src/screens.jsx') },
      // THE ENTRY IS A LIBRARY, NOT A PAGE, and without this line the build silently
      // produces nothing. vite's default for an app build is `false` — entries are assumed
      // to be run for their side effects, so their exports are dropped and the tree-shaker
      // then removes everything that was only reachable through them. Measured: the first
      // build emitted 14.8 kB of preact and not one line of the screen, exited 0, and said
      // "✓ built in 13ms". app.js imports mount() from here, so the exports ARE the output.
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'es',
        // PREACT GETS ITS OWN FILE so that screens.js stays readable. npm ships preact
        // pre-minified — `minify: false` cannot undo that — and inlining it would bury the
        // ported screen in 17 kB of single-letter variables, which is exactly the
        // debuggability this build is supposed to keep. Split, web/screens.js is the
        // screens as written and web/preact.js is the dependency, and the one you open on a
        // phone is the one you wrote.
        manualChunks: (id) => (id.includes('node_modules') ? 'preact' : undefined),
        // The three names that would otherwise carry a content hash. Entry and chunk
        // names are what sw.js's SHELL list spells out by hand; an asset name would be
        // too, if this build ever emitted one.
        // BUILT BYTES MUST NOT DEPEND ON WHERE node_modules LIVES. vite labels each region
        // of the bundle with the source file's path, and that path is the INSTALL layout:
        // npm writes `node_modules/preact/…` and pnpm writes
        // `node_modules/.pnpm/preact@10.29.8/node_modules/preact/…`. The code is identical —
        // measured, the only difference between an npm build and a pnpm build of the same
        // commit is six comment lines — but the bytes are not, so the committed output and
        // its CLIENT-HASH pin would flip according to which manager the last person used,
        // and the suite would report a mismatch that means nothing. cf-sync accepts either
        // manager on purpose; this is what makes that safe rather than a trap.
        //   Normalised in renderChunk (below) rather than by turning the comments off: they
        // are worth having when reading the emitted file, which is the whole reason this
        // build stays unminified.
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        // ...and no `_commonjsHelpers`-style preamble file to precache either.
        hoistTransitiveImports: false,
        paths: (id) => (CLIENT_MODULES.test(id) ? id.replace(/^\.\.\//, './') : id),
      },
    },
  },
};
