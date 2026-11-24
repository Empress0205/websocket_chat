# WebSocket Chat: Learning WebSockets Step by Step

This repo records my progress learning **WebSockets**, from first principles up to a production-ready real-time app. It grows in phases, and each phase adds one new idea on top of the last.

> **Current status: Phase 5 complete, a reliable chat with accounts, private rooms, saved history, read receipts and automatic reconnecting.**

So far it's a Python WebSocket server and a single-page browser client, with no frameworks and no build step. Open the page in a few browser tabs, put them in different rooms, and message each other publicly or privately.

## Learning roadmap

| Phase | Focus | Status |
|---|---|---|
| **1** | WebSocket basics: a real-time chat | ✅ Done |
| **2** | Rooms and private messages | ✅ Done |
| **3** | Saving messages and showing history | ✅ Done |
| **4** | Users and authentication | ✅ Done |
| **5** | Reliability: reconnecting, heartbeats, offline messages, read receipts | ✅ Done |
| **6** | Deploying online over secure `wss://` | 🔜 Next |

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

### Phase 4: Users and authentication ✅

**Goal:** know who each person really is (authentication), and control what each person may see (authorization).

What I learned:

- **Never store passwords.** The server stores a *hash*: a one-way scramble made with PBKDF2, repeated 600,000 times so each guess is slow for an attacker. A random **salt** per user means two people with the same password get different hashes.
- Comparing hashes with `hmac.compare_digest`, which takes the same time however much of a guess is right, so timing can't leak anything.
- Hashing is slow on purpose (about 0.3 seconds), and an async server must never block. `asyncio.to_thread` runs it in the background so everyone else's messages keep flowing.
- **Authenticating a WebSocket:** logging in happens over the connection itself. The server sends back a random **token**, the page keeps it in `sessionStorage`, and after a reload it sends `resume` with that token instead of the password.
- The database keeps only a **hash of each token**, so a copied database can't be used to log in as anyone.
- Giving the **same error** for an unknown username and a wrong password, so nobody can find out which usernames exist.
- **Rate limiting** with a token bucket: a burst of 5 messages is fine, a flood is not. Login attempts get their own, stricter limit to slow down password guessing.
- A **fixed identity** fixes the problems from Phase 3: messages are matched to an account, not a tab, so private messages can now be saved too.
- Never printing passwords or tokens in the server log.
- Splitting the code further: `auth.py` for accounts and `ratelimit.py` for limits, so `server.py` stays about connections.
- **Authentication vs authorization.** Logging in proves *who* you are. Authorization decides *what you may do*: which rooms you can enter, and whether you can create accounts and rooms.
- **No public sign-up.** In a company tool, letting anyone create an account means any stranger who reaches the server can read `#general`. Only admins create accounts, and the server refuses a `signup` message even if someone sends it by hand.
- **Enforce access on the server.** Hiding a room in the sidebar is only a convenience, because anyone can send `{"type": "join", "room": "bank-x"}` by hand. The server checks every `join` against the database.
- Keeping the access rule in **one query** (`rooms_for` in `db.py`), so the sidebar, `join` and the online list can never disagree.
- **Leaking through side doors:** the online list showed which room everyone was in, which would reveal private room names. Each person now gets their own version of the list.
- Admins are made with a **command-line tool** (`manage.py`) on the server, so nobody can make themselves an admin from the browser. Admin rights are checked in the database on every admin action, so removing them works immediately.
- A small **database migration**: adding the `is_admin` column to an existing `users` table without losing any accounts.

### Phase 5: Reliability ✅

**Goal:** keep working when the network or the server misbehaves, and never lose a message.

What I learned:

- **Reconnecting with exponential backoff.** When the connection drops, the page waits about 1, 2, 4, 8, 16 and then 30 seconds between tries. Waiting longer each time avoids hammering a server that's struggling.
- **Jitter:** each wait gets a random extra ±20%. Without it, a hundred pages would all reconnect at the same instant after a server restart.
- The browser's `online` event tells the page the network is back, so it can reconnect at once instead of waiting.
- **Heartbeats.** A connection can die silently (a laptop goes to sleep, wifi switches) and still look open. The `websockets` library pings every client every 20 seconds and drops the ones that don't answer. The page does the same from its side: it sends `ping` every 25 seconds, and if no `pong` comes back within 10 seconds it treats the connection as dead.
- After reconnecting, the page logs in again with its token, rejoins the same room and fetches what it missed, so the user barely notices.
- Disabling *Send* while disconnected, so a message can never be "sent" into nothing.
- **One table, three features.** Remembering how far each person has read in each conversation gives unread badges after logging in, messages that wait for people who are offline, and read receipts.
- **Read receipts** only count a message as seen when its conversation is open *and* the tab is visible (`document.visibilityState`).
- An SQL **upsert** (`INSERT ... ON CONFLICT DO UPDATE`) to create or update a row in one step.
- Limiting login attempts **per username**, not per connection, so reconnecting after every few guesses doesn't help an attacker. The trade-off: someone could lock a real user out for a while by guessing wrong on purpose.

