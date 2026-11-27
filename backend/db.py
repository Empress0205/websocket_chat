"""
Message storage for the chat server, using SQLite.

SQLite keeps the whole database in a single file (chat.db) and comes built into
Python, so there is nothing extra to install or run.
"""
import json
import sqlite3
from datetime import datetime, timedelta, timezone
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

    # Phase 4: accounts. COLLATE NOCASE means "Alice" and "alice" count as the
    # same username, so nobody can register a look-alike.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            created_at    TEXT NOT NULL
        )
    """)
    # One row per login. We store a hash of the token, never the token itself.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users (id),
            expires_at TEXT NOT NULL
        )
    """)

    # Admins can create rooms and decide who may enter them. Older databases
    # don't have this column yet, so add it if it's missing (a "migration").
    columns = [row["name"] for row in _conn.execute("PRAGMA table_info(users)")]
    if "is_admin" not in columns:
        _conn.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")

    # Rooms: public rooms are open to everyone; private ones only to members.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            name       TEXT PRIMARY KEY,
            is_public  INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    # Who may enter which private room: one row per (room, user) pair.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS room_members (
            room    TEXT NOT NULL REFERENCES rooms (name),
            user_id INTEGER NOT NULL REFERENCES users (id),
            PRIMARY KEY (room, user_id)
        )
    """)
    # Phase 5: how far each person has read in each conversation (a room name,
    # or a private chat's "dm:1:2" key). Unread badges, messages waiting for
    # someone who was offline, and read receipts all come from this one table.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS reads (
            user_id   INTEGER NOT NULL REFERENCES users (id),
            conv      TEXT NOT NULL,
            last_read INTEGER NOT NULL,
            PRIMARY KEY (user_id, conv)
        )
    """)
    # Polls. A poll appears in a conversation as a message whose poll_id points
    # here, so history, private chats and unread counts work for polls too.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS polls (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            conv       TEXT NOT NULL,
            creator_id INTEGER NOT NULL REFERENCES users (id),
            question   TEXT NOT NULL,
            options    TEXT NOT NULL,
            closed     INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    # One row per person per poll: the PRIMARY KEY makes voting twice impossible.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS poll_votes (
            poll_id INTEGER NOT NULL REFERENCES polls (id),
            user_id INTEGER NOT NULL REFERENCES users (id),
            option  INTEGER NOT NULL,
            PRIMARY KEY (poll_id, user_id)
        )
    """)
    # Drawing board: every finished line, arrow or text, per conversation.
    # Points are stored as JSON: [x1, y1, x2, y2, ...] on a 1000 x 1250 board.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS board_strokes (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            conv       TEXT NOT NULL,
            user_id    INTEGER NOT NULL REFERENCES users (id),
            tool       TEXT NOT NULL,
            color      TEXT NOT NULL,
            points     TEXT NOT NULL,
            text       TEXT,
            created_at TEXT NOT NULL
        )
    """)
    _conn.execute("CREATE INDEX IF NOT EXISTS idx_board_conv ON board_strokes (conv, id)")
    # A snapshot is a frozen copy of a board, posted into the chat as a message.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS board_snapshots (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            conv       TEXT NOT NULL,
            strokes    TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    columns = [row["name"] for row in _conn.execute("PRAGMA table_info(messages)")]
    if "poll_id" not in columns:
        _conn.execute("ALTER TABLE messages ADD COLUMN poll_id INTEGER REFERENCES polls (id)")
    if "snapshot_id" not in columns:
        _conn.execute("ALTER TABLE messages ADD COLUMN snapshot_id INTEGER REFERENCES board_snapshots (id)")
    # A deleted message keeps its row (so its id still works for read receipts
    # and the order of the chat), but its text is wiped and it shows as
    # "This message was deleted".
    if "deleted" not in columns:
        _conn.execute("ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
    # When a message's text was last changed (empty if it never was), for "(edited)".
    if "edited_at" not in columns:
        _conn.execute("ALTER TABLE messages ADD COLUMN edited_at TEXT")

    # Reactions: one row per person per emoji per message. The primary key
    # makes "alice reacted 👍 twice" impossible, like one vote per poll.
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS reactions (
            msg_id  INTEGER NOT NULL REFERENCES messages (id),
            user_id INTEGER NOT NULL REFERENCES users (id),
            emoji   TEXT NOT NULL,
            PRIMARY KEY (msg_id, user_id, emoji)
        )
    """)

    # Everyone shares #general.
    _conn.execute("INSERT OR IGNORE INTO rooms (name, is_public, created_at) VALUES ('general', 1, ?)",
                  (_now().isoformat(timespec="seconds"),))
    _conn.commit()


def _now():
    return datetime.now(timezone.utc)


# --- Users and sessions ---

def create_user(username, password_hash):
    """Add a user and return their id, or None if the username is taken."""
    try:
        cur = _conn.execute(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
            (username, password_hash, _now().isoformat(timespec="seconds")),
        )
    except sqlite3.IntegrityError:  # the UNIQUE rule refused a duplicate
        return None
    _conn.commit()
    return cur.lastrowid


def get_user(user_id):
    return _conn.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()


def get_user_by_name(username):
    return _conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()


def create_session(token_hash, user_id, days):
    expires = (_now() + timedelta(days=days)).isoformat(timespec="seconds")
    _conn.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                  (token_hash, user_id, expires))
    _conn.commit()


def get_session_user(token_hash):
    """The user a token belongs to, or None if it's unknown or has expired."""
    return _conn.execute(
        "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id "
        "WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
        (token_hash, _now().isoformat(timespec="seconds")),
    ).fetchone()


def delete_session(token_hash):
    _conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
    _conn.commit()


def set_admin(username, is_admin=True):
    """Make someone an admin (or not). Returns False if there's no such user."""
    cur = _conn.execute("UPDATE users SET is_admin = ? WHERE username = ?", (int(is_admin), username))
    _conn.commit()
    return cur.rowcount == 1


def set_password(username, password_hash):
    """Replace a user's password and log them out everywhere. False if no such user."""
    user = get_user_by_name(username)
    if user is None:
        return False
    _conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user["id"]))
    _conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
    _conn.commit()
    return True


