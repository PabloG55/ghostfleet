import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('Security explains the shell trust boundary and the shared address range', () => {
  const security = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('## Security')[1];
  assert.match(security, /grants.*API/i);
  assert.match(security, /dedicated OS user/i);
  assert.match(security, /sessions cannot read.*GFW_DATA/i);
  assert.match(security, /trust.*shell/i);
  assert.match(security, /carrier-grade NAT/i);
});
