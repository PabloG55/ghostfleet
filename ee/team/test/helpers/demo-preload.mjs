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
const scrypt = crypto.scryptSync;
crypto.scryptSync = (...args) => { record({ kind: 'scrypt', salt: args[1] }); return scrypt(...args); };
const realNow = Date.now;
Date.now = () => realNow() + Number(fs.readFileSync(process.env.TEST_CLOCK, 'utf8'));
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (...args) {
  this.once('listening', () => fs.writeFileSync(process.env.TEST_PORT, String(this.address().port)));
  return listen.apply(this, args);
};
syncBuiltinESMExports();
