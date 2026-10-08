"""Optional Unix PTY regression smoke; only the synthetic JS store is used."""
import os
import pathlib
import select
import subprocess
import termios
import time

FIXTURE = pathlib.Path(__file__).with_name("credential-cli.cjs")
TOKEN = b"synthetic-pty-test"
START, END = b"\x1b[200~", b"\x1b[201~"


def scenario(chunks, expected, raw_after):
    master, slave = os.openpty()
    process = subprocess.Popen(["node", str(FIXTURE), "set"], stdin=slave, stdout=slave, stderr=slave)
    output = bytearray()

    def collect(seconds=0.05):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], max(0, deadline - time.monotonic()))[0]:
                try:
                    block = os.read(master, 65536)
                except OSError:
                    break
                if not block:
                    break
                output.extend(block)

    try:
        deadline = time.monotonic() + 5
        while b"JWT (hidden" not in output and time.monotonic() < deadline:
            collect()
        assert b"JWT (hidden" in output, "hidden prompt missing"
        assert not termios.tcgetattr(slave)[3] & termios.ECHO
        for index, chunk in enumerate(chunks):
            os.write(master, chunk)
            collect()
            if index in raw_after:
                assert process.poll() is None, "exited before paste finished"
                assert not termios.tcgetattr(slave)[3] & termios.ECHO, "echo restored before paste finished"
        assert process.wait(timeout=5) == expected, "unexpected exit status"
        collect()
        assert TOKEN not in output, "synthetic credential leaked to terminal"
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)


count = 0
for split in range(1, len(START)):
    scenario([START[:split], START[split:] + TOKEN + END, b"\r"], 0, {0, 1})
    count += 1
for split in range(1, len(END)):
    scenario([START + TOKEN + END[:split], END[split:], b"\r"], 0, {0, 1})
    count += 1
for contents, result in [(b"x" * 16385, 1), (b"\0", 1), (b"\n", 1), (b"\x03", 130), (b"\x04", 130), (b"\x1a", 130)]:
    scenario([START + contents, TOKEN + END[:3], END[3:]], result, {0, 1})
    count += 1
scenario([TOKEN, b"\x03"], 130, {0})
count += 1
print(f"{count} synthetic PTY scenarios passed; no credential was echoed and no native vault was used.")
