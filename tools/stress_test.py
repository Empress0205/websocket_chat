"""
Stress test: how does the chat server cope with lots of users at once?

It starts its own copy of the server on a free port, with a throwaway database,
so your real server (port 8765) and your real chat.db are never touched.
Then it adds fake users in steps (10, then 50, 100, 200 by default). At each
step every user logs in, joins #general and chats for a while, and the script
measures how long joining took and how fast messages arrived.

Run it from the project folder:
    python tools/stress_test.py
    python tools/stress_test.py --steps 10,100,300 --rate 1
    python tools/stress_test.py --no-server-log     # see what printing costs

To watch it happen in the chat page, stop your normal server first (Ctrl+C in
its terminal), then:
    python tools/stress_test.py --watch --steps 10,50
The test server then uses port 8765, where the page connects, still with a
throwaway database. Log in to the page with the account it prints.
"""
import argparse
import asyncio
import json
import os
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import websockets
from websockets.asyncio.client import connect

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

PASSWORD = "stress-test-password"
WATCH_PORT = 8765  # the port the chat page connects to
WATCHER = "watcher"  # the account you log in with to watch, in --watch mode
# Each chat text ends with "[STRESS@<send time>]", so the receiver can time it.
MARKER = "STRESS@"


# --- The server, run in its own process ---------------------------------------

async def run_server(port, db_path, stats_path, quiet):
    """Run the real chat server code, pointed at the test database and port."""
    import db
    import server

    if quiet:
        server.print = lambda *args, **kwargs: None  # silence the server's own logging
    db.init_db(db_path)

    async def write_stats():
        # Every half second: wall clock, CPU time used, and connected clients.
        # The test reads this to work out how busy the server was.
        while True:
            Path(stats_path).write_text(f"{time.time()} {time.process_time()} {len(server.clients)}")
            await asyncio.sleep(0.5)

    asyncio.create_task(write_stats())
    async with websockets.serve(server.handler, "localhost", port,
                                ping_interval=server.PING_INTERVAL, ping_timeout=server.PING_TIMEOUT):
        await asyncio.Future()


def read_stats(stats_path):
    for _ in range(20):  # the file can be mid-write; try again briefly
        try:
            wall, cpu, online = Path(stats_path).read_text().split()
            return float(wall), float(cpu), int(online)
        except (OSError, ValueError):
            time.sleep(0.05)
    return None


# --- One fake user ------------------------------------------------------------

