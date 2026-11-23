# WebSocket Chat: Learning WebSockets Step by Step

This repo records my progress learning **WebSockets**, from first principles up to a production-ready real-time app. It grows in phases, and each phase adds one new idea on top of the last.

> **Current status: Phase 1 complete, a working real-time chat.**

So far it's a Python WebSocket server and a single-page browser client, with no frameworks and no build step. Open the page in a few browser tabs and the messages appear in all of them instantly.

## Learning roadmap

| Phase | Focus | Status |
|---|---|---|
| **1** | WebSocket basics: a real-time chat | ✅ Done |
| **2** | Rooms and private messages | 🔜 Next |
| **3** | Saving messages and showing history | ⏳ Planned |
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

### Phase 2: Rooms and private messages 🔜

- Join and leave named chat rooms (channels).
- Only broadcast messages to people in the same room.
- Send direct messages between two users.
- Show a list of who's online.

### Phase 3: Message history ⏳

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

## Phase 1 in detail

### Features

- **Real-time messaging.** Messages go to every connected client the moment they're sent.
- **Chat bubbles.** Your messages appear on the right and everyone else's on the left, grouped by sender, each with a timestamp.
- **Typing indicator.** Animated dots show who's typing (e.g. "Alex is typing…"). They clear automatically 2 seconds after the last keystroke.
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

Open `index.html` in your browser (double-clicking it works), then open it again in a second tab or window. Set a different name in each one and start chatting.

## How it works

The client and server talk over a single WebSocket connection, using JSON messages. Each message has a `type` field.

| Direction | `type` | Purpose |
|---|---|---|
| Server → client | `welcome` | Gives the client its unique `id`, so it can tell its own messages apart |
| Client → server | `chat` | Sends a message: `{ "type": "chat", "name": "...", "text": "..." }` |
| Server → all | `chat` | Passes a message on to everyone, including the sender's `id` and `name` |
| Client → server | `typing` | Says "I'm typing". The page sends this at most once per second |
| Server → others | `typing` | Passes the typing signal on to everyone except the person typing |
| Server → all | `info` | Join / leave notices |

The server keeps the set of open connections in memory and sends each incoming message to all of them.

## Configuration

By default the server listens on `localhost:8765` and the page connects to `ws://localhost:8765`. To change this:

- **Server:** edit the host and port in `main()` in `server.py`.
- **Client:** edit the URL in `new WebSocket(...)` in `index.html`.

## Known limitations and when they get fixed

Phase 1 deliberately keeps things simple. These gaps are what the next phases are for:

| Limitation | Fixed in |
|---|---|
| Everyone shares one chat, with no rooms or private messages | Phase 2 |
| Messages aren't saved, so they're lost on restart and newcomers see no history | Phase 3 |
| No accounts, so anyone can use any display name | Phase 4 |
| If the connection drops, you have to reload the page | Phase 5 |
| Only runs on `localhost` | Phase 6 |

## License

Free to use and modify.
