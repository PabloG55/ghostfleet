// server/claude.mjs — one question to Claude, one JSON answer: `claude -p` with no tools, no MCP
// and nothing kept. It exists only while it thinks, so it costs no memory the rest of the time.
import { spawn } from 'node:child_process';
import { t } from '../shared/i18n/index.js';

export function claudeJson({ system, prompt, schema, timeoutMs = 120000 }) {
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
      '--output-format', 'json', '--model', 'sonnet', '--system-prompt', system, '--json-schema', JSON.stringify(schema), prompt],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMUX: '' } });
    let out = '', err = '';
    const kill = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(kill); resolve({ ok: false, text: t('ai.cantOpen', { why: e.message }) }); });
    child.on('close', () => {
      clearTimeout(kill);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return resolve({ ok: false, text: String(j.result || t('ai.error')).slice(0, 300) });
        resolve({ ok: true, data: j.structured_output || JSON.parse(j.result) });
      } catch {
        resolve({ ok: false, text: (err || out || t('ai.noAnswer')).trim().split('\n').slice(-1)[0].slice(0, 300) });
      }
    });
  });
}
