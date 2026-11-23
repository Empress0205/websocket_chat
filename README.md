# WebSocket Chat: Learning WebSockets Step by Step

This repo records my progress learning **WebSockets**, from first principles up to a production-ready real-time app. It grows in phases, and each phase adds one new idea on top of the last.

> **Current status: Phase 2 complete, a chat with rooms, private messages and an online list.**

So far it's a Python WebSocket server and a single-page browser client, with no frameworks and no build step. Open the page in a few browser tabs, put them in different rooms, and message each other publicly or privately.

## Learning roadmap

| Phase | Focus | Status |
|---|---|---|
| **1** | WebSocket basics: a real-time chat | ✅ Done |
| **2** | Rooms and private messages | ✅ Done |
| **3** | Saving messages and showing history | 🔜 Next |
| **4** | Users and authentication | ⏳ Planned |
| **5** | Reliability: reconnecting and heartbeats | ⏳ Planned |
| **6** | Deploying online over secure `wss://` | ⏳ Planned |

### Phase 1: WebSocket basics ✅

**Goal:** understand how a WebSocket connection works, and build something real with it.

What I learned:

- How WebSockets differ from normal HTTP: one connection stays open, and either side can send at any moment.
- Opening a connection from the browser with `new WebSocket(...)` and handling the `onopen`, `onmessage` and `onclose` events.
- Writing an async server in Python with `asyncio` and the `websockets` library.
- Keeping track of connected clients and **broadcasting** a message to all of them.
- Designing a small **message protocol** with JSON and a `type` field (`chat`, `typing`, `info`, `welcome`).
- Sending to everyone *except* one client, which the typing indicator relies on.
- **Throttling** messages so the page doesn't send one on every keystroke.
- Never trusting client input: the server ignores bad messages and the page uses `textContent` so nobody can inject HTML.

### Phase 2: Rooms and private messages ✅

**Goal:** stop sending every message to everyone, and have the server decide who should receive each one.

What I learned:

- The server has to **remember things about each connection**. Phase 1 kept a plain set of sockets. Now it's a dictionary from each socket to its `id`, `name` and `room`.
- A "room" is just a label on each connection. Sending to a room means looping over the clients and picking the ones with that label. The WebSocket protocol itself has no idea rooms exist.
- **Routing** messages in three ways: to everyone (the online list), to one room (chat, typing, join/leave notices), and to exactly one person (private messages).
- A private message goes to the recipient **and back to the sender**, so the sender's page shows it the same way as every other message.
- **Presence:** whenever someone joins, leaves, switches room or renames, the server sends everyone a fresh `users` list. The page rebuilds its sidebar from that.
- The server is the **source of truth**. It cleans up names and room names (`"Random Stuff!"` becomes `random-stuff`) and replies with what it actually did (`joined`), and the page trusts that reply instead of its own guess.
- On the page, each conversation gets its **own message list** and an unread counter, so switching between rooms and private chats doesn't mix messages up.
- A connection can drop without a proper goodbye (wifi cuts out, laptop closes). The server catches `ConnectionClosed` so that's handled quietly instead of logging an error.

### Phase 3: Message history 🔜

- Store messages in a database such as SQLite.
- Send recent history to people when they join.
- Load older messages when you scroll up.

### Phase 4: Users and authentication ⏳

- Sign up and log in, so display names can't be faked.
- Authenticate the WebSocket connection with a token.
- Rate-limit clients to stop spam.

### Phase 5: Reliability ⏳

- Reconnect automatically when the connection drops.
- Use ping/pong heartbeats to detect dead connections.
- Handle messages that were sent while a client was offline.

### Phase 6: Deployment ⏳

- Host the server online and serve the page from the same place.
- Use secure WebSockets (`wss://`) over HTTPS.
- Look at how to scale past a single server, for example using Redis pub/sub.

---

## Features

### Added in Phase 2

- **Rooms.** Start in `#general`, switch to `#random` or `#help`, or type any name to create a new room. Messages, typing and join/leave notices stay inside their room.
- **Private messages.** Click someone in the *Online* list to chat with them privately. Only the two of you see those messages.
- **Who's online.** The sidebar lists everyone connected and which room they're in, and each room shows how many people are in it.
- **Unread badges.** A red counter appears on a conversation when a message arrives while you're looking at a different one.
- **Renaming.** Change your name in the header and everyone's online list updates.

