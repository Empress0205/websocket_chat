"""
A WebSocket chat server with accounts, rooms, private messages, history,
read receipts and messages that wait for people who are offline.

Run it with:   python server.py
Then open index.html, log in with an account your admin created, and chat.
"""
import asyncio
import json
import re

import websockets

import auth  # our own file: passwords and login tokens (auth.py)
import db  # our own file: saves and loads data (db.py)
from ratelimit import RateLimiter, RateLimiterGroup  # our own file (ratelimit.py)

DEFAULT_ROOM = "general"
MAX_TEXT = 2000

# Heartbeats: the websockets library pings every client this often (seconds),
# and drops any client that doesn't answer within PING_TIMEOUT. That's how the
# server notices "dead" connections, e.g. a laptop that went to sleep.
PING_INTERVAL = 20
PING_TIMEOUT = 20

# Login attempts per username, shared by every connection: 5 tries, then one
# every 30 seconds. (Each connection also has its own limit, in new_client.)
login_limits = RateLimiterGroup(capacity=5, per_second=1 / 30)

# Every connected client, mapped to what we know about them.
# Until a client logs in, its "id" is None and it can't do anything else.
#   ws -> {"id": "3", "name": "alice", "room": "general", ...}
clients = {}


def new_client():
    return {
        "id": None,            # the user's id, as text, once logged in
        "name": None,          # their username
        "room": None,          # the room they're in, once they join one
        "token_hash": None,    # which login (session) this connection uses
        "replaced": False,     # True if the same user logged in from another tab
        # At most 5 messages in a burst, then 1 a second.
        "message_limit": RateLimiter(capacity=5, per_second=1),
        # At most 5 login attempts, then 1 every 30 seconds (slows password guessing).
        "login_limit": RateLimiter(capacity=5, per_second=1 / 30),
    }


def clean_room(value):
    """Room names are short, lowercase, and only use letters, digits and dashes."""
    room = re.sub(r"[^a-z0-9-]+", "-", str(value or "").strip().lower()).strip("-")
    return room[:20] or DEFAULT_ROOM


def for_log(msg):
    """A copy of a message that's safe to print: never log passwords or tokens."""
    return {k: ("***" if k in ("password", "token") else v) for k, v in msg.items()}


async def send(ws, message: dict):
    """Send to one client, ignoring it if it has just disconnected."""
    try:
        await ws.send(json.dumps(message))
    except websockets.ConnectionClosed:
        pass


async def send_to_room(room, message: dict, exclude=None):
    """Send a message only to the clients in one room."""
    for ws, info in list(clients.items()):
        if info["room"] == room and ws is not exclude:
            await send(ws, message)


def find_client(user_id):
    """Look up a logged-in user's connection by their id."""
    for ws, info in clients.items():
        if info["id"] is not None and info["id"] == user_id:
            return ws
    return None


async def send_user_list():
    """
    Tell every logged-in user who is online and which room they're in.

    Each person gets their own version of the list: if someone is in a private
    room you can't enter, you see them online but not the room's name.
    """
    online = [info for info in clients.values() if info["room"] is not None]
    for ws, info in list(clients.items()):
        if info["id"] is None:
            continue  # people who haven't logged in don't get to see who's here
        allowed = {r["name"] for r in db.rooms_for(info["id"])}
        users = [{"id": u["id"], "name": u["name"], "room": u["room"] if u["room"] in allowed else None}
                 for u in online]
        await send(ws, {"type": "users", "users": users})


async def send_people(ws=None):
    """
    Everyone who has an account, so you can message people who are offline too.
    Sent to one client, or (ws=None) to every logged-in client.
    """
    people = [{"id": str(u["id"]), "name": u["username"]} for u in db.list_users()]
    targets = [ws] if ws else [w for w, info in clients.items() if info["id"] is not None]
    for w in list(targets):
        await send(w, {"type": "people", "people": people})


def page_key(user_id, conv):
    """
    The page names conversations "room:general" or "dm:<the other person's id>".
    The database names them "general" or "dm:<smaller id>:<bigger id>".
    """
    if conv.startswith("dm:"):
        a, b = conv[3:].split(":")
        return "dm:" + (b if a == user_id else a)
    return "room:" + conv


async def send_unread(ws):
    """After logging in: how many messages wait in each conversation."""
    user_id = clients[ws]["id"]
    rooms = [r["name"] for r in db.rooms_for(user_id)]
    counts = {page_key(user_id, conv): n for conv, n in db.unread_counts(user_id, rooms).items()}
    await send(ws, {"type": "unread", "counts": counts})


