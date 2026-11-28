// lib/whisper-setup.mjs — whisper.cpp for a machine with no Homebrew: built from a pinned
// source tag, into ~/.local/share/whisper beside the model, by `fleet-jarvis voice --install`.
//
// WHY THIS EXISTS. The install path was `brew install whisper-cpp` and nothing else, so on
// a Linux machine — the one a phone is paired with as often as the Mac — the documented
// command died with "there is no Homebrew", and the only way to a voice was to build it by
// hand from a link in the error. Linux distributions do not package whisper-cli (Debian and
// Ubuntu have no such package), so building it is the honest route; what this adds is doing
// it the same way every time, from a tag whose commit is checked, at user level.
//
// WHAT IT WILL NOT DO is install the toolchain. git, cmake, a C++ compiler and make (or
// ninja) are system packages and take sudo; a voice download that quietly ran a package
// manager as root would be the last thing an owner expects from "install the speech model".
// So a missing tool is a stop with code 3 — the same code lib/kokoro-setup.mjs uses for a
// missing Python — naming each tool and the one line that installs them on this distro.
//
// PINNED BY COMMIT, NOT BY TAG. A tag can be moved; the clone is of the tag and then the
// commit it resolved to must be the one written here, or nothing is built. CLAUDE_FLEET_WHISPER_PIN
// (JSON: {repo, tag, commit}) overrides it, for the suite and for whoever needs a newer one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MODEL_DIR } from './jarvis.mjs';

export const PIN = { repo: 'https://github.com/ggml-org/whisper.cpp.git', tag: 'v1.9.5', commit: 'd1be6fde11ac6e0407606b4e42fe72d34add8037' };
export function pin() {
  try { const p = JSON.parse(process.env.CLAUDE_FLEET_WHISPER_PIN || ''); if (p && p.repo && p.tag && p.commit) return p; } catch {}
  return PIN;
}

// Asked of PATH directly, not of a shell's `command -v`: the answer has to be the same one the
// spawns below will get, and a shell started for the question is one more PATH to disagree with.
export function onPath(name, PATH = process.env.PATH || '') {
  for (const d of PATH.split(path.delimiter)) {
    if (!d) continue;
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return '';
}
const firstOf = (names) => { for (const n of names) { const f = onPath(n); if (f) return f; } return ''; };

// What the build needs, each as the label the message uses and the binary that satisfies it.
export function tools() {
  return {
    git: firstOf(['git']),
    cmake: firstOf(['cmake']),
    'a C++ compiler': firstOf(['c++', 'g++', 'clang++']),
    'make or ninja': firstOf(['make', 'ninja']),
  };
}
export const missing = (t = tools()) => Object.keys(t).filter(k => !t[k]);

// The one line that installs the toolchain, for the distro /etc/os-release names. Unknown is
// not guessed at: the message names the tools and leaves the package manager to the owner.
export function installLine(osRelease = readOsRelease(), platform = process.platform) {
  if (platform === 'darwin') return 'xcode-select --install   (and cmake from https://cmake.org/download/)';
  const id = (k) => ((osRelease.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '').replace(/["']/g, '').toLowerCase();
  const fam = `${id('ID')} ${id('ID_LIKE')}`;
  if (/\b(debian|ubuntu)\b/.test(fam)) return 'sudo apt install git cmake build-essential';
  if (/\b(fedora|rhel|centos)\b/.test(fam)) return 'sudo dnf install git cmake gcc-c++ make';
  if (/\barch\b/.test(fam)) return 'sudo pacman -S git cmake base-devel';
  if (/\b(opensuse|suse)\b/.test(fam)) return 'sudo zypper install git cmake gcc-c++ make';
  if (/\balpine\b/.test(fam)) return 'sudo apk add git cmake build-base';
  return '';
}
function readOsRelease() { try { return fs.readFileSync(process.env.CLAUDE_FLEET_OS_RELEASE || '/etc/os-release', 'utf8'); } catch { return ''; } }

export function noToolsMessage(miss, line = installLine()) {
  return `whisper.cpp is not installed and there is no Homebrew, so it is built from source — which needs ${miss.join(', ')}, and this machine has no ${miss.length > 1 ? 'such tools' : 'such tool'} on PATH.\n`
    + (line ? `  Install ${miss.length > 1 ? 'them' : 'it'} (this needs sudo, so it is yours to run):\n    ${line}\n` : `  Install ${miss.length > 1 ? 'them' : 'it'} with this system's package manager.\n`)
    + '  then run again: fleet-jarvis voice --install';
}

// Half the cores for the compile, like whisper's own threads: a build that takes every core
// stalls the sessions running beside it on the same machine.
const jobs = () => Math.max(1, Math.floor((typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) / 2));

// Build and install. Returns {ok, bin} or {ok: false, code, why}; never throws for an expected
// failure, and never leaves a half-written whisper-cli where whisperBin() would find it.
export function build({ dir = MODEL_DIR(), log = (s) => console.log(`fleet-jarvis: ${s}`), stdio = 'inherit' } = {}) {
  const t = tools(), miss = missing(t);
  if (miss.length) return { ok: false, code: 3, why: noToolsMessage(miss) };
  const p = pin();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-whisper-'));
  const src = path.join(tmp, 'src'), out = path.join(src, 'build');
  const run = (bin, args, opts = {}) => spawnSync(bin, args, { stdio, ...opts });
  try {
    log(`building whisper.cpp ${p.tag} from source (no Homebrew here) — a few minutes, into ${dir}`);
    if (run(t.git, ['-c', 'advice.detachedHead=false', 'clone', '-q', '--depth', '1', '--branch', p.tag, p.repo, src]).status !== 0)
      return { ok: false, code: 1, why: `could not clone ${p.repo} at ${p.tag}` };
    const head = spawnSync(t.git, ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    if (head !== p.commit) return { ok: false, code: 1, why: `${p.tag} resolved to ${head || 'nothing'}, not the pinned ${p.commit} — the tag moved, so nothing was built` };
    // Static, so the one file that is installed is the whole program: a shared build would
    // leave whisper-cli pointing into the temp dir that is deleted below.
    const cfg = ['-S', src, '-B', out, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON'];
    if (/ninja$/.test(t['make or ninja'])) cfg.push('-G', 'Ninja');
    if (run(t.cmake, cfg).status !== 0) return { ok: false, code: 1, why: 'cmake could not configure the whisper.cpp build' };
    if (run(t.cmake, ['--build', out, '--config', 'Release', '-j', String(jobs()), '--target', 'whisper-cli']).status !== 0)
      return { ok: false, code: 1, why: 'the whisper.cpp build failed' };
    const built = path.join(out, 'bin', 'whisper-cli');
    if (!fs.existsSync(built)) return { ok: false, code: 1, why: `the build reported success and left no ${path.relative(src, built)}` };
    fs.mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, 'whisper-cli'), part = `${dst}.part`;
    fs.copyFileSync(built, part); fs.chmodSync(part, 0o755);
    // Run before it counts: a binary that cannot start here (a missing libgomp, say) is not
    // a voice, and whisperBin() would report one.
    if (spawnSync(part, ['--help'], { stdio: 'ignore', timeout: 20000 }).status !== 0) {
      try { fs.unlinkSync(part); } catch {}
      return { ok: false, code: 1, why: 'the built whisper-cli does not run on this machine' };
    }
    fs.renameSync(part, dst);
    log(`installed ${dst}`);
    return { ok: true, bin: dst };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
