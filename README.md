# WebSocket Chat

A small real-time chat app: a Python WebSocket server and a single-page browser client, with no frameworks and no build step.

Open the page in a few browser tabs and the messages appear in all of them instantly.

## Features

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

## Deploying

To make the chat available on the internet:

1. Host `server.py` on a service that keeps a process running (for example Render, Railway, Fly.io or a VPS).
2. Make the server listen on `0.0.0.0` and use the port your host provides.
3. Point the client at your server's address using `wss://` (secure WebSockets). Browsers block plain `ws://` on pages served over HTTPS.

## Limitations

- Messages aren't stored. They're lost when the server restarts, and someone who joins later doesn't see earlier messages.
- There are no accounts or logins, so anyone can choose any display name.

## License

Free to use and modify.
