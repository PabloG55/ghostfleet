#!/usr/bin/env node
// test/helpers/presence-peer.mjs — a paired host that only answers "is someone at a keyboard".
//
//     node presence-peer.mjs --port N --pid <pairing id> --secret <its `in`> --answer <file> --log <file>
//
// The push group's daemon is given this as its one peer, so its at-the-keyboard hold can be
// driven by a PAIRED host's reading without a second fleet-serve and its fleet. It answers
// GET /api/presence with the JSON in --answer (re-read per request, so the suite changes the
// reading by rewriting a file), and it checks the request the way a real host does — with
// lib/peers.mjs's verifySigned against the secret the daemon signs with — so "the daemon asked
// over the pairing" is a logged `verified`, not an assumption. Anything else is a 404.
// The suite kills it by the pid it captured.
import http from 'node:http';
import fs from 'node:fs';
import { verifySigned } from '../../lib/peers.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ''; };
const port = Number(arg('--port')), answer = arg('--answer'), out = arg('--log');
const v = { peers: [{ id: arg('--pid'), in: arg('--secret'), label: 'desk', key: 'desk' }] };
const seen = new Map();
http.createServer((req, res) => {
  const ok = !verifySigned(v, req, req.url, Buffer.alloc(0), seen).error;
  fs.appendFileSync(out, `${req.method} ${req.url} ${ok ? 'verified' : 'refused'}\n`);
  if (!ok) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"needs":"pairing"}'); }
  if (req.method !== 'GET' || req.url !== '/api/presence') { res.writeHead(404); return res.end('{}'); }
  let body = '{"idle":null,"locked":null}';
  try { body = fs.readFileSync(answer, 'utf8'); } catch {}
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}).listen(port, '127.0.0.1', () => fs.appendFileSync(out, `listening ${port}\n`));