### Phase 6: Deployment 🔜

- Host the server online and serve the page from the same place.
- Use secure WebSockets (`wss://`) over HTTPS.
- Look at how to scale past a single server, for example using Redis pub/sub.

---

## Features

### Added in Phase 5

- **Automatic reconnecting.** If the connection drops, the header shows "Reconnecting in 4s…" with a yellow dot, and the page reconnects by itself, back in the same room and conversation.
- **Dead connection detection.** Heartbeats on both sides notice a connection that died without closing.
- **Messages to people who are offline.** The sidebar lists everyone with an account (a green dot means online). Message anyone; it waits for them.
- **Unread badges after logging in.** Messages that arrived while you were away are counted per room and per private chat.
- **Read receipts.** In private chats, one grey tick means sent and two blue ticks mean seen. In rooms, your latest message shows "Seen by ...".

### Added in Phase 4

- **Log in with an account from your admin.** There's no sign-up: admins create every account. Usernames are unique (ignoring capital letters), and passwords need at least 8 characters.
- **Stay logged in.** Reloading the tab logs you straight back in. Closing the tab or pressing *Log out* ends it.
- **One tab per account.** Logging in from a second tab signs out the first.
- **Saved private messages.** Opening a private chat shows what the two of you said before, and you can scroll up for more.
- **Spam protection.** Sending more than 5 messages in a burst gets a "slow down" warning, and repeated wrong passwords are slowed down.
- **Private rooms.** `#general` is open to everyone. Every other room is private: you only see it in your sidebar if an admin added you, and the server refuses to let anyone else in.
- **Admins.** An admin sees every room and gets an *Admin* panel to create accounts, create private rooms, and add or remove members. A removed member is moved back to `#general` straight away.
- **Private room names stay private.** In the *Online* list you see who is online, but not which private room they're in unless you can enter it too.

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

### From Phase 1

- **Real-time messaging.** Messages go to every connected client the moment they're sent.
- **Chat bubbles.** Your messages appear on the right and everyone else's on the left, grouped by sender, each with a timestamp.
- **Typing indicator.** Animated dots show who's typing (e.g. "Alex is typing…") in the conversation you're looking at. They clear automatically 2 seconds after the last keystroke.
- **Join / leave notices.** Everyone sees when someone connects or disconnects, along with the number of people online.
- **Connection status.** A green or red dot in the header shows whether you're connected to the server.
- **Safe by default.** The server ignores malformed messages instead of crashing, and the page renders message text as plain text, so nobody can inject HTML.

## Project structure

The project is split into a **backend** (the Python server) and a **frontend** (the page in the browser). They only talk to each other over the WebSocket.

```
.
├── backend/
│   ├── server.py          # The WebSocket server: connections and routing
│   ├── db.py              # Saving and loading users, logins, rooms and messages (SQLite)
│   ├── auth.py            # Password hashing, login tokens, username and password rules
│   ├── ratelimit.py       # Stops anyone sending too much, too fast
│   ├── manage.py          # Admin tasks from the command line
│   ├── requirements.txt   # Python dependencies
│   └── chat.db            # The database (created on first run, never committed)
└── frontend/
    ├── index.html         # The page layout only
    ├── css/style.css      # All the styling
    └── js/
        ├── main.js            # The starting point: index.html loads only this
        ├── state.js           # Shared values (who am I, which chat is open, ...)
        ├── connection.js      # The WebSocket: connecting, reconnecting, heartbeat
        ├── handlers.js        # What to do with each message from the server
        ├── conversations.js   # Message lists, history, read receipts
        ├── sidebar.js         # Rooms and people
        ├── login.js           # The log-in screen
        ├── admin.js           # The Admin panel
        ├── typing.js          # "... is typing"
        └── composer.js        # The message box and Send button
```

The JavaScript files are **ES modules**: each one says what it `export`s, and what it `import`s from the others, so it's clear how they depend on each other.

## Getting started

### Requirements

- Python 3.9 or newer
- A modern web browser

### 1. Install dependencies

```bash
pip install -r backend/requirements.txt
```

### 2. Start the server

```bash
cd backend
python server.py
```

You should see:

```
WebSocket server running at ws://localhost:8765
```

### 3. Create the first admin

There's no sign-up page: accounts are created by an admin. Create the first one in a second terminal, also in the `backend` folder:

```bash
python manage.py create-user <username>      # asks for a password
python manage.py make-admin <username>
```

### 4. Open the chat

The page uses JavaScript modules, which browsers only load over `http://`, so **double-clicking `index.html` won't work**. Serve the `frontend` folder instead:

- **VS Code:** click *Go Live* (Live Server extension). The project's `.vscode/settings.json` already points it at `frontend/` and tells it to ignore the database.
- **Or any terminal:** `python -m http.server 8000 --directory frontend`, then open http://localhost:8000.

Log in as the admin. Click *Admin* in the sidebar to create accounts for other people and private rooms for them. Log in as someone else in a second tab, and click a name under *People* to send a private message.

Other commands: `python manage.py set-password <username>`, `python manage.py users` and `python manage.py rooms`.

