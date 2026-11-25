// Conversations: the message list of each room and private chat, message
// bubbles, history (Phase 3) and read receipts (Phase 5).

import { state, conversations } from "./state.js";
import { sendJSON } from "./connection.js";
import { renderSidebar } from "./sidebar.js";
import { renderTyping } from "./typing.js";
import { focusInput } from "./composer.js";
import { buildPollCard } from "./polls.js";

const logs = document.getElementById("logs");
const titleEl = document.getElementById("title");

export function getConversation(key, name) {
  let c = conversations.get(key);
  if (!c) {
    const log = document.createElement("div");
    log.className = "log" + (key.startsWith("dm:") ? " dm-log" : "");
    logs.appendChild(log);
    c = {
      log, name, lastSenderId: null, unread: 0,
      // For "scroll up to load older messages".
      oldestId: null, hasMore: false, loading: false, historyAsked: false,
      // Read receipts: the newest message here, how far we've told the server
      // we read, and how far the others have read.
      newestId: 0, readSent: 0, otherRead: 0, reads: new Map(),
    };
    conversations.set(key, c);
    log.addEventListener("scroll", () => maybeLoadOlder(key));
  }
  if (name) c.name = name;
  return c;
}

export function openConversation(key) {
  state.activeKey = key;
  const c = getConversation(key);
  c.unread = 0;
  // The first time a private chat is opened, ask for what was said before.
  if (key.startsWith("dm:") && !c.historyAsked) {
    c.historyAsked = true;
    sendJSON({ type: "dm_history", with: key.slice(3) });
  }
  for (const other of conversations.values()) other.log.classList.toggle("active", other === c);
  scrollToBottom(c);
  markRead(key);
  renderTitle();
  renderSidebar();
  renderTyping();
  focusInput();
}

export function renderTitle() {
  const key = state.activeKey;
  titleEl.textContent = "";
  if (!key) return;
  const sub = document.createElement("span");
  sub.className = "sub";
  if (key.startsWith("room:")) {
    const room = key.slice(5);
    titleEl.textContent = "#" + room;
    sub.textContent = `${state.users.filter(u => u.room === room).length} here`;
  } else {
    const id = key.slice(3);
    const online = state.users.some(u => u.id === id);
    const person = state.people.find(p => p.id === id);
    titleEl.textContent = "@" + (person ? person.name : getConversation(key).name);
    // Offline is fine: the message waits for them.
    sub.textContent = online ? "online" : "offline, they'll see it when they log in";
  }
  titleEl.appendChild(sub);
}

// The server stamps every message with the time it was sent (in UTC).
// Show just the time for today's messages, and the date too for older ones.
function formatTime(sentAt) {
  const d = sentAt ? new Date(sentAt) : new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return d.toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + time;
}

function scrollToBottom(c) { c.log.scrollTop = c.log.scrollHeight; }

// A message arrived in a conversation we're not looking at: count it as unread.
function markUnread(key) {
  if (key === state.activeKey) return;
  getConversation(key).unread++;
  renderSidebar();
}

