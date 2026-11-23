"""
A small WebSocket chat server with rooms and private messages.

Run it with:   python server.py
Then open index.html in two or more browser tabs and chat between them.
"""
import asyncio
import json
import re

import websockets

DEFAULT_ROOM = "general"
MAX_NAME = 30
MAX_TEXT = 2000

# Every connected client, mapped to what we know about them.
# Phase 1 only needed a set of sockets. Now each socket also has a name and a
# room, so the server can decide who should receive each message.
#   ws -> {"id": "...", "name": "...", "room": "general" or None}
clients = {}


def clean_name(value):
    name = str(value or "").strip()[:MAX_NAME]
    return name or "Guest"


def clean_room(value):
    """Room names are short, lowercase, and only use letters, digits and dashes."""
    room = re.sub(r"[^a-z0-9-]+", "-", str(value or "").strip().lower()).strip("-")
    return room[:20] or DEFAULT_ROOM


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


async def send_to_all(message: dict):
    for ws in list(clients):
        await send(ws, message)


def find_client(client_id):
    """Look up a connection by its id (used for private messages)."""
    for ws, info in clients.items():
        if info["id"] == client_id:
            return ws
    return None


async def send_user_list():
    """Tell everyone who is online and which room they're in."""
    users = [
        {"id": info["id"], "name": info["name"], "room": info["room"]}
        for info in clients.values()
        if info["room"] is not None  # skip clients that haven't joined yet
    ]
    await send_to_all({"type": "users", "users": users})


async def join_room(ws, room):
    me = clients[ws]
    old = me["room"]
    if old == room:
        await send(ws, {"type": "joined", "room": room, "name": me["name"]})
        return
    me["room"] = room
    if old is not None:
        await send_to_room(old, {"type": "info", "room": old, "text": f"{me['name']} left #{old}."})
    await send(ws, {"type": "joined", "room": room, "name": me["name"]})
    await send_to_room(room, {"type": "info", "room": room, "text": f"{me['name']} joined #{room}."})
    await send_user_list()


async def handle_message(ws, msg):
    me = clients[ws]
    msg_type = msg.get("type")

    if msg_type == "join":
        if "name" in msg:
            me["name"] = clean_name(msg["name"])
        await join_room(ws, clean_room(msg.get("room")))

    elif msg_type == "rename":
        old = me["name"]
        me["name"] = clean_name(msg.get("name"))
        if me["name"] != old and me["room"] is not None:
            await send_to_room(me["room"], {"type": "info", "room": me["room"],
                                            "text": f"{old} is now called {me['name']}."})
            await send_user_list()

    elif me["room"] is None:
        # Everything below needs the client to have joined a room first.
        print("Ignored message before join:", msg)

    elif msg_type == "chat":
        text = str(msg.get("text") or "").strip()[:MAX_TEXT]
        if text:
            await send_to_room(me["room"], {"type": "chat", "room": me["room"],
                                            "id": me["id"], "name": me["name"], "text": text})

    elif msg_type == "dm":
        # A private message goes to exactly two people: the recipient, and the
        # sender (so their own page can show it as sent).
        text = str(msg.get("text") or "").strip()[:MAX_TEXT]
        target = find_client(str(msg.get("to")))
        if not text:
            return
        if target is None:
            await send(ws, {"type": "error", "text": "That person is no longer online."})
            return
        dm = {"type": "dm", "id": me["id"], "name": me["name"], "to": clients[target]["id"], "text": text}
        await send(target, dm)
        if target is not ws:
            await send(ws, dm)

    elif msg_type == "typing":
        typing = {"type": "typing", "id": me["id"], "name": me["name"]}
        if msg.get("to"):
            # Typing in a private conversation: only tell that one person.
            target = find_client(str(msg["to"]))
            if target is not None and target is not ws:
                await send(target, {**typing, "dm": True})
        else:
            await send_to_room(me["room"], {**typing, "room": me["room"]}, exclude=ws)

    else:
        print("Ignored unknown message:", msg)


async def handler(ws):
    """Runs once per client, for as long as that client stays connected."""
    client_id = str(ws.id)
    # The client isn't in a room until it sends a "join" message.
    clients[ws] = {"id": client_id, "name": "Guest", "room": None}
    await send(ws, {"type": "welcome", "id": client_id})
    print(f"Client connected    ({len(clients)} online)")

    try:
        async for raw in ws:
            # Never trust what a client sends: a bad message should be
            # ignored, not crash this person's connection.
            try:
                msg = json.loads(raw)
                if not isinstance(msg, dict):
                    raise ValueError("message is not a JSON object")
                print("Received:", msg)
                await handle_message(ws, msg)
            except (json.JSONDecodeError, ValueError) as e:
                print("Ignored bad message:", raw, "-", e)
    except websockets.ConnectionClosed:
        pass  # the connection dropped without a proper goodbye (e.g. wifi cut out)
    finally:
        me = clients.pop(ws)
        print(f"Client disconnected ({len(clients)} online)")
        if me["room"] is not None:
            await send_to_room(me["room"], {"type": "info", "room": me["room"],
                                            "text": f"{me['name']} left the chat."})
            await send_user_list()


async def main():
    async with websockets.serve(handler, "localhost", 8765):
        print("WebSocket server running at ws://localhost:8765")
        await asyncio.Future()  # keep running forever


if __name__ == "__main__":
    asyncio.run(main())