class Stats:
    """Shared counters for the step that's running."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.sent = 0
        self.delivered = 0
        self.latencies = []  # seconds from send to arrival, for every delivery
        self.too_fast = 0
        self.errors = 0


class FakeUser:
    def __init__(self, n, url, stats, state):
        self.name = f"stress_{n:03d}"
        self.url = url
        self.stats = stats
        self.state = state  # state["chatting"] says whether to send messages now
        self.ws = None
        self.logged_in = asyncio.Event()
        self.joined = asyncio.Event()
        self.failed = None

    async def start(self, rate):
        """Connect, log in and join #general. Returns once joined (or failed)."""
        try:
            self.ws = await connect(self.url, open_timeout=60, ping_interval=None, max_size=None)
        except Exception as e:  # noqa: BLE001 - any failure counts as "couldn't connect"
            self.failed = f"connect: {e!r}"
            return
        asyncio.create_task(self.read_loop())
        await self.ws.send(json.dumps({"type": "login", "username": self.name, "password": PASSWORD}))
        try:
            await asyncio.wait_for(self.logged_in.wait(), 120)
            await self.ws.send(json.dumps({"type": "join", "room": "general"}))
            await asyncio.wait_for(self.joined.wait(), 120)
        except asyncio.TimeoutError:
            self.failed = "timed out logging in or joining"
            return
        asyncio.create_task(self.chat_loop(rate))

    async def read_loop(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "chat" and MARKER in str(msg.get("text", "")):
                    sent_at = float(msg["text"].rsplit(MARKER, 1)[1].rstrip("]"))
                    self.stats.delivered += 1
                    self.stats.latencies.append(time.perf_counter() - sent_at)
                elif kind == "auth_ok":
                    self.logged_in.set()
                elif kind == "joined":
                    self.joined.set()
                elif kind == "auth_error":
                    self.failed = f"login refused: {msg.get('text')}"
                    self.logged_in.set()
                elif kind == "error":
                    if "too fast" in str(msg.get("text", "")):
                        self.stats.too_fast += 1
                    else:
                        self.stats.errors += 1
        except websockets.ConnectionClosed:
            pass

    async def chat_loop(self, rate):
        # Spread users out so they don't all send at the same instant.
        await asyncio.sleep((hash(self.name) % 1000) / 1000 / rate)
        count = 0
        while True:
            if self.state["chatting"]:
                count += 1
                text = f"Test message {count} [{MARKER}{time.perf_counter():.4f}]"
                try:
                    await self.ws.send(json.dumps({"type": "chat", "text": text}))
                    self.stats.sent += 1
                except websockets.ConnectionClosed:
                    return
            await asyncio.sleep(1 / rate)


# --- The test itself ----------------------------------------------------------

def free_port():
    with socket.socket() as s:
        s.bind(("localhost", 0))
        return s.getsockname()[1]


def port_in_use(port):
    with socket.socket() as s:
        return s.connect_ex(("localhost", port)) == 0


def wait_for_enter(prompt):
    try:
        input(prompt)
    except EOFError:  # not run from a terminal: carry on
        pass


def make_accounts(db_path, count, watcher):
    """Create the fake users' accounts (and the watcher's) in the test database."""
    import auth
    import db

    db.init_db(db_path)
    password_hash = auth.hash_password(PASSWORD)  # hashing is slow, so do it once for everyone
    for n in range(count):
        db.create_user(f"stress_{n:03d}", password_hash)
    if watcher:
        db.create_user(WATCHER, password_hash)
    db._conn.close()


def ms(seconds):
    return f"{seconds * 1000:,.0f} ms"


async def run_test(args):
    steps = [int(s) for s in args.steps.split(",")]
    workdir = Path(tempfile.mkdtemp(prefix="chat-stress-"))
    db_path, stats_path, log_path = workdir / "stress.db", workdir / "stats.txt", workdir / "server.log"
    if args.watch:
        port = WATCH_PORT
        if port_in_use(port):
            shutil.rmtree(workdir, ignore_errors=True)
            raise SystemExit(f"Port {port} is in use, probably by your normal chat server. "
                             "Stop it with Ctrl+C in its terminal, then run this again.")
    else:
        port = free_port()

    print(f"Creating {max(steps)} test accounts in a throwaway database...")
    make_accounts(db_path, max(steps), args.watch)

    log_file = open(log_path, "w", encoding="utf-8")
    command = [sys.executable, __file__, "--serve", str(port), str(db_path), str(stats_path)]
    if args.no_server_log:
        command.append("--quiet")
    server_proc = subprocess.Popen(command, stdout=log_file, stderr=subprocess.STDOUT,
                                   env={**os.environ, "PYTHONUNBUFFERED": "1"})
    try:
        for _ in range(100):
            if read_stats(stats_path) and server_proc.poll() is None:
                break
            await asyncio.sleep(0.1)
        else:
            raise SystemExit("The test server didn't start. See " + str(log_path))

        log_note = "off" if args.no_server_log else "on (as normal)"
        print(f"Test server on ws://localhost:{port}, server logging {log_note}")
        print(f"Each user sends {args.rate} message(s) a second for {args.duration} s per step.\n")
        if args.watch:
            print("To watch: open the chat page (Live Server) and log in with")
            print(f"    username: {WATCHER}")
            print(f"    password: {PASSWORD}")
            print("Your real accounts and messages aren't in this test database.")
            print("Tip: more than about 50 users makes the page very busy.\n")
            wait_for_enter("Press Enter when you're logged in, to start the test...")

        url = f"ws://localhost:{port}"
        stats, state = Stats(), {"chatting": False}
        users, results = [], []

        for target in steps:
            # 1. Add the new users all at once: connect, log in, join.
            print(f"Step: {target} users. Logging in {target - len(users)} new users...", flush=True)
            new = [FakeUser(n, url, stats, state) for n in range(len(users), target)]
            started = time.perf_counter()
            await asyncio.gather(*(u.start(args.rate) for u in new))
            join_time = time.perf_counter() - started
            users += new
            failed = [u for u in users if u.failed]

            # 2. Everyone chats for a while.
            stats.reset()
            before = read_stats(stats_path)
            state["chatting"] = True
            await asyncio.sleep(args.duration)
            state["chatting"] = False
            after = read_stats(stats_path)
            await asyncio.sleep(3)  # let messages still on their way arrive

            online = len(users) - len(failed)
            expected = stats.sent * online  # every message goes to everyone in #general
            cpu = (after[1] - before[1]) / (after[0] - before[0]) * 100 if before and after else None
            lat = sorted(stats.latencies)
            results.append({
                "users": target,
                "failed": len(failed),
                "join": join_time,
                "sent": stats.sent,
                "per_sec": stats.sent / args.duration,
                "delivered": stats.delivered,
                "missing": max(expected - stats.delivered, 0),
                "p50": statistics.median(lat) if lat else None,
                "p95": lat[int(len(lat) * 0.95) - 1] if lat else None,
                "max": lat[-1] if lat else None,
                "too_fast": stats.too_fast,
                "cpu": cpu,
            })
            r = results[-1]
            print(f"  joined in {r['join']:.1f} s, {r['sent']} messages sent, "
                  f"median delay {ms(r['p50']) if r['p50'] is not None else '-'}", flush=True)
            if failed:
                print(f"  {len(failed)} users failed, e.g. {failed[0].failed}")
            if server_proc.poll() is not None:
                print("  The server stopped! See the log below.")
                break

        print_report(results, args, log_path)
        if args.watch:
            wait_for_enter("\nPress Enter to stop the test server (then start your normal server again)...")
    finally:
        server_proc.terminate()
        server_proc.wait()
        log_file.close()
        shutil.rmtree(workdir, ignore_errors=True)


def print_report(results, args, log_path):
    print("\nResults")
    print("=" * 96)
    header = (f"{'Users':>5} | {'Join time':>9} | {'Msgs/s':>6} | {'Deliveries':>10} | {'Missing':>7} | "
              f"{'Median':>8} | {'95%':>8} | {'Slowest':>8} | {'Server CPU':>10}")
    print(header)
    print("-" * len(header))
    for r in results:
        p50, p95, slowest = (ms(r[k]) if r[k] is not None else "-" for k in ("p50", "p95", "max"))
        cpu = f"{r['cpu']:.0f} %" if r["cpu"] is not None else "-"
        print(f"{r['users']:>5} | {r['join']:>7.1f} s | {r['per_sec']:>6.0f} | {r['delivered']:>10,} | "
              f"{r['missing']:>7,} | {p50:>8} | {p95:>8} | {slowest:>8} | {cpu:>10}")
    print()
    print("Join time:  how long it took the new users at that step to log in and join #general.")
    print("Msgs/s:     chat messages sent per second (all users together).")
    print("Deliveries: copies received. One message to a room of 200 people is 200 deliveries.")
    print("Missing:    deliveries that never arrived (or were still on their way at the end).")
    print("Median/95%/Slowest: time from sending a message to each person receiving it.")
    print("Server CPU: 100 % means one CPU core was fully busy. The server uses only one core.")
    too_fast = sum(r["too_fast"] for r in results)
    if too_fast:
        print(f"\nThe rate limiter answered 'too fast' {too_fast} times.")
    if not args.no_server_log:
        lines = sum(1 for _ in open(log_path, encoding="utf-8", errors="replace"))
        print(f"The server printed {lines:,} log lines. Try --no-server-log to see what that costs.")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--serve":
        # Started by the test itself: be the server.
        port, db_path, stats_path = int(sys.argv[2]), sys.argv[3], sys.argv[4]
        asyncio.run(run_server(port, db_path, stats_path, quiet="--quiet" in sys.argv))
        return

    parser = argparse.ArgumentParser(description="Stress test the chat server with many fake users.")
    parser.add_argument("--steps", default="10,50,100,200",
                        help="how many users at each step, e.g. 10,50,100,200")
    parser.add_argument("--duration", type=float, default=15, help="seconds of chatting per step")
    parser.add_argument("--rate", type=float, default=0.5, help="messages a second per user")
    parser.add_argument("--no-server-log", action="store_true",
                        help="stop the server printing every message it receives")
    parser.add_argument("--watch", action="store_true",
                        help="run the test server on port 8765 so you can watch in the chat page")
    asyncio.run(run_test(parser.parse_args()))


if __name__ == "__main__":
    main()