> Only one server can use port 8765 at a time. If `python server.py` says the address is already in use, an older server is still running: stop it with Ctrl+C in its terminal.

## How it works

The client and server talk over a single WebSocket connection, using JSON messages. Each message has a `type` field.

Every connection starts logged out. Once it logs in, the server keeps that person's user `id`, `name` and `room` in memory and uses them to decide who receives each message. Users, logins and messages are stored in `chat.db`.

| Direction | `type` | Purpose |
|---|---|---|
| Client → server | `login` | `{ "type": "login", "username": "...", "password": "..." }`. Nothing else works until it succeeds. A `signup` message is always refused |
| Client → server | `resume` | Log back in after a reload: `{ "type": "resume", "token": "..." }` |
| Server → client | `auth_ok` | Logged in: `{ "user": { "id", "name" }, "token" }`. The `token` is only sent after `login` |
| Server → client | `auth_error` | Why logging in failed, e.g. "Wrong username or password." |
| Client → server | `logout` | Ends the login: the token stops working |
| Server → client | `signed_out` | Sent before the server closes the connection, after `logout` or when the same account logs in from another tab |
| Server → client | `rooms` | The rooms you may enter, and whether you're an admin: `{ "rooms": [{ "name", "public" }], "admin": true/false }`. Sent after logging in and whenever an admin changes your access |
| Client → server | `join` | Join a room: `{ "type": "join", "room": "general" }`. Sent once right after logging in. Refused with an `error` if you may not enter that room |
| Server → client | `joined` | Confirms the room (with its cleaned-up name). The page switches to it |
| Client → server | `chat` | Sends a message to your current room: `{ "type": "chat", "text": "..." }` |
| Server → room | `chat` | The saved message, sent to everyone in that room: sender's `id` and `name`, `room`, `text`, plus its `msg_id` and `sent_at` time |
| Server → client | `history` | Saved messages, oldest first: `{ "room" or "dm", "messages": [...], "more": true/false, "older": true/false }`, plus read receipts: `other_read` (private chat) or `reads` (room). Sent after `joined`, `dm_history` and `load_more` |
| Client → server | `load_more` | Ask for older messages: `{ "type": "load_more", "before": <oldest msg_id you have> }`. Add `"with": "<user id>"` for a private chat |
| Client → server | `dm` | Private message: `{ "type": "dm", "to": "<their user id>", "text": "..." }` |
| Server → 2 people | `dm` | The saved message, sent to the recipient (if online) and back to the sender, with `id`, `name`, `to`, `text`, `msg_id` and `sent_at`. If the recipient is offline, it waits for them |
| Client → server | `read` | "I've read up to here": `{ "type": "read", "msg_id": 42, "room": "general" }` or `"with": "<user id>"` for a private chat |
| Server → room / 1 person | `seen` | Someone read up to `msg_id`: `{ "room", "id", "name", "msg_id" }` in a room, or `{ "with": "<reader id>", "msg_id" }` in a private chat |
| Server → client | `unread` | After logging in: messages waiting per conversation, e.g. `{ "counts": { "room:general": 3, "dm:5": 1 } }` |
| Client → server | `dm_history` | Opened a private chat: `{ "type": "dm_history", "with": "<user id>" }` |
| Client → server | `typing` | "I'm typing", at most once per second. Add `"to": "<id>"` when typing in a private chat |
| Server → room / 1 person | `typing` | Passed on to the room (with `room`) or to the private-chat partner (with `"dm": true`) |
| Server → room | `info` | Join / leave notices for that room |
| Server → each user | `users` | Who is online: `[{ "id", "name", "room" }, ...]`. `room` is `null` when it's a private room you can't enter |
| Server → client | `people` | Everyone with an account: `[{ "id", "name" }, ...]`. Sent after logging in and when an admin creates an account |
| Client → server / Server → client | `ping` / `pong` | The page's heartbeat, every 25 seconds. No `pong` within 10 seconds means the connection is dead |
| Client → server | `admin_list` / `admin_create_user` / `admin_create_room` / `admin_add_member` / `admin_remove_member` | Admin only: list rooms, create an account (`username`, `password`), create a private room (`name`), or add or remove a member (`room`, `username`) |
| Server → admin | `admin_rooms` | Every room with its members, and every username, for the *Admin* panel |
| Server → client | `notice` | A plain notice, e.g. "You were given access to #bank-x." |
| Server → client | `error` | Something went wrong, e.g. a private message to someone who just left, or sending too fast |

## Configuration

By default the server listens on `localhost:8765` and the page connects to `ws://localhost:8765`. To change this:

- **Server:** edit the host and port in `main()` in `backend/server.py`.
- **Client:** edit `SERVER_URL` at the top of `frontend/js/connection.js`.

## Known limitations and when they get fixed

The project deliberately keeps things simple. These gaps are what the next phases are for:

| Limitation | Fixed in |
|---|---|
| Passwords travel unencrypted over `ws://`, which is only acceptable on your own computer | Phase 6 (`wss://`) |
| Only runs on `localhost` | Phase 6 |

## License

Free to use and modify.