### From Phase 1


- **Real-time messaging.** Messages go to every connected client the moment they're sent.
- **Chat bubbles.** Your messages appear on the right and everyone else's on the left, grouped by sender, each with a timestamp.
- **Typing indicator.** Animated dots show who's typing (e.g. "Alex is typing…") in the conversation you're looking at. They clear automatically 2 seconds after the last keystroke.
- **Join / leave notices.** Everyone sees when someone connects or disconnects, along with the number of people online.
- **Connection status.** A green or red dot in the header shows whether you're connected to the server.
- **Display names.** Pick a name in the header. If you leave it blank, you show up as "Guest".
- **Safe by default.** The server ignores malformed messages instead of crashing, and the page renders message text as plain text, so nobody can inject HTML.

## Project structure

```
.
├── index.html        # The chat client (HTML, CSS and JavaScript in one file)
├── server.py         # The WebSocket server
└── requirements.txt  # Python dependencies
```

## Getting started

### Requirements

- Python 3.9 or newer
- A modern web browser

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Start the server

```bash
python server.py
```

You should see:

```
WebSocket server running at ws://localhost:8765
```

### 3. Open the chat

Open `index.html` in your browser (double-clicking it works), then open it again in a second and third tab. Set a different name in each one, move one tab to another room, and click a name under *Online* to send a private message.

> If you still have the Phase 1 server running, stop it first (Ctrl+C in its terminal). Otherwise the new one can't use port 8765.

## How it works

The client and server talk over a single WebSocket connection, using JSON messages. Each message has a `type` field.

The server keeps every open connection in memory along with that person's `id`, `name` and `room`, and uses that to decide who receives each message.

| Direction | `type` | Purpose |
|---|---|---|
| Server → client | `welcome` | Gives the client its unique `id`, so it can tell its own messages apart |
| Client → server | `join` | Join a room: `{ "type": "join", "room": "general", "name": "..." }`. Also sent once when the page connects |
| Server → client | `joined` | Confirms the room (with its cleaned-up name). The page switches to it |
| Client → server | `rename` | Change your display name: `{ "type": "rename", "name": "..." }` |
| Client → server | `chat` | Sends a message to your current room: `{ "type": "chat", "text": "..." }` |
| Server → room | `chat` | Passes it on to everyone in that room, with the sender's `id`, `name` and the `room` |
| Client → server | `dm` | Private message: `{ "type": "dm", "to": "<their id>", "text": "..." }` |
| Server → 2 people | `dm` | Sent to the recipient and back to the sender, with `id`, `name`, `to` and `text` |
| Client → server | `typing` | "I'm typing", at most once per second. Add `"to": "<id>"` when typing in a private chat |
| Server → room / 1 person | `typing` | Passed on to the room (with `room`) or to the private-chat partner (with `"dm": true`) |
| Server → room | `info` | Join / leave / rename notices for that room |
| Server → all | `users` | The full online list: `[{ "id", "name", "room" }, ...]` |
| Server → client | `error` | Something went wrong, e.g. a private message to someone who just left |

## Configuration

By default the server listens on `localhost:8765` and the page connects to `ws://localhost:8765`. To change this:

- **Server:** edit the host and port in `main()` in `server.py`.
- **Client:** edit the URL in `new WebSocket(...)` in `index.html`.

## Known limitations and when they get fixed

The project deliberately keeps things simple. These gaps are what the next phases are for:

| Limitation | Fixed in |
|---|---|
| Messages aren't saved, so they're lost on restart and you see no history when you join a room | Phase 3 |
| You're in one room at a time, so you miss what's said in other rooms while you're away | Phase 3 |
| No accounts, so anyone can use any display name (two people can both be "Alex") | Phase 4 |
| If the connection drops, you have to reload the page, which starts a new identity and loses your private chats | Phase 5 |
| Only runs on `localhost` | Phase 6 |

## License

Free to use and modify.