def is_admin(user_id):
    row = _conn.execute("SELECT is_admin FROM users WHERE id = ?", (int(user_id),)).fetchone()
    return bool(row and row["is_admin"])


def list_users():
    return _conn.execute("SELECT id, username, is_admin, created_at FROM users ORDER BY id").fetchall()


# --- Rooms and who may enter them ---

def create_room(name, is_public=False):
    """Create a room. Returns False if it already exists."""
    try:
        _conn.execute("INSERT INTO rooms (name, is_public, created_at) VALUES (?, ?, ?)",
                      (name, int(is_public), _now().isoformat(timespec="seconds")))
    except sqlite3.IntegrityError:
        return False
    _conn.commit()
    return True


def get_room(name):
    return _conn.execute("SELECT * FROM rooms WHERE name = ?", (name,)).fetchone()


def add_member(room, user_id):
    _conn.execute("INSERT OR IGNORE INTO room_members (room, user_id) VALUES (?, ?)", (room, int(user_id)))
    _conn.commit()


def remove_member(room, user_id):
    _conn.execute("DELETE FROM room_members WHERE room = ? AND user_id = ?", (room, int(user_id)))
    _conn.commit()


def rooms_for(user_id):
    """
    The rooms a user may enter: every public room, the private rooms they're a
    member of, and every room if they're an admin. This one query is the whole
    access rule, so the server can't apply it differently in different places.
    """
    return _conn.execute("""
        SELECT name, is_public FROM rooms
        WHERE is_public = 1
           OR EXISTS (SELECT 1 FROM room_members m WHERE m.room = rooms.name AND m.user_id = ?)
           OR EXISTS (SELECT 1 FROM users u WHERE u.id = ? AND u.is_admin = 1)
        ORDER BY is_public DESC, name
    """, (int(user_id), int(user_id))).fetchall()


def can_access(user_id, room):
    return any(r["name"] == room for r in rooms_for(user_id))


def all_rooms_with_members():
    """For the admin panel: every room and the usernames of its members."""
    rooms = []
    for r in _conn.execute("SELECT name, is_public FROM rooms ORDER BY is_public DESC, name"):
        members = [m["username"] for m in _conn.execute(
            "SELECT u.username FROM room_members m JOIN users u ON u.id = m.user_id "
            "WHERE m.room = ? ORDER BY u.username", (r["name"],))]
        rooms.append({"name": r["name"], "public": bool(r["is_public"]), "members": members})
    return rooms


# --- Messages ---

def dm_key(user_a, user_b):
    """
    Private messages are stored like a room whose name is made from the two
    user ids, smallest first, so both people get the same key. Room names can't
    contain ":" (server.py cleans them), so a real room can never clash with it.
    """
    a, b = sorted([int(user_a), int(user_b)])
    return f"dm:{a}:{b}"


# --- Reading: unread counts and read receipts (Phase 5) ---