async def send_rooms(ws):
    """Tell one user which rooms they may enter, and whether they're an admin."""
    user_id = clients[ws]["id"]
    rooms = [{"name": r["name"], "public": bool(r["is_public"])} for r in db.rooms_for(user_id)]
    await send(ws, {"type": "rooms", "rooms": rooms, "admin": db.is_admin(user_id)})


async def send_history(ws, before_id=None, room=None, dm_with=None):
    """Send a batch of saved messages from a room or a private chat."""
    key = db.dm_key(clients[ws]["id"], dm_with) if dm_with else room
    messages, more = db.get_history(key, before_id)
    reply = {"type": "history", "messages": messages, "more": more, "older": before_id is not None}
    # Read receipts: how far the others have read, so the page can show
    # ticks (private chat) or "Seen by ..." (room) on your own messages.
    if dm_with:
        reply.update(dm=dm_with, other_read=db.last_read(dm_with, key))
    else:
        reply.update(room=room, reads=db.reads_in(room))
    await send(ws, reply)


# --- Logging in ---

async def handle_auth(ws, msg):
    """Handle "login" and "resume" (log back in with a saved token)."""
    me = clients[ws]
    kind = msg.get("type")
    if me["id"] is not None:
        await send(ws, {"type": "auth_error", "text": "You're already logged in."})
        return

    token = None
    if kind == "resume":
        token_hash = auth.hash_token(str(msg.get("token") or ""))
        user = db.get_session_user(token_hash)
        if user is None:
            await send(ws, {"type": "auth_error", "text": "Your login has expired. Please log in again."})
            return
    else:
        username = str(msg.get("username") or "").strip()
        password = msg.get("password")
        # Two limits: this connection, and this username across all connections,
        # so reconnecting after every few guesses doesn't help an attacker.
        if not me["login_limit"].allow() or not login_limits.allow(username.lower()):
            await send(ws, {"type": "auth_error", "text": "Too many attempts. Please wait a minute."})
            return
        user = db.get_user_by_name(username)
        # Checking a password is slow on purpose (~0.3 s). Running it in a
        # thread keeps the server answering everyone else in the meantime.
        ok = (user is not None and isinstance(password, str)
              and await asyncio.to_thread(auth.verify_password, password, user["password_hash"]))
        if not ok:
            # The same message either way, so nobody can find out which
            # usernames exist by trying them.
            await send(ws, {"type": "auth_error", "text": "Wrong username or password."})
            return

        token = auth.new_token()
        token_hash = auth.hash_token(token)
        db.create_session(token_hash, user["id"], auth.SESSION_DAYS)

    user_id = str(user["id"])
    # One connection per account: if this user is already connected in another
    # tab, sign that one out.
    old = find_client(user_id)
    if old is not None:
        clients[old]["replaced"] = True
        await send(old, {"type": "signed_out", "text": "You logged in from another tab, so this one was signed out."})
        await old.close()

    me.update(id=user_id, name=user["username"], token_hash=token_hash)
    reply = {"type": "auth_ok", "user": {"id": user_id, "name": user["username"]}}
    if token:
        reply["token"] = token  # only sent once; the page keeps it for this tab
    await send(ws, reply)
    await send_rooms(ws)
    await send_people(ws)
    await send_unread(ws)
    print(f"{me['name']} logged in")


# --- Admins: creating accounts and rooms, and deciding who may enter them ---

