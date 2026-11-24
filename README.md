# WebSocket Chat: Learning WebSockets Step by Step

This repo records my progress learning **WebSockets**, from first principles up to a production-ready real-time app. It grows in phases, and each phase adds one new idea on top of the last.

> **Current status: Phase 3 complete, a chat with rooms, private messages, an online list and saved message history.**

So far it's a Python WebSocket server and a single-page browser client, with no frameworks and no build step. Open the page in a few browser tabs, put them in different rooms, and message each other publicly or privately.

## Learning roadmap

| Phase | Focus | Status |
|---|---|---|
| **1** | WebSocket basics: a real-time chat | ✅ Done |
| **2** | Rooms and private messages | ✅ Done |
| **3** | Saving messages and showing history | ✅ Done |
| **4** | Users and authentication | 🔜 Next |
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

### Phase 3: Message history ✅

**Goal:** stop losing every message when the server restarts, and show newcomers what was said before they arrived.

What I learned:

- Until now the server kept everything in memory, so a restart wiped it. A **database** keeps data in a file on disk. **SQLite** is built into Python and stores the whole database in one file, `chat.db`.
- Splitting code into files by job: `db.py` only knows about storage, and `server.py` only knows about connections. The server just calls `db.save_message(...)` and `db.get_history(...)`.
- Creating a table with `CREATE TABLE IF NOT EXISTS`, so the first run sets it up and later runs leave it alone.
- Always passing values with `?` placeholders instead of building SQL with f-strings. Otherwise a message could contain SQL that the database runs (**SQL injection**).
- An **index** on `(room, id)` makes "the latest 50 messages in this room" fast, because SQLite doesn't have to read every message.
- **Pagination:** sending 50 messages at a time, and when you scroll up, asking for "50 messages older than this id". Fetching 51 rows tells the server whether there are more to load.
- Save first, then send. The saved copy gets an id and a timestamp from the server, so everyone sees the same time and the page can ask for older messages by id.
- Adding older messages at the top without the page jumping, by measuring the scroll height before and after.
- Saved data needs a **stable identity**. My messages were matched to me by connection id, which changes on every reload, so after a restart all my old messages showed up on the wrong side. Each tab now keeps its own id in `sessionStorage` and sends it when it joins.

### Phase 4: Users and authentication 🔜

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

### Added in Phase 3

- **Saved history.** Messages are stored in `chat.db` and survive a server restart.
- **History on join.** Entering a room shows its last 50 messages.
- **Load older messages.** Scroll to the top of a room to load the 50 before that, until you reach "This is the start of #room".
- **Real send times.** Times come from the server, and messages from an earlier day show the date too.

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
├── server.py         # The WebSocket server: connections and routing
├── db.py             # Saving and loading messages (SQLite)
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
| Client → server | `join` | Join a room: `{ "type": "join", "room": "general", "name": "...", "client_id": "..." }`. Also sent once when the page connects. `client_id` is the tab's own id, kept across reloads, so your saved messages still show as yours |
| Server → client | `joined` | Confirms the room (with its cleaned-up name) and your `id`. The page switches to it |
| Client → server | `rename` | Change your display name: `{ "type": "rename", "name": "..." }` |
| Client → server | `chat` | Sends a message to your current room: `{ "type": "chat", "text": "..." }` |
| Server → room | `chat` | The saved message, sent to everyone in that room: sender's `id` and `name`, `room`, `text`, plus its `msg_id` and `sent_at` time |
| Server → client | `history` | Saved messages from a room, oldest first: `{ "room", "messages": [...], "more": true/false, "older": true/false }`. Sent after `joined`, and in answer to `load_more` |
| Client → server | `load_more` | Ask for older messages: `{ "type": "load_more", "before": <oldest msg_id you have> }` |
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
| No accounts, so anyone can use any display name (two people can both be "Alex") | Phase 4 |
| Private messages aren't saved, because they're tied to a connection id that changes on every reload | Phase 4 |
| If the connection drops, you have to reload the page, which starts a new identity and loses your private chats | Phase 5 |
| Only runs on `localhost` | Phase 6 |

## License

Free to use and modify.
