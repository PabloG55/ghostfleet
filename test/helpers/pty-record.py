#!/usr/bin/env python3
# A terminal with no window: runs a command (a tmux attach) on a pty of its own, writes every
# byte the command sends it to a file, and answers XTVERSION the way the named terminal does.
#
#   pty-record.py --record FILE [--xtversion 'ghostty 1.1.3'] [--size 100x30] [--seconds 20] -- CMD…
#   pty-record.py --count FILE MARK     how many kitty graphics commands carrying MARK arrived
#                                       bare (`\e_G…MARK…\e\\`, what the terminal draws), and
#                                       how many still in tmux's wrapper (`\ePtmux;…`)
#
# WHY. Passthrough is a question about what tmux writes to the terminal outside it, and only an
# attached client is written to: capture-pane reads the pane, which is the other side. tmux
# 3.3+ asks an attaching terminal XTVERSION and keeps the answer as `client_termtype`, which is
# how Claude Code (and PEEK) tell Ghostty from a plain terminal through tmux, so the stand-in
# answers it. It ends when the command does, or after --seconds, whichever is first.
import os, pty, select, signal, struct, sys, time, fcntl, termios


def count(path, mark):
    data = open(path, 'rb').read()
    mark = mark.encode()
    bare = wrapped = 0
    i = 0
    while True:
        i = data.find(b'\x1b_G', i)
        if i < 0:
            break
        end = data.find(b'\x1b\\', i)
        # Inside the wrapper every ESC is doubled, so `\e\e_G` is a wrapped one, not bare.
        if end > 0 and mark in data[i:end] and not (i > 0 and data[i - 1] == 0x1b):
            bare += 1
        i += 3
    i = 0
    while True:
        i = data.find(b'\x1bPtmux;', i)
        if i < 0:
            break
        if mark in data[i:i + 4096]:
            wrapped += 1
        i += 7
    print(f'bare={bare} wrapped={wrapped}')


def record(args):
    out, xtv, cols, rows, secs = None, None, 100, 30, 20.0
    while args and args[0] != '--':
        k = args.pop(0)
        if k == '--record': out = args.pop(0)
        elif k == '--xtversion': xtv = args.pop(0)
        elif k == '--size': cols, rows = map(int, args.pop(0).split('x'))
        elif k == '--seconds': secs = float(args.pop(0))
        else: sys.exit('pty-record: unknown ' + k)
    argv = args[1:]
    if not out or not argv:
        sys.exit('pty-record: --record FILE -- CMD…')
    pid, fd = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        os.execvp(argv[0], argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    seen = b''
    end = time.time() + secs
    with open(out, 'wb') as f:
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if not r:
                continue
            try:
                b = os.read(fd, 65536)
            except OSError:
                break  # the command ended: the pty is gone
            if not b:
                break
            f.write(b); f.flush()
            seen = (seen + b)[-4096:]
            for q in (b'\x1b[>q', b'\x1b[>0q'):
                while q in seen:
                    seen = seen.replace(q, b'', 1)
                    if xtv:
                        os.write(fd, b'\x1bP>|' + xtv.encode() + b'\x1b\\')
        else:
            os.kill(pid, signal.SIGTERM)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['--count']:
        count(a[1], a[2])
    else:
        record(a)