async def handle_admin(ws, msg):
    me = clients[ws]
    # Check the database every time, not a value saved at login, so taking
    # someone's admin rights away works straight away.
    if not db.is_admin(me["id"]):
        await send(ws, {"type": "error", "text": "Only admins can do that."})
        return
    kind = msg.get("type")

    if kind == "admin_create_user":
        # Only admins create accounts: there is no public sign-up.
        username = str(msg.get("username") or "").strip()
        password = msg.get("password")
        error = auth.check_username(username) or auth.check_password(password)
        if error:
            await send(ws, {"type": "error", "text": error})
        else:
            password_hash = await asyncio.to_thread(auth.hash_password, password)
            if db.create_user(username, password_hash) is None:
                await send(ws, {"type": "error", "text": f"{username} already has an account."})
            else:
                await send(ws, {"type": "notice", "text": f"Account created for {username}. Give them their password."})
                await send_people()  # everyone can now see and message the new person

    elif kind == "admin_create_room":
        name = clean_room(msg.get("name"))
        if not db.create_room(name):  # new rooms are private
            await send(ws, {"type": "error", "text": f"#{name} already exists."})
        await send_rooms(ws)

    elif kind in ("admin_add_member", "admin_remove_member"):
        room = db.get_room(clean_room(msg.get("room")))
        user = db.get_user_by_name(str(msg.get("username") or "").strip())
        if room is None or user is None:
            await send(ws, {"type": "error", "text": "There's no room or user with that name."})
        elif room["is_public"]:
            await send(ws, {"type": "error", "text": f"#{room['name']} is public, so everyone can already enter it."})
        else:
            user_id, name = str(user["id"]), room["name"]
            if kind == "admin_add_member":
                db.add_member(name, user_id)
            else:
                db.remove_member(name, user_id)
            # If that person is online, update their room list straight away.
            target = find_client(user_id)
            if target is not None:
                await send_rooms(target)
                if kind == "admin_add_member":
                    await send(target, {"type": "notice", "text": f"You were given access to #{name}."})
                elif clients[target]["room"] == name and not db.can_access(user_id, name):
                    # They were inside the room: move them out.
                    await send(target, {"type": "error", "text": f"You no longer have access to #{name}."})
                    await join_room(target, DEFAULT_ROOM)
            await send_user_list()  # who can see which room names has changed

    elif kind != "admin_list":
        # Say so instead of ignoring it, so a mistake doesn't look like success.
        await send(ws, {"type": "error", "text": f"Unknown admin action: {kind}."})

    # Whatever happened, send the admin the up-to-date lists for their panel:
    # every room with its members, and every username to pick from.
    await send(ws, {"type": "admin_rooms", "rooms": db.all_rooms_with_members(),
                    "users": [u["username"] for u in db.list_users()]})


# --- Everything else (needs a login) ---

async def join_room(ws, room):
    me = clients[ws]
    old = me["room"]
    me["room"] = room
    await send(ws, {"type": "joined", "room": room})
    # Send the room's recent messages before anything new arrives.
    await send_history(ws, room=room)
    if old == room:
        return
    if old is not None:
        await send_to_room(old, {"type": "info", "room": old, "text": f"{me['name']} left #{old}."})
    await send_to_room(room, {"type": "info", "room": room, "text": f"{me['name']} joined #{room}."})
    await send_user_list()


def valid_user_id(value):
    """A user id from the page must look like one: digits only."""
    value = str(value or "")
    return value if value.isdigit() else None


