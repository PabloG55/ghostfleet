// Only loaded by the demo HTTP tests. Block subprocesses and record actual calls.
import fs from 'node:fs';
import http from 'node:http';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
const record = (row) => fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(row) + '\n');
cp.spawn = (cmd, args) => {
  record({ kind: 'spawn', cmd, args });
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => {}; child.unref = () => {};
  queueMicrotask(() => child.emit('error', new Error('subprocess blocked by test')));
  return child;
};
cp.execFile = (cmd, ...args) => {
  record({ kind: 'execFile', cmd });
  queueMicrotask(() => args.at(-1)(new Error('subprocess blocked by test'), '', ''));
};
for (const method of ['exec', 'execSync', 'execFileSync', 'spawnSync', 'fork']) {
  cp[method] = (cmd) => {
    record({ kind: method, cmd });
    throw new Error('subprocess blocked by test');
  };
}
const scrypt = crypto.scryptSync;
crypto.scryptSync = (...args) => { record({ kind: 'scrypt', salt: args[1] }); return scrypt(...args); };
const realNow = Date.now;
Date.now = () => realNow() + Number(fs.readFileSync(process.env.TEST_CLOCK, 'utf8'));
const listen = http.Server.prototype.listen;
// Supply upgrade head deterministically: TCP may otherwise split a pipelined frame
// into a later data event, making a test of the head argument pass without using it.
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
  if (event === 'upgrade' && args[0].headers['x-test-upgrade-head'])
    args[2] = Buffer.concat([Buffer.from(args[0].headers['x-test-upgrade-head'], 'base64'), args[2]]);
  return emit.call(this, event, ...args);
};
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => fs.writeFileSync(process.env.TEST_PORT, String(this.address().port)));
  return listen.apply(this, args);
};
syncBuiltinESMExports();
