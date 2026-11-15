// The peer of a Linux loopback socket must belong to this daemon's uid. Match the
// client's whole TCP tuple, not just its ephemeral port (which another address can use).
// Measured in Linux Docker over IPv4 and IPv6: a uid-0 client of a uid-0 daemon is
// trusted; a uid-65534 client is refused. Removing the uid check lets that second user in.
import fs from 'node:fs';
import net from 'node:net';

function addressHex(addr, v6) {
  addr = addr.replace(/%.*/, '');
  if (!v6 && addr.startsWith('::ffff:') && net.isIPv4(addr.slice(7))) addr = addr.slice(7);
  if (net.isIPv4(addr)) {
    if (v6) addr = '::ffff:' + addr;
    else return addr.split('.').reverse().map(x => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  if (!v6) return null;
  if (addr.includes('.')) {
    const i = addr.lastIndexOf(':');
    const n = addr.slice(i + 1).split('.').map(Number);
    addr = addr.slice(0, i + 1) + ((n[0] << 8) | n[1]).toString(16) + ':' + ((n[2] << 8) | n[3]).toString(16);
  }
  const [left, right] = addr.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const parts = right !== undefined ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  if (parts.length !== 8) return null;
  const bytes = Buffer.from(parts.map(x => x.padStart(4, '0')).join(''), 'hex');
  for (let i = 0; i < 16; i += 4) bytes.subarray(i, i + 4).reverse();
  return bytes.toString('hex').toUpperCase();
}
export function connectingUid(socket) {
  for (const v6 of [false, true]) {
    const client = addressHex(socket.remoteAddress, v6), server = addressHex(socket.localAddress, v6);
    if (!client || !server) continue;
    const endpoint = (addr, port) => `${addr}:${port.toString(16).padStart(4, '0').toUpperCase()}`;
    let lines;
    try { lines = fs.readFileSync(v6 ? '/proc/net/tcp6' : '/proc/net/tcp', 'utf8').trim().split('\n').slice(1); } catch { continue; }
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols[1] === endpoint(client, socket.remotePort) && cols[2] === endpoint(server, socket.localPort) && cols[3] === '01' && /^\d+$/.test(cols[7])) return Number(cols[7]);
    }
  }
  return null; // An unreadable proc table is not evidence of ownership.
}