async def handle_message(ws, msg):
    me = clients[ws]
    msg_type = str(msg.get("type"))

    if msg_type == "ping":
        # The page's own heartbeat: if it doesn't get this pong back quickly,
        # it knows the connection is dead and reconnects.
        await send(ws, {"type": "pong"})
        return
    if msg_type in ("login", "resume"):
        await handle_auth(ws, msg)
        return
    if msg_type == "signup":
        # There's no sign-up: refuse it even if someone sends it by hand.
        await send(ws, {"type": "auth_error", "text": "Accounts are created by an admin. Ask your admin for one."})
        return
    if me["id"] is None:
        await send(ws, {"type": "auth_error", "text": "Please log in first."})
        return

    if msg_type == "logout":
        db.delete_session(me["token_hash"])  # the token stops working everywhere
        await send(ws, {"type": "signed_out", "text": "You have logged out."})
        await ws.close()

    elif msg_type.startswith("admin_"):
        await handle_admin(ws, msg)

    elif msg_type == "join":
        room = clean_room(msg.get("room"))
        # Authorization: being logged in isn't enough, you must be allowed in.
        # Hiding the room on the page wouldn't stop someone sending this message by hand.
        if not db.can_access(me["id"], room):
            await send(ws, {"type": "error", "text": f"You don't have access to #{room}."})
            if me["room"] is not None:
                return
            room = DEFAULT_ROOM  # first join after logging in: fall back to #general
        await join_room(ws, room)

    elif me["room"] is None:
        # Everything below needs the client to have joined a room first.
        print("Ignored message before join:", for_log(msg))

    elif msg_type in ("chat", "dm") and not me["message_limit"].allow():
        await send(ws, {"type": "error", "text": "You're sending messages too fast. Wait a moment."})

    elif msg_type == "chat":
        text = str(msg.get("text") or "").strip()[:MAX_TEXT]
        if text:
            # Save first, then send: the saved copy has an id and a timestamp.
            saved = db.save_message(me["room"], me["id"], me["name"], text)
            await send_to_room(me["room"], saved)

    elif msg_type == "dm":
        # A private message goes to exactly two people: the recipient, and the
        # sender (so their own page can show it as sent).
        text = str(msg.get("text") or "").strip()[:MAX_TEXT]
        to = valid_user_id(msg.get("to"))
        if not text or not to or to == me["id"]:
            return
        if db.get_user(to) is None:
            await send(ws, {"type": "error", "text": "There's no such person."})
            return
        # Saved first, so it waits for them even if they're offline right now:
        # they'll see it, with an unread badge, the next time they log in.
        saved = db.save_message(db.dm_key(me["id"], to), me["id"], me["name"], text)
        dm = {**saved, "type": "dm", "to": to}
        target = find_client(to)
        if target is not None:
            await send(target, dm)
        await send(ws, dm)

    elif msg_type == "read":
        # Read receipts: the page says "I've read up to message N here".
        msg_id = msg.get("msg_id")
        if not isinstance(msg_id, int) or msg_id <= 0:
            return
        other = valid_user_id(msg.get("with"))
        if other and other != me["id"]:
            conv = db.dm_key(me["id"], other)
            if db.mark_read(me["id"], conv, msg_id):
                target = find_client(other)
                if target is not None:
                    # Tell the other person their messages were seen.
                    await send(target, {"type": "seen", "with": me["id"], "msg_id": msg_id})
        else:
            room = clean_room(msg.get("room"))
            if db.can_access(me["id"], room) and db.mark_read(me["id"], room, msg_id):
                await send_to_room(room, {"type": "seen", "room": room, "id": me["id"],
                                          "name": me["name"], "msg_id": msg_id})

    elif msg_type == "dm_history":
        # The user opened a private chat: send what the two of them said before.
        other = valid_user_id(msg.get("with"))
        if other and other != me["id"]:
            await send_history(ws, dm_with=other)

    elif msg_type == "load_more":
        # The user scrolled to the top: send the messages before the oldest one they have.
        before = msg.get("before")
        if isinstance(before, int) and before > 0:
            other = valid_user_id(msg.get("with"))
            if other:
                await send_history(ws, before, dm_with=other)
            else:
                await send_history(ws, before, room=me["room"])

    elif msg_type == "typing":
        typing = {"type": "typing", "id": me["id"], "name": me["name"]}
        if msg.get("to"):
            # Typing in a private conversation: only tell that one person.
            target = find_client(valid_user_id(msg["to"]))
            if target is not None and target is not ws:
                await send(target, {**typing, "dm": True})
        else:
            await send_to_room(me["room"], {**typing, "room": me["room"]}, exclude=ws)

    else:
        print("Ignored unknown message:", for_log(msg))


async def handler(ws):
    """Runs once per client, for as long as that client stays connected."""
    clients[ws] = new_client()
    print(f"Client connected    ({len(clients)} online)")

    try:
        async for raw in ws:
            # Never trust what a client sends: a bad message should be
            # ignored, not crash this person's connection.
            try:
                msg = json.loads(raw)
                if not isinstance(msg, dict):
                    raise ValueError("message is not a JSON object")
                print("Received:", for_log(msg))
                await handle_message(ws, msg)
            except (json.JSONDecodeError, ValueError) as e:
                print("Ignored bad message -", e)
    except websockets.ConnectionClosed:
        pass  # the connection dropped without a proper goodbye (e.g. wifi cut out)
    finally:
        me = clients.pop(ws)
        print(f"Client disconnected ({len(clients)} online)")
        # If they just moved to another tab, they haven't really left.
        if me["room"] is not None and not me["replaced"]:
            await send_to_room(me["room"], {"type": "info", "room": me["room"],
                                            "text": f"{me['name']} left the chat."})
        if me["room"] is not None:
            await send_user_list()


async def main():
    db.init_db()
    async with websockets.serve(handler, "localhost", 8765,
                                ping_interval=PING_INTERVAL, ping_timeout=PING_TIMEOUT):
        print("WebSocket server running at ws://localhost:8765")
        await asyncio.Future()  # keep running forever


if __name__ == "__main__":
    asyncio.run(main())