// Build one chat bubble. Mine on the right, everyone else's on the left.
// `prevSenderId` is who sent the message just above it, for grouping.
function buildRow(msg, prevSenderId) {
  const mine = msg.id === state.myId;
  const newSender = msg.id !== prevSenderId;

  const row = document.createElement("div");
  row.className = "row " + (mine ? "mine" : "theirs") + (newSender ? " new-sender" : "");
  if (msg.msg_id) row.dataset.msgId = msg.msg_id; // so read receipts can find it

  // Show the name only on others' messages, and only once per group.
  if (!mine && newSender) {
    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = msg.name;
    row.appendChild(sender);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (msg.poll) {
    // A poll: draw its card instead of text (see polls.js).
    bubble.classList.add("poll-bubble");
    bubble.appendChild(buildPollCard(msg.poll));
  } else {
    bubble.textContent = msg.text; // textContent (not innerHTML) so nobody can inject HTML
  }
  row.appendChild(bubble);

  const time = document.createElement("div");
  time.className = "time";
  time.textContent = formatTime(msg.sent_at);
  if (mine) {
    // One grey tick = sent (saved by the server). Turns into two blue ticks when seen.
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "✓";
    tick.title = "Sent";
    time.appendChild(tick);
  }
  row.appendChild(time);
  return row;
}

// A new message arrived: add it at the bottom.
export function addMessage(key, msg) {
  const c = getConversation(key);
  c.log.appendChild(buildRow(msg, c.lastSenderId));
  c.lastSenderId = msg.id;
  if (c.oldestId === null && msg.msg_id) c.oldestId = msg.msg_id;
  c.newestId = Math.max(c.newestId, msg.msg_id || 0);
  scrollToBottom(c);
  updateReceipts(key);
  markRead(key);
  markUnread(key);
}

export function addInfo(key, text, isError = false) {
  const c = getConversation(key);
  const div = document.createElement("div");
  div.className = "info" + (isError ? " error" : "");
  div.textContent = text;
  c.log.appendChild(div);
  c.lastSenderId = null; // start a new group after a notice
  scrollToBottom(c);
}

// --- Read receipts (Phase 5) ---

// Tell the server we've read this conversation, but only if it's the one
// on screen AND the browser tab is visible (a hidden tab hasn't "seen" anything).
function markRead(key) {
  const c = conversations.get(key);
  if (!c || !state.loggedIn || key !== state.activeKey || document.visibilityState !== "visible") return;
  if (c.newestId <= c.readSent) return; // nothing new since last time
  c.readSent = c.newestId;
  sendJSON(key.startsWith("dm:")
    ? { type: "read", with: key.slice(3), msg_id: c.newestId }
    : { type: "read", room: key.slice(5), msg_id: c.newestId });
}

// A tab coming back into view may now "see" messages that arrived while hidden.
document.addEventListener("visibilitychange", () => { if (state.activeKey) markRead(state.activeKey); });

// Redraw the receipts on our own messages in one conversation.
export function updateReceipts(key) {
  const c = conversations.get(key);
  if (!c) return;
  if (key.startsWith("dm:")) {
    // Private chat: every one of our messages up to otherRead is seen.
    for (const row of c.log.querySelectorAll(".row.mine[data-msg-id]")) {
      const tick = row.querySelector(".tick");
      const seen = Number(row.dataset.msgId) <= c.otherRead;
      tick.textContent = seen ? "✓✓" : "✓";
      tick.title = seen ? "Seen" : "Sent";
      tick.classList.toggle("seen", seen);
    }
    return;
  }
  // Room: "Seen by ..." under our latest message only.
  c.log.querySelector(".seen-by")?.remove();
  const mineRows = c.log.querySelectorAll(".row.mine[data-msg-id]");
  const last = mineRows[mineRows.length - 1];
  if (!last) return;
  const id = Number(last.dataset.msgId);
  const names = [...c.reads.values()].filter(r => r.id !== state.myId && r.last >= id).map(r => r.name);
  if (names.length === 0) return;
  const div = document.createElement("div");
  div.className = "seen-by";
  div.textContent = "Seen by " + (names.length <= 3
    ? names.join(", ")
    : names.slice(0, 3).join(", ") + ` and ${names.length - 3} more`);
  last.appendChild(div);
}

// --- Message history (Phase 3) ---

// Build a batch of saved messages, oldest first, as one fragment.
function buildHistory(messages) {
  const frag = document.createDocumentFragment();
  let prev = null;
  for (const m of messages) {
    frag.appendChild(buildRow(m, prev));
    prev = m.id;
  }
  return { frag, lastSenderId: prev };
}

export function showHistory(msg) {
  // History is either for a room or for a private chat with one person.
  const key = msg.dm ? "dm:" + msg.dm : "room:" + msg.room;
  const c = getConversation(key);
  c.loading = false;
  c.hasMore = msg.more;
  // Read receipts that come with the history: how far the others have read.
  if (msg.dm) c.otherRead = Math.max(c.otherRead, msg.other_read || 0);
  else for (const r of msg.reads || []) c.reads.set(r.id, r);
  if (msg.messages.length) c.oldestId = msg.messages[0].msg_id;
  const { frag, lastSenderId } = buildHistory(msg.messages);

  if (msg.older) {
    // Older messages go on top. Keep the view where it was, so the
    // messages the user is reading don't jump away.
    const oldHeight = c.log.scrollHeight;
    c.log.prepend(frag);
    c.log.scrollTop += c.log.scrollHeight - oldHeight;
  } else {
    // Just joined: replace whatever we had with the saved history.
    c.log.textContent = "";
    c.log.appendChild(frag);
    c.lastSenderId = lastSenderId;
    if (msg.messages.length) c.newestId = Math.max(c.newestId, msg.messages.at(-1).msg_id);
    scrollToBottom(c);
  }
  if (!c.hasMore && msg.messages.length) {
    const start = document.createElement("div");
    start.className = "info";
    start.textContent = msg.dm
      ? "This is the start of your private chat with " + c.name
      : "This is the start of #" + msg.room;
    c.log.prepend(start);
  }
  updateReceipts(key);
  markRead(key);
}

// When the user scrolls near the top of a conversation, ask for older messages.
function maybeLoadOlder(key) {
  const c = conversations.get(key);
  if (!c.hasMore || c.loading || c.log.scrollTop > 40) return;
  c.loading = true;
  sendJSON(key.startsWith("dm:")
    ? { type: "load_more", before: c.oldestId, with: key.slice(3) }
    : { type: "load_more", before: c.oldestId });
}
