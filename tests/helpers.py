"""
Shared tools for the tests: a throwaway server, and a scripted chat client.

Every test gets its own copy of the server, on a free port, with a brand-new
database in a temporary folder. So tests never touch your real server (port
8765) or your real chat.db, and one test can't change what another one sees.
"""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))  # so "import server" finds backend/server.py

import auth  # noqa: E402  (these need the path above)
import db  # noqa: E402
import server  # noqa: E402
import voice  # noqa: E402
from ratelimit import RateLimiter  # noqa: E402

PASSWORD = "password123"

# Checking a password is slow on purpose (600,000 rounds, ~0.3 s), to slow
# down attackers. Tests log in dozens of times, so they use far fewer rounds.
# This only changes the copy of auth.py loaded by the tests.
auth.PBKDF2_ROUNDS = 1_000
# Every test user has the same password, so hash it once, not before every test.
PASSWORD_HASH = auth.hash_password(PASSWORD)

# The server prints every message it gets. In tests that buries the results,
# so it's switched off. To see it while working out why a test fails:
#   set SERVER_LOG=1   (PowerShell: $env:SERVER_LOG=1), then run the tests.
if not os.environ.get("SERVER_LOG"):
    server.print = lambda *args, **kwargs: None  # only server.py's print, nothing else's


def _fast_client():
    """
    A new connection's state, as server.py makes it, but with a much higher
    chat rate limit. A test sends messages far faster than any person could,
    and should test the feature, not trip over the limit (which has its own test).
    """
    client = _real_new_client()
    client["message_limit"] = RateLimiter(capacity=1000, per_second=1000)
    return client


_real_new_client = server.new_client


class ServerTestCase(unittest.IsolatedAsyncioTestCase):
    """
    A test that runs against a fresh server. In each test, self.url is where it
    listens, and self.login("alice") connects as one of the ready-made users.
    """

    USERS = ("alice", "bob", "carol", "dave", "erin", "frank")
    ADMINS = ("boss",)
    FAST = True  # lift the chat rate limit (see _fast_client)

    async def asyncSetUp(self):
        # The test runner turns on asyncio's debug mode, which is useful (it
        # catches a forgotten "await"), but it also warns about anything that
        # blocks for over 0.1 s, like creating this test's database on disk.
        # Only warn about blocks over a second.
        asyncio.get_running_loop().slow_callback_duration = 1.0
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        db.init_db(Path(self.tmp.name) / "test.db")
        for name in self.USERS + self.ADMINS:
            db.create_user(name, PASSWORD_HASH)
        for name in self.ADMINS:
            db._conn.execute("UPDATE users SET is_admin = 1 WHERE username = ?", (name,))
        db._conn.commit()
        # Start from a clean slate: nobody connected, no huddles going on, and
        # no login attempts counted (the per-username limit lives in memory, so
        # without this, alice would be "trying too often" by the sixth test).
        server.clients.clear()
        voice.huddles.clear()
        server.login_limits.buckets.clear()
        server.new_client = _fast_client if self.FAST else _real_new_client
        # 127.0.0.1, not "localhost": on Windows, "localhost" is two addresses
        # (IPv6 ::1 and IPv4 127.0.0.1), and port 0 ("any free port") picks a
        # different port on each. A client trying the wrong one first waits
        # about 2 seconds before falling back, which made tests 10x slower.
        self.server = await websockets.serve(server.handler, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{self.port}"
        self.connected = []

    async def asyncTearDown(self):
        for c in self.connected:
            await c.close()
        self.server.close()
        await self.server.wait_closed()
        server.new_client = _real_new_client
        db._conn.close()
        self.tmp.cleanup()

    async def login(self, name, room="general"):
        """Connect, log in as `name`, join a room, and return the client."""
        c = Client(name, self.url)
        await c.open()
        self.connected.append(c)
        await c.send(type="login", username=name, password=PASSWORD)
        c.id = (await c.wait("auth_ok"))["user"]["id"]
        await c.send(type="join", room=room)
        await c.wait("joined")
        return c


class Client:
    """
    A scripted user. Everything the server sends lands in `inbox`; wait()
    takes out the first message of a type (optionally matching some fields).
    """

    def __init__(self, name, url):
        self.name = name
        self.url = url
        self.id = None
        self.inbox = []

    async def open(self):
        self.ws = await websockets.connect(self.url)
        self.reader = asyncio.create_task(self._read())

    async def _read(self):
        try:
            async for raw in self.ws:
                self.inbox.append(json.loads(raw))
        except websockets.ConnectionClosed:
            pass

    async def close(self):
        await self.ws.close()
        self.reader.cancel()

    async def send(self, **message):
        await self.ws.send(json.dumps(message))

    async def wait(self, type_, timeout=3, **fields):
        """The first message of this type with these fields. Fails after `timeout` seconds."""
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while loop.time() < end:
            for i, m in enumerate(self.inbox):
                if m.get("type") == type_ and all(m.get(k) == v for k, v in fields.items()):
                    return self.inbox.pop(i)
            await asyncio.sleep(0.01)
        got = [m.get("type") for m in self.inbox]
        raise AssertionError(f"{self.name} never got {type_} {fields or ''} (inbox: {got})")

    async def nothing(self, type_, wait=0.3):
        """Check that no message of this type arrives in the next `wait` seconds."""
        await asyncio.sleep(wait)
        unexpected = [m for m in self.inbox if m.get("type") == type_]
        if unexpected:
            raise AssertionError(f"{self.name} got an unexpected {type_}: {unexpected[0]}")

    def clear(self):
        self.inbox.clear()
