# Synthetic terminal sessions only: no network, configured identity, or private keys.
import os, pty, subprocess, fcntl, termios, struct, select, time, signal, json, sys
import pyte
from pathlib import Path

def run(term, kitty):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH',24,80,0,0))
    before = termios.tcgetattr(slave)
    def setup():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY,0)
    env = {**os.environ, 'TERM':term,'COLORTERM':'truecolor'}
    for k in ['CI','QUAIVAULT_PRIVATE_KEY','QUAIVAULT_PRIVATE_KEY_FILE']:
        env.pop(k,None)
    proc = subprocess.Popen([sys.argv[2], sys.argv[1]],stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=setup)
    screen=pyte.Screen(80,24); stream=pyte.Stream(screen); raw=b''; answered=False
    def read(seconds=.3):
        nonlocal raw,answered
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            if select.select([master],[],[],.02)[0]:
                try: data=os.read(master,65536)
                except OSError: break
                raw+=data
                stream.feed(data.decode('utf8','replace'))
                if kitty and not answered and b'\x1b[?u' in raw:
                    os.write(master,b'\x1b[?1u'); answered=True
    def expect_raw(needle):
        end=time.monotonic()+5
        while needle not in raw and time.monotonic()<end: read(.1)
        assert needle in raw, repr(raw[-500:])
    def frame(): return '\n'.join(screen.display)
    def send(data): os.write(master,data);read()
    def snap(label):
        if os.environ.get('QV_TUI_CAPTURE_DIR'):
            directory = Path(os.environ['QV_TUI_CAPTURE_DIR'])
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f'{term}-{label}.txt').write_text(frame())
    try:
        read(1.5);snap('inbox')
        assert 'QuaiVault' in frame(),frame()
        send(b'\x1b[13u' if kitty else b'\r')
        assert 'Decoded as' in frame(),frame()
        send(b'\x1b[F');snap('detail-end')
        assert '0000000000000000000000000000000000000023' in frame(),frame()
        send(b'?');assert 'Keyboard guide' in frame()
        send(b'\x1b[F');assert 'Mouse selection stays available' in frame()
        send(b'?')
        send(b'a');expect_raw(b'CHILD_REVIEW')
        send(b'TEST-INPUT\n');expect_raw(b'CHILD_RECEIVED:TEST-INPUT')
        expect_raw(b'Press any key to return')
        send(b'z');assert 'QuaiVault' in frame()
        send(b'q');send(b'8');send(b'\r')
        send(b'\x1b[200~0x00a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3\x1b[201~')
        snap('form')
        assert 'Field 1/' in frame()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',12,40,0,0));screen.resize(12,40);os.kill(proc.pid,signal.SIGWINCH);read();snap('narrow-form')
        assert 'Esc leave' in frame(),frame()
        send(b'\x1b');send(b'q')
        proc.wait(timeout=4);read(.1)
        after=termios.tcgetattr(slave)
        assert before[3] & (termios.ICANON|termios.ECHO) == after[3] & (termios.ICANON|termios.ECHO)
        assert b'\x1b[?1049h' in raw and b'\x1b[?1049l' in raw
        assert b'\x1b[?2004h' in raw and b'\x1b[?2004l' in raw
        if kitty: assert b'\x1b[>1u' in raw and b'\x1b[<u' in raw
        return {'TERM':term,'kitty_protocol':answered,'exit':proc.returncode,'raw_mode_restored':True,'bytes':len(raw)}
    except:
        snap('failure');raise
    finally:
        if proc.poll() is None: proc.kill();proc.wait()
        os.close(master);os.close(slave)

for term,kitty in [('xterm-kitty',True),('xterm-256color',False),('tmux-256color',False)]:
    print(json.dumps(run(term,kitty)),flush=True)
