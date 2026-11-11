// Only loaded by the license tests (node --import). The server and admin-cli.mjs verify keys
// against ee/seats/public-key.mjs, which ships EMPTY until the owner installs the real public
// key, so a process started from the shipped tree refuses every key. A test that has to see a
// key ACCEPTED by a real process swaps that one module for the disposable pair it generated:
// TEST_LICENSE_PUBLIC_KEY (a PEM) and TEST_LICENSE_RENEW_URL. Nothing in the product reads
// those variables; the swap exists only in a process started with this preload.
//   registerHooks where node has it (it runs in this thread and newer nodes deprecate the
// other one); register() for the node 20 the package still supports.
import * as nodeModule from 'node:module';

const swapped = () =>
  `export const PUBLIC_KEY = ${JSON.stringify(process.env.TEST_LICENSE_PUBLIC_KEY || '')};\n` +
  `export const RENEW_URL = ${JSON.stringify(process.env.TEST_LICENSE_RENEW_URL || '')};\n`;
const isKeyFile = (url) => url.endsWith('/ee/seats/public-key.mjs');

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    load(url, context, next) {
      return isKeyFile(url) ? { format: 'module', shortCircuit: true, source: swapped() } : next(url, context);
    },
  });
} else {
  const hooks = `export async function load(url, context, next) {
    if (!(${isKeyFile.toString()})(url)) return next(url, context);
    return { format: 'module', shortCircuit: true, source: ${JSON.stringify(swapped())} };
  }`;
  nodeModule.register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}
