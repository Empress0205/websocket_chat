"""
A tiny WebSocket chat server.

Run it with:   python server.py
Then open index.html in two browser tabs and chat between them.
"""
import asyncio
import json

import websockets

# Every browser tab that is currently connected.
connected = set()


async def broadcast(message: dict, exclude=None):
    """Send a message to every connected client (optionally skipping one)."""
    data = json.dumps(message)
    for ws in list(connected):
        if ws is exclude:
            continue
        try:
            await ws.send(data)
        except websockets.ConnectionClosed:
            pass  # that client left while we were sending; ignore it


async def handler(ws):
    """Runs once per client, for as long as that client stays connected."""
    connected.add(ws)
    # Every connection gets a unique id. We tell the client its own id, so the
    # page can tell "my messages" (right side) apart from others' (left side).
    client_id = str(ws.id)
    await ws.send(json.dumps({"type": "welcome", "id": client_id}))
    print(f"Client connected   ({len(connected)} online)")
    await broadcast({"type": "info", "text": f"Someone joined. {len(connected)} online."})

    try:
        # This loop waits for messages from this one client.
        # It ends when the client closes the tab or the connection drops.
        async for raw in ws:
            # Never trust what a client sends: a bad message should be
            # ignored, not crash this person's connection.
            try:
                msg = json.loads(raw)
                print("Received:", msg)
                msg_type = msg.get("type", "chat")  # old pages didn't send a type
                name = str(msg.get("name") or "Guest")

                # Each message has a "type" so we know what to do with it.
                if msg_type == "chat" and msg.get("text"):
                    await broadcast({"type": "chat", "id": client_id, "name": name, "text": str(msg["text"])})
                elif msg_type == "typing":
                    # Tell everyone *except* the person typing.
                    await broadcast({"type": "typing", "id": client_id, "name": name}, exclude=ws)
                else:
                    print("Ignored unknown message:", msg)
            except (json.JSONDecodeError, AttributeError) as e:
                print("Ignored bad message:", raw, "-", e)
    finally:
        connected.discard(ws)
        print(f"Client disconnected ({len(connected)} online)")
        await broadcast({"type": "info", "text": f"Someone left. {len(connected)} online."})


async def main():
    async with websockets.serve(handler, "localhost", 8765):
        print("WebSocket server running at ws://localhost:8765")
        await asyncio.Future()  # keep running forever


if __name__ == "__main__":
    asyncio.run(main())