def mark_read(user_id, conv, msg_id):
    """
    Remember that a user has read up to `msg_id` in a conversation.
    Returns True if that moved them forward (so others should be told).
    """
    row = _conn.execute("SELECT last_read FROM reads WHERE user_id = ? AND conv = ?",
                        (int(user_id), conv)).fetchone()
    if row and row["last_read"] >= msg_id:
        return False
    # An "upsert": insert the row, or update it if it's already there.
    _conn.execute("""
        INSERT INTO reads (user_id, conv, last_read) VALUES (?, ?, ?)
        ON CONFLICT (user_id, conv) DO UPDATE SET last_read = excluded.last_read
    """, (int(user_id), conv, msg_id))
    _conn.commit()
    return True


def last_read(user_id, conv):
    row = _conn.execute("SELECT last_read FROM reads WHERE user_id = ? AND conv = ?",
                        (int(user_id), conv)).fetchone()
    return row["last_read"] if row else 0


def reads_in(conv):
    """Everyone's read position in a conversation: [{id, name, last}]."""
    return [{"id": str(r["user_id"]), "name": r["username"], "last": r["last_read"]}
            for r in _conn.execute(
                "SELECT r.user_id, u.username, r.last_read FROM reads r "
                "JOIN users u ON u.id = r.user_id WHERE r.conv = ?", (conv,))]


def unread_counts(user_id, rooms):
    """
    How many messages are waiting for this user, per conversation: the rooms
    they may enter, plus every private chat they're part of. Messages they sent
    themselves don't count.
    """
    uid = str(int(user_id))
    counts = {}
    query = ("SELECT m.room, COUNT(*) AS n FROM messages m "
             "LEFT JOIN reads r ON r.user_id = ? AND r.conv = m.room "
             "WHERE m.sender_id != ? AND m.deleted = 0 AND m.id > COALESCE(r.last_read, 0) AND ")
    for room in rooms:
        row = _conn.execute(query + "m.room = ? GROUP BY m.room", (int(uid), uid, room)).fetchone()
        if row:
            counts[room] = row["n"]
    # Private chats this user is in: dm:<uid>:<other> or dm:<other>:<uid>.
    for row in _conn.execute(query + "(m.room LIKE ? OR m.room LIKE ?) GROUP BY m.room",
                             (int(uid), uid, f"dm:{uid}:%", f"dm:%:{uid}")):
        counts[row["room"]] = row["n"]
    return counts


def save_message(room, sender_id, sender_name, text, poll_id=None, snapshot_id=None):
    """Store one chat message and return it as the server will send it."""
    sent_at = _now().isoformat(timespec="seconds")
    # The ? placeholders let SQLite insert the values safely. Building the SQL
    # with f-strings would let a message like  '); DROP TABLE messages; --
    # run as SQL (an "SQL injection" attack).
    cur = _conn.execute(
        "INSERT INTO messages (room, sender_id, sender_name, text, sent_at, poll_id, snapshot_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (room, sender_id, sender_name, text, sent_at, poll_id, snapshot_id),
    )
    _conn.commit()
    return _to_message(cur.lastrowid, room, sender_id, sender_name, text, sent_at, poll_id, snapshot_id)


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
    reactions = reactions_for([r["id"] for r in rows])  # one query for the whole batch
    messages = [
        _to_message(r["id"], r["room"], r["sender_id"], r["sender_name"], r["text"], r["sent_at"],
                    r["poll_id"], r["snapshot_id"], r["deleted"], r["edited_at"], reactions.get(r["id"]))
        for r in rows
    ]
    return messages, more


def _to_message(msg_id, room, sender_id, sender_name, text, sent_at, poll_id=None, snapshot_id=None,
                deleted=0, edited_at=None, reactions=None):
    """The same shape as a live "chat" message, so the page treats both alike."""
    msg = {"type": "chat", "msg_id": msg_id, "room": room, "id": sender_id,
           "name": sender_name, "text": text, "sent_at": sent_at}
    if deleted:
        msg["deleted"] = True  # the page shows "This message was deleted"
        return msg
    if edited_at:
        msg["edited"] = True  # the page adds "(edited)"
    if reactions:
        msg["reactions"] = reactions
    if poll_id is not None:
        msg["poll"] = get_poll(poll_id)  # the page draws a poll card instead of text
    if snapshot_id is not None:
        msg["board"] = get_snapshot(snapshot_id)  # the page draws the board picture
    return msg


def get_message(msg_id):
    """One message's row (room, sender_id, deleted, ...), or None."""
    return _conn.execute("SELECT * FROM messages WHERE id = ?", (int(msg_id),)).fetchone()


