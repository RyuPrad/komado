#!/usr/bin/env python3
"""Minimal end-to-end smoke test for the Ink -> sixel viewer handoff.

Run after `npm run build` on Linux with chafa installed.  The test owns a
throwaway KOMADO_HOME and local manga library; it never reads or writes the
developer's real komado state.
"""

import binascii
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import time
import termios
import zlib


ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "dist" / "cli.js"


def png_chunk(kind, data):
    payload = kind + data
    return struct.pack(">I", len(data)) + payload + struct.pack(">I", binascii.crc32(payload) & 0xFFFFFFFF)


def write_test_png(target, width=48, height=180):
    # A tall, deterministic RGB page exercises full-width scaling and produces
    # more than a status-only frame without depending on Pillow/ImageMagick.
    scanlines = bytearray()
    for y in range(height):
        scanlines.append(0)  # PNG filter: none
        for x in range(width):
            shade = (x * 5 + y * 2) % 256
            scanlines.extend((shade, (shade + y) % 256, 255 - shade))
    data = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(bytes(scanlines), 9))
        + png_chunk(b"IEND", b"")
    )
    target.write_bytes(data)


class PtyApp:
    def __init__(self, env):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        self.master = master
        self.output = bytearray()
        self.proc = subprocess.Popen(
            ["node", str(CLI)],
            cwd=ROOT,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave)

    def read_once(self, timeout=0.1):
        ready, _, _ = select.select([self.master], [], [], timeout)
        if not ready:
            return
        try:
            chunk = os.read(self.master, 65536)
        except OSError:
            return
        self.output.extend(chunk)

    def wait_for(self, needle, timeout=12, start=0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.output.find(needle, start) >= 0:
                return
            if self.proc.poll() is not None:
                self.read_once(0)
                break
            self.read_once()
        tail = bytes(self.output[-2000:])
        raise AssertionError(f"timed out waiting for {needle!r}; exit={self.proc.poll()}; tail={tail!r}")

    def key(self, data, settle=0.2):
        os.write(self.master, data)
        time.sleep(settle)  # Ink consumes one key per data chunk.

    def close(self):
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=3)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        os.close(self.master)


def main():
    if not CLI.is_file():
        raise SystemExit("dist/cli.js is missing; run `npm run build` first")
    if shutil.which("chafa") is None:
        raise SystemExit("chafa is required for the pixel-viewer PTY smoke test")

    with tempfile.TemporaryDirectory(prefix="komado-pty-") as scratch:
        scratch = Path(scratch)
        home = scratch / "home"
        chapter = scratch / "library" / "PTY Smoke Manga" / "Chapter 1"
        chapter.mkdir(parents=True)
        home.mkdir()
        write_test_png(chapter / "page-001.png")
        (home / "config.json").write_text(
            json.dumps({"localLibraryPaths": [str(scratch / "library")]}),
            encoding="utf8",
        )

        env = os.environ.copy()
        env.update({
            "KOMADO_HOME": str(home),
            "KOMADO_FORCE_PIXEL": "1",
            "KOMADO_NO_MOUSE": "1",
            "KOMADO_NO_SMOOTH": "1",
            "KOMADO_SCROLL_DELTA": "0",
            "TERM": "xterm-256color",
        })
        # The host shell must not accidentally enable xterm-only strip scrolling.
        env.pop("XTERM_VERSION", None)

        app = PtyApp(env)
        try:
            app.wait_for(b"Local library")
            app.key(b"j")
            app.key(b"j")
            app.key(b"\r")

            app.wait_for(b"PTY Smoke Manga")
            app.key(b"\r")

            app.wait_for(b"Chapter 1")
            app.key(b"\r")

            # A DCS introducer proves that the raw viewer emitted a sixel frame.
            app.wait_for(b"\x1bP", timeout=20)
            # Wait for the synchronized frame's end, not merely its first bytes:
            # runViewer intentionally enters raw mode only after this initial
            # draw, once Ink's deferred cooked-mode restoration has finished.
            app.wait_for(b"\x1b[?2026l", timeout=20)
            time.sleep(0.5)
            if app.proc.poll() is not None:
                raise AssertionError("the process exited immediately after the first pixel frame")

            # Raw mode consumes SIGINT, so Ctrl+C must be handled as a viewer key
            # and return to the Ink manga screen without killing the process.
            mark = len(app.output)
            app.key(b"\x03", settle=0.35)
            app.wait_for(b"Chapters", start=mark)
            if app.proc.poll() is not None:
                raise AssertionError("Ctrl+C killed the app instead of closing the raw viewer")

            app.key(b"q")
            try:
                code = app.proc.wait(timeout=8)
            except subprocess.TimeoutExpired as err:
                raise AssertionError("application did not exit after q") from err
            if code != 0:
                raise AssertionError(f"application exited with status {code}")
        finally:
            app.close()

    print("PTY pixel-viewer smoke test passed")


if __name__ == "__main__":
    main()
