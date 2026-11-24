"""
Message storage for the chat server, using SQLite.

SQLite keeps the whole database in a single file (chat.db) and comes built into
Python, so there is nothing extra to install or run.
"""
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

# The database file lives next to this script.
DB_PATH = Path(__file__).with_name("chat.db")

HISTORY_LIMIT = 50  # how many messages to send at a time

_conn = None


def init_db(path=DB_PATH):
    """Open the database and create the table the first time it runs."""
    global _conn
    _conn = sqlite3.connect(path)
    _conn.row_factory = sqlite3.Row  # rows behave like dicts: row["text"]
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            room        TEXT NOT NULL,
            sender_id   TEXT NOT NULL,
            sender_name TEXT NOT NULL,
            text        TEXT NOT NULL,
            sent_at     TEXT NOT NULL
        )
    """)
    # An index makes "the latest messages in this room" fast, even with
    # thousands of messages, because SQLite doesn't have to scan the whole table.
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_room_id ON messages (room, id)")
    _conn.commit()


def save_message(room, sender_id, sender_name, text):
    """Store one chat message and return it as the server will send it."""
    sent_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # The ? placeholders let SQLite insert the values safely. Building the SQL
    # with f-strings would let a message like  '); DROP TABLE messages; --
    # run as SQL (an "SQL injection" attack).
    cur = _conn.execute(
        "INSERT INTO messages (room, sender_id, sender_name, text, sent_at) VALUES (?, ?, ?, ?, ?)",
        (room, sender_id, sender_name, text, sent_at),
    )
    _conn.commit()
    return _to_message(cur.lastrowid, room, sender_id, sender_name, text, sent_at)


def get_history(room, before_id=None, limit=HISTORY_LIMIT):
    """
    Return up to `limit` messages from a room, oldest first, and whether
    there are even older ones.

    `before_id` is for "load more": only messages older than that one.
    """
    before_id = before_id or 2**63 - 1  # no limit means "from the newest"
    # Ask for one extra row: if it comes back, there are more to load.
    rows = _conn.execute(
        "SELECT * FROM messages WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?",
        (room, before_id, limit + 1),
    ).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    rows.reverse()  # we fetched newest first; the page wants oldest first
    messages = [
        _to_message(r["id"], r["room"], r["sender_id"], r["sender_name"], r["text"], r["sent_at"])
        for r in rows
    ]
    return messages, more


def _to_message(msg_id, room, sender_id, sender_name, text, sent_at):
    """The same shape as a live "chat" message, so the page treats both alike."""
    return {"type": "chat", "msg_id": msg_id, "room": room, "id": sender_id,
            "name": sender_name, "text": text, "sent_at": sent_at}