def delete_message(msg_id):
    """
    Delete a message for everyone. Its text is wiped, and a poll (with its
    votes) or a board snapshot that it showed is removed too. The row itself
    stays as a "This message was deleted" placeholder.
    """
    row = get_message(msg_id)
    if row is None:
        return
    _conn.execute("UPDATE messages SET text = '', deleted = 1, poll_id = NULL, snapshot_id = NULL WHERE id = ?",
                  (row["id"],))
    if row["poll_id"] is not None:
        _conn.execute("DELETE FROM poll_votes WHERE poll_id = ?", (row["poll_id"],))
        _conn.execute("DELETE FROM polls WHERE id = ?", (row["poll_id"],))
    if row["snapshot_id"] is not None:
        _conn.execute("DELETE FROM board_snapshots WHERE id = ?", (row["snapshot_id"],))
    _conn.execute("DELETE FROM reactions WHERE msg_id = ?", (row["id"],))
    _conn.commit()


def edit_message(msg_id, text):
    """Change a message's text, and note when (for "(edited)")."""
    _conn.execute("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?",
                  (text, _now().isoformat(timespec="seconds"), int(msg_id)))
    _conn.commit()


# --- Reactions ---

def toggle_reaction(msg_id, user_id, emoji):
    """Add this person's reaction, or take it back if they'd already added it."""
    key = (int(msg_id), int(user_id), emoji)
    cur = _conn.execute("DELETE FROM reactions WHERE msg_id = ? AND user_id = ? AND emoji = ?", key)
    if cur.rowcount == 0:
        _conn.execute("INSERT INTO reactions (msg_id, user_id, emoji) VALUES (?, ?, ?)", key)
    _conn.commit()


def reactions_for(msg_ids):
    """
    The reactions on some messages: {msg_id: [{"emoji": "👍", "users": [{id, name}]}]}.
    Emoji are in the order they were first added to each message, like most chat apps.
    """
    if not msg_ids:
        return {}
    marks = ",".join("?" * len(msg_ids))  # one ? per id: still safe from SQL injection
    result = {}
    for r in _conn.execute(
            f"SELECT r.msg_id, r.emoji, r.user_id, u.username FROM reactions r JOIN users u ON u.id = r.user_id "
            f"WHERE r.msg_id IN ({marks}) ORDER BY r.rowid", [int(i) for i in msg_ids]):
        groups = result.setdefault(r["msg_id"], [])
        group = next((g for g in groups if g["emoji"] == r["emoji"]), None)
        if group is None:
            group = {"emoji": r["emoji"], "users": []}
            groups.append(group)
        group["users"].append({"id": str(r["user_id"]), "name": r["username"]})
    return result


# --- Drawing board ---

def _to_stroke(row):
    return {"id": row["id"], "user_id": str(row["user_id"]), "tool": row["tool"],
            "color": row["color"], "points": json.loads(row["points"]), "text": row["text"]}


def add_stroke(conv, user_id, tool, color, points, text=None):
    """Save one finished line, arrow or text, and return it."""
    cur = _conn.execute(
        "INSERT INTO board_strokes (conv, user_id, tool, color, points, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (conv, int(user_id), tool, color, json.dumps(points), text, _now().isoformat(timespec="seconds")),
    )
    _conn.commit()
    return {"id": cur.lastrowid, "user_id": str(user_id), "tool": tool, "color": color,
            "points": points, "text": text}


def get_strokes(conv):
    """Everything on a conversation's board, oldest first (the drawing order)."""
    return [_to_stroke(r) for r in _conn.execute(
        "SELECT * FROM board_strokes WHERE conv = ? ORDER BY id", (conv,))]


def count_strokes(conv):
    return _conn.execute("SELECT COUNT(*) AS n FROM board_strokes WHERE conv = ?", (conv,)).fetchone()["n"]


def get_stroke(conv, stroke_id):
    """One stroke on this board, or None."""
    row = _conn.execute("SELECT * FROM board_strokes WHERE conv = ? AND id = ?", (conv, int(stroke_id))).fetchone()
    return _to_stroke(row) if row else None


def move_stroke(conv, stroke_id, points):
    """Save a stroke's new points after it was dragged somewhere else."""
    _conn.execute("UPDATE board_strokes SET points = ? WHERE conv = ? AND id = ?",
                  (json.dumps(points), conv, int(stroke_id)))
    _conn.commit()


def delete_stroke(conv, stroke_id):
    """Rub out one stroke. Returns True if it was there."""
    cur = _conn.execute("DELETE FROM board_strokes WHERE conv = ? AND id = ?", (conv, int(stroke_id)))
    _conn.commit()
    return cur.rowcount == 1


