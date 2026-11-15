// Exercise the governor's real functions in one shell: the empty-pass cache must survive
// ticks. All commands see a private HOME, fleet directory and tmux namespace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'governor-idle-'));
const q = s => "'" + String(s).replaceAll("'", "'\\''") + "'";
const write = (p, s) => { fs.writeFileSync(p, s); fs.chmodSync(p, 0o755); };
const source = process.argv[2] || path.join(root, 'bin/fleet-governor');
const measure = process.argv.includes('--measure');
const env = { ...process.env, HOME: dir + '/home', CLAUDE_CONFIG_DIR: dir + '/home/.claude',
  CLAUDE_FLEET_DIR: dir + '/home/.claude/fleet', TMUX_TMPDIR: dir + '/tmux', TMUX: '',
  CLAUDE_FLEET_SOCK: 'cf-acme-api', CODEX_HOME: dir + '/home/.codex',
  CLAUDE_FLEET_EXPERIMENTAL_DIR: dir + '/home/.config/ghostfleet', CLAUDE_FLEET_GOV_CLOCK: dir + '/clock',
  COUNT_FILE: dir + '/execs', SCENARIO: dir };
for (const p of ['bin', 'home/.claude/fleet', 'home/.config/ghostfleet', 'tmux']) fs.mkdirSync(path.join(dir, p), { recursive: true });
fs.writeFileSync(dir + '/clock', '10000\n');
fs.writeFileSync(dir + '/sessions', 'master\nacme-web\nbilling-svc\n');
fs.writeFileSync(dir + '/level', '2\n');
fs.writeFileSync(dir + '/swap', '95\n');
fs.writeFileSync(dir + '/slept', '0\n');
fs.writeFileSync(dir + '/home/.claude/fleet/hibernate.enabled', '');
const realTmux = spawnSync('/bin/sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).stdout.trim();
// Each shim logs an exec then replaces itself, so it adds no counted child of its own.
for (const name of ['tmux', 'sysctl', 'ps', 'wc', 'tr', 'awk', 'jq', 'stat', 'uname', 'date', 'grep', 'sort', 'head', 'tail', 'cat', 'node', 'dirname', 'fleet-agent']) {
  const found = spawnSync('/bin/sh', ['-c', 'command -v ' + name], { encoding: 'utf8' }).stdout.trim();
  if (!found && name !== 'fleet-agent') continue;
  let body = found ? `exec ${q(found)} "$@"\n` : 'exit 1\n';
  if (name === 'sysctl') body = `named=yes; [ "$1" = -n ] && named=no
for key in "$@"; do
[ "$key" = -n ] || [ "$named" = no ] || printf '%s: ' "$key"
case "$key" in
-n) ;;
kern.memorystatus_vm_pressure_level) read -r level < "$SCENARIO/level"; echo "$level" ;;
kern.maxproc) echo 100000 ;;
vm.swapusage) read -r swap < "$SCENARIO/swap"; echo "total = 100.00M used = $swap.00M free = 0.00M (encrypted)" ;;
*) exit 1 ;;
esac
done\n`;
  if (name === 'tmux' && !measure) body = `case " $* " in
*'#{session_created} #{session_name}'*) n=0; while IFS= read -r slot; do n=$((n+1)); printf '%s %s\\n' "$n" "$slot"; done < "$SCENARIO/sessions"; exit ;;
esac
case " $* " in *list-sessions*) exec /bin/cat "$SCENARIO/sessions" ;; *capture-pane*) echo ' | 50%(2h)' ;; *display-message*) echo 120 ;; esac\n`;
  write(dir + '/bin/' + name, `#!/bin/sh\nprintf '%s\\n' ${q(name)} >> "$COUNT_FILE"\n${body}`);
}
write(dir + '/bin/fleet-hibernate', `#!/bin/sh
printf '%s\\n' hibernate >> "$SCENARIO/passes"
printf '%s\\n' fleet-hibernate >> "$COUNT_FILE"
${measure ? `exec ${q(root + 'bin/fleet-hibernate')} "$@"` : 'read -r slept < "$SCENARIO/slept"; echo "fleet-hibernate: slept $slept session(s)"'}
`);
write(dir + '/bin/fleet-resume', '#!/bin/sh\nprintf resumed >> "$SCENARIO/resumed"\n');
env.PATH = dir + '/bin:' + process.env.PATH;
const prefix = fs.readFileSync(source, 'utf8').split('\nmodelabel=')[0];
write(dir + '/defs', prefix + '\n');
const init = `source ${q(dir + '/defs')} -s cf-acme-api --confirm 0
BIN_DIR=${q(dir + '/bin')}
LIB_DIR=${q(root + 'lib')}
OSTYPE=darwin
notify() { :; }
`;
const run = code => {
  const r = spawnSync('/bin/bash', ['-c', init + code], { env, encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw Error(r.stderr + r.stdout);
  return r.stdout;
};
try {
  if (measure) {
    fs.writeFileSync(dir + '/home/.config/ghostfleet/projects', `acme-api\t${dir}\twork\n`);
    const tmux = (...args) => execFileSync(realTmux, ['-L', 'cf-acme-api', ...args], { env, stdio: 'pipe' });
    for (const slot of ['master', 'acme-web', 'billing-svc']) tmux('new-session', '-d', '-s', slot, 'exec sleep 120');
    for (const [k, v] of Object.entries({ CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CLAUDE_FLEET_DIR: env.CLAUDE_FLEET_DIR, CLAUDE_FLEET_PROFILE: 'work', CLAUDE_FLEET_SOCK: 'cf-acme-api' })) tmux('set-environment', '-g', k, v);
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(dir + '/clock', String(now) + '\n');
    for (const slot of ['master', 'acme-web', 'billing-svc']) {
      fs.writeFileSync(env.CLAUDE_FLEET_DIR + '/' + slot + '.json', JSON.stringify({
        sock: 'cf-acme-api', slot, status: 'ready', ts: now,
        usage: { at: now, limits: { five_hour: { pct: 50 } } }
      }));
    }
    // No conversation ids: these idle fixture sessions are vetoed before any sleep.
    run(`resources
env_tick
resource_tick || accounts_tick || tick
: > "$COUNT_FILE"
GOV_SESSIONS="$(tmux -u -L "$SOCK" list-sessions -F '#{session_name}:#{session_created}')"
env_tick
resource_tick || accounts_tick || tick
printf '\\nCOUNT\\n'
`);

    const lines = fs.readFileSync(env.COUNT_FILE, 'utf8').trim().split('\n');
    console.log(JSON.stringify({ execs: lines.length, byCommand: Object.fromEntries([...new Set(lines)].map(k => [k, lines.filter(x => x === k).length])), aliveSlots: fs.readdirSync(env.CLAUDE_FLEET_DIR + '/alive').flatMap(f => Object.values(JSON.parse(fs.readFileSync(env.CLAUDE_FLEET_DIR + '/alive/' + f, 'utf8')).panes)).sort() }));
  } else {
    const out = run(`
passes() { local n=0 line; if [ -f "$SCENARIO/passes" ]; then while IFS= read -r line; do n=$((n+1)); done < "$SCENARIO/passes"; fi; printf '%s' "$n"; }
row() { printf 'ROW\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3"; }
reset() { HIB_EMPTY_FP=""; HIB_EMPTY_AT=0; : > "$SCENARIO/passes"; }
reset
resources
resource_tick; row 'first pressure tick runs a pass' 1 "$(passes)"
resource_tick; row 'second empty tick skips the pass' 1 "$(passes)"
printf 'scratch\\n' >> "$SCENARIO/sessions"
resource_tick; row 'a session added re-arms the pass' 2 "$(passes)"
resource_tick; row 'unchanged session set stays suppressed' 2 "$(passes)"
printf '11799\\n' > "$SCENARIO/clock"
resource_tick; row 'before 30 minutes stays suppressed' 2 "$(passes)"
printf '11800\\n' > "$SCENARIO/clock"
resource_tick; row 'at 30 minutes re-runs the pass' 3 "$(passes)"
resource_tick; row 'the timed retry is suppressed again' 3 "$(passes)"
printf '{"sock":"cf-acme-api","slot":"acme-web","status":"working"}\\n' > "$FLEET_DIR/scratch.json"
resource_tick; row 'a new status record re-arms' 4 "$(passes)"
printf '{"sock":"cf-acme-api","slot":"acme-web","status":"ready"}\\n' > "$FLEET_DIR/scratch.json"
resource_tick; row 'a status change re-arms within the same second' 5 "$(passes)"
printf '{"sock":"cf-acme-api","slot":"acme-web","status":"ready","ts":99999,"mod":{"hb":99999},"usage":{"at":99999}}\\n' > "$FLEET_DIR/scratch.json"
resource_tick; row 'heartbeat and usage updates do not re-arm' 5 "$(passes)"
: > "$FLEET_DIR/hibernate.enabled"
resource_tick; row 'an unchanged switch does not re-arm' 5 "$(passes)"
rm "$FLEET_DIR/hibernate.enabled"
resource_tick; row 'switch disabled re-arms' 6 "$(passes)"
: > "$FLEET_DIR/hibernate.enabled"
resource_tick; row 'switch enabled re-arms' 7 "$(passes)"
reset
printf '1\\n' > "$SCENARIO/level"
resources; resource_tick; resource_tick
row 'high swap with normal pressure runs no pass' 0 "$(passes)"
printf '2\\n' > "$SCENARIO/level"
resource_tick; row 'high swap with warning pressure runs a pass' 1 "$(passes)"
printf '0\\n' > "$SCENARIO/swap"
resource_tick
row 'swap is read again on the very next tick' 0 "$RES_SWAP_PCT"
reset
printf '95\\n' > "$SCENARIO/swap"; printf '2\\n' > "$SCENARIO/level"
printf '1\\n' > "$SCENARIO/slept"
resources; resource_tick; resource_tick
row 'successful passes stay armed' 2 "$(passes)"
reset
printf '0\\n' > "$SCENARIO/slept"
resources
resource_tick > "$SCENARIO/log"
resource_tick >> "$SCENARIO/log"
row 'empty explanation appears once' 1 "$(grep -c 'nothing sleepable' "$SCENARIO/log")"
reset
OSTYPE=linux-gnu
CLAUDE_FLEET_GOV_MEMINFO="$SCENARIO/meminfo"
printf 'MemTotal: 1000 kB\\nMemAvailable: 500 kB\\nSwapTotal: 1000 kB\\nSwapFree: 50 kB\\n' > "$SCENARIO/meminfo"
resources; resource_tick; resource_tick
row 'Linux high swap with memory headroom runs no pass' 0 "$(passes)"
printf 'MemTotal: 1000 kB\\nMemAvailable: 50 kB\\nSwapTotal: 1000 kB\\nSwapFree: 50 kB\\n' > "$SCENARIO/meminfo"
resource_tick
row 'Linux high swap with low available memory runs a pass' 1 "$(passes)"
reset
printf 'MemTotal: 1000 kB\\nSwapTotal: 1000 kB\\nSwapFree: 50 kB\\n' > "$SCENARIO/meminfo"
resources; resource_tick; resource_tick
row 'Linux missing live memory counter runs no pass' 0 "$(passes)"
reset
OSTYPE=darwin
printf '4\\n' > "$SCENARIO/level"
printf 'governor-resource 1\\n' > "$FLEET_DIR/$SOCK.acme-web.parked"
resources; resource_tick; resource_tick
row 'critical pressure also suppresses an empty second pass' 1 "$(passes)"
: > "$FLEET_DIR/$SOCK.resource-off"
resource_tick
row 'ignoring the resource ceiling releases parks even with a cached plan' resumed "$(cat "$SCENARIO/resumed")"

`);
    process.stdout.write(out.split('\n').filter(l => l.startsWith('ROW\t')).map(l => l.slice(4)).join('\n') + '\n');
  }
} finally {
  if (measure) spawnSync(realTmux, ['-L', 'cf-acme-api', 'kill-server'], { env });
  fs.rmSync(dir, { recursive: true, force: true });
}
