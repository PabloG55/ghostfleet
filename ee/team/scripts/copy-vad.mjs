// Silero VAD runs in the browser, and its model, worklet and onnxruntime's wasm are fetched at
// run time — so they are served by this app, from web/public/vad-<version>/ (no CDN: the voice
// stays on this machine). The folder carries the version so the year-long cache never serves
// an old model to a new client; web/ui/voice.js (the shared assistant's voice) names the same folder.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const vadDir = path.dirname(require.resolve('@ricky0123/vad-web/package.json'));
// onnxruntime-web does not export its package.json: find its root from its entry point, as
// seen from vad-web (the copy vad-web bundles is the one whose wasm has to match).
const ortMain = createRequire(path.join(vadDir, 'package.json')).resolve('onnxruntime-web');
const ortDir = ortMain.slice(0, ortMain.lastIndexOf(`${path.sep}dist${path.sep}`));
const { version } = JSON.parse(fs.readFileSync(path.join(vadDir, 'package.json'), 'utf8'));

const name = `vad-${version}`;
const voiceJs = fs.readFileSync(path.join(root, '../../web/ui/voice.js'), 'utf8');
if (!voiceJs.includes(`'/${name}/'`)) {
  console.error(`copy-vad: web/ui/voice.js does not point at /${name}/ — update VAD_DIR when upgrading @ricky0123/vad-web`);
  process.exit(1);
}
const out = path.join(root, 'web/public', name);
fs.mkdirSync(out, { recursive: true });
for (const old of fs.readdirSync(path.join(root, 'web/public'))) {
  if (old.startsWith('vad-') && old !== name) fs.rmSync(path.join(root, 'web/public', old), { recursive: true, force: true });
}
const files = [
  [vadDir, 'dist/silero_vad_v5.onnx'],
  [vadDir, 'dist/vad.worklet.bundle.min.js'],
  [ortDir, 'dist/ort-wasm-simd-threaded.wasm'],
  [ortDir, 'dist/ort-wasm-simd-threaded.mjs'],
];
for (const [dir, rel] of files) fs.copyFileSync(path.join(dir, rel), path.join(out, path.basename(rel)));
console.log(`copy-vad: ${files.length} files in web/public/${name}/`);