def delete_last_stroke(conv, user_id):
    """Undo: remove this person's newest stroke. Returns its id, or None."""
    row = _conn.execute("SELECT id FROM board_strokes WHERE conv = ? AND user_id = ? ORDER BY id DESC LIMIT 1",
                        (conv, int(user_id))).fetchone()
    if row is None:
        return None
    delete_stroke(conv, row["id"])
    return row["id"]


def clear_board(conv):
    """Wipe a board. Returns what was on it, so the Clear can be undone."""
    strokes = get_strokes(conv)
    _conn.execute("DELETE FROM board_strokes WHERE conv = ?", (conv,))
    _conn.commit()
    return strokes


def restore_strokes(conv, strokes):
    """
    Put cleared strokes back with their old ids, so they keep their place in
    the drawing order. Ids are never handed out twice (AUTOINCREMENT), so they
    can't clash with anything drawn since the Clear.
    """
    now = _now().isoformat(timespec="seconds")
    _conn.executemany(
        "INSERT OR IGNORE INTO board_strokes (id, conv, user_id, tool, color, points, text, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [(s["id"], conv, int(s["user_id"]), s["tool"], s["color"], json.dumps(s["points"]), s["text"], now)
         for s in strokes])
    _conn.commit()


def create_snapshot(conv, sender_id, sender_name):
    """Freeze the board as it is now and post it into the conversation."""
    strokes = get_strokes(conv)
    cur = _conn.execute("INSERT INTO board_snapshots (conv, strokes, created_at) VALUES (?, ?, ?)",
                        (conv, json.dumps(strokes), _now().isoformat(timespec="seconds")))
    return save_message(conv, sender_id, sender_name, "Board snapshot", snapshot_id=cur.lastrowid)


def get_snapshot(snapshot_id):
    row = _conn.execute("SELECT * FROM board_snapshots WHERE id = ?", (int(snapshot_id),)).fetchone()
    if row is None:
        return None
    return {"id": row["id"], "strokes": json.loads(row["strokes"])}


# --- Polls ---

def create_poll(conv, creator_id, creator_name, question, options):
    """Save a poll and the message that shows it. Returns that message."""
    cur = _conn.execute(
        "INSERT INTO polls (conv, creator_id, question, options, created_at) VALUES (?, ?, ?, ?, ?)",
        (conv, int(creator_id), question, json.dumps(options), _now().isoformat(timespec="seconds")),
    )
    # The message text is a plain-text version, e.g. for anything that can't draw polls.
    return save_message(conv, creator_id, creator_name, "Poll: " + question, poll_id=cur.lastrowid)


def get_poll(poll_id):
    """
    A poll with everyone's votes, or None if there's no such poll:
    {id, conv, creator_id, question, closed, options: [{text, voters: [{id, name}]}]}
    """
    row = _conn.execute("SELECT * FROM polls WHERE id = ?", (int(poll_id),)).fetchone()
    if row is None:
        return None
    options = [{"text": text, "voters": []} for text in json.loads(row["options"])]
    for vote in _conn.execute(
            "SELECT v.option, v.user_id, u.username FROM poll_votes v "
            "JOIN users u ON u.id = v.user_id WHERE v.poll_id = ? ORDER BY u.username", (row["id"],)):
        if 0 <= vote["option"] < len(options):
            options[vote["option"]]["voters"].append({"id": str(vote["user_id"]), "name": vote["username"]})
    return {"id": row["id"], "conv": row["conv"], "creator_id": str(row["creator_id"]),
            "question": row["question"], "closed": bool(row["closed"]), "options": options}


def toggle_vote(poll_id, user_id, option):
    """
    Vote for an option. Voting for the option you already chose takes your vote
    back; choosing a different one moves it. Either way, one vote per person.
    """
    row = _conn.execute("SELECT option FROM poll_votes WHERE poll_id = ? AND user_id = ?",
                        (int(poll_id), int(user_id))).fetchone()
    if row and row["option"] == option:
        _conn.execute("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?", (int(poll_id), int(user_id)))
    else:
        # An upsert, like mark_read: add the vote, or change the one that's there.
        _conn.execute("""
            INSERT INTO poll_votes (poll_id, user_id, option) VALUES (?, ?, ?)
            ON CONFLICT (poll_id, user_id) DO UPDATE SET option = excluded.option
        """, (int(poll_id), int(user_id), option))
    _conn.commit()


def close_poll(poll_id):
    _conn.execute("UPDATE polls SET closed = 1 WHERE id = ?", (int(poll_id),))
    _conn.commit()
