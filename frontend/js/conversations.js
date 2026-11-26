// Conversations: the message list of each room and private chat, message
// bubbles, history (Phase 3) and read receipts (Phase 5).

import { state, conversations } from "./state.js";
import { sendJSON } from "./connection.js";
import { renderSidebar } from "./sidebar.js";
import { renderTyping } from "./typing.js";
import { focusInput } from "./composer.js";
import { buildPollCard } from "./polls.js";
import { boardFollow, buildSnapshotCard } from "./board.js";
import { voiceFollow } from "./voice.js";
import { noteIncoming } from "./notify.js";

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
  boardFollow(key); // an open board switches to this conversation's board
  voiceFollow();    // show this conversation's huddle banner, if there is one
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
  if (msg.deleted) {
    row.appendChild(deletedBubble());
    const time = document.createElement("div");
    time.className = "time";
    time.textContent = formatTime(msg.sent_at);
    row.appendChild(time);
    return row;
  }
  if (msg.poll) {
    // A poll: draw its card instead of text (see polls.js).
    bubble.classList.add("poll-bubble");
    bubble.appendChild(buildPollCard(msg.poll));
  } else if (msg.board) {
    // A board snapshot: draw the picture (see board.js).
    bubble.classList.add("poll-bubble");
    bubble.appendChild(buildSnapshotCard(msg.board));
  } else {
    setText(bubble, msg.text);
  }
  row.text = msg.text; // kept for editing
  row.appendChild(bubble);

  // Reactions under the bubble ("👍 2"), if there are any.
  const reactions = document.createElement("div");
  reactions.className = "reactions";
  renderReactions(reactions, msg.msg_id, msg.reactions || []);
  row.appendChild(reactions);

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
  if (msg.edited) time.appendChild(editedLabel());
  // React, edit and delete: small buttons that show when you point at the message.
  if (msg.msg_id) time.appendChild(reactButton(msg.msg_id));
  if (canEdit(msg)) time.appendChild(editButton(row, msg.msg_id));
  if (canDelete(msg)) time.appendChild(deleteButton(msg.msg_id));
  row.appendChild(time);
  return row;
}

// --- Clickable links ---

// Web addresses: http://, https:// or www. Anything else (like "javascript:")
// is never turned into a link, so a message can't run code when clicked.
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

// Put a message's text in an element, with its web addresses as links. Every
// piece goes in as text (never as HTML), so nobody can inject HTML.
function setText(el, text) {
  el.textContent = "";
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    // Punctuation at the end is usually the sentence's, not the address's:
    // "see https://example.com." links to https://example.com.
    let url = match[0].replace(/[.,;:!?'"]+$/, "");
    if (url.endsWith(")") && !url.includes("(")) url = url.slice(0, -1);
    const href = url.startsWith("www.") ? "https://" + url : url;
    let safe = false;
    try { safe = ["http:", "https:"].includes(new URL(href).protocol); } catch { /* not a real address */ }
    if (!safe) continue;
    el.append(text.slice(last, match.index));
    const a = document.createElement("a");
    a.href = href;
    a.textContent = url;
    a.target = "_blank";             // a new tab, so the chat stays open
    a.rel = "noopener noreferrer";   // and the other site can't reach back into this page
    el.append(a);
    last = match.index + url.length;
  }
  el.append(text.slice(last));
}

// --- Editing your own messages ---

const PENCIL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 13.5l.8-3 7.5-7.5 2.2 2.2-7.5 7.5zM9.5 4.3l2.2 2.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

// Only your own text messages (not polls or board snapshots). The server checks again.
function canEdit(msg) {
  return Boolean(msg.msg_id) && msg.id === state.myId && !msg.poll && !msg.board;
}

function editedLabel() {
  const label = document.createElement("span");
  label.className = "edited";
  label.textContent = "(edited)";
  return label;
}

function editButton(row, msgId) {
  const btn = actionButton("edit-btn", "Edit", PENCIL);
  btn.onclick = () => startEdit(row, msgId);
  return btn;
}

// The bubble turns into a text box. Enter saves, Shift+Enter adds a line, Esc cancels.
function startEdit(row, msgId) {
  const bubble = row.querySelector(".bubble");
  if (bubble.classList.contains("editing")) return;
  const box = document.createElement("textarea");
  box.className = "edit-box";
  box.value = row.text;
  box.maxLength = 2000;
  box.rows = Math.min(6, row.text.split("\n").length + 1);
  const hint = document.createElement("div");
  hint.className = "edit-hint";
  hint.textContent = "Enter to save · Esc to cancel";
  bubble.classList.add("editing");
  bubble.replaceChildren(box, hint);
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);

  const stop = () => {
    bubble.classList.remove("editing");
    setText(bubble, row.text); // the server's "edited" message brings the new words
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      stop();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = box.value.trim();
      if (!text) {
        hint.textContent = "A message can't be empty. To remove it, delete it.";
        return;
      }
      if (text !== row.text) sendJSON({ type: "edit", msg_id: msgId, text });
      stop();
    }
  });
}

// Someone edited a message: show the new words, and "(edited)".
export function showEdited(key, msgId, text) {
  const row = findRow(key, msgId);
  if (!row) return; // not loaded here: history will have the new words
  row.text = text;
  const bubble = row.querySelector(".bubble");
  if (!bubble.classList.contains("editing")) setText(bubble, text);
  const time = row.querySelector(".time");
  if (!time.querySelector(".edited")) time.querySelector(".msg-action")?.before(editedLabel());
}

// --- Reactions ---

const REACTIONS = ["👍", "❤️", "😂", "😮", "🎉"]; // the same as REACTIONS in backend/server.py
const SMILEY = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.6 9.4c.6.9 1.4 1.3 2.4 1.3s1.8-.4 2.4-1.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="6.1" cy="6.6" r=".8" fill="currentColor"/><circle cx="9.9" cy="6.6" r=".8" fill="currentColor"/></svg>';

// The chips under a message: "👍 2". Yours are highlighted; click one to add or take back yours.
function renderReactions(el, msgId, reactions) {
  el.textContent = "";
  for (const r of reactions) {
    const chip = document.createElement("button");
    const names = r.users.map(u => (u.id === state.myId ? "You" : u.name));
    chip.className = "reaction" + (r.users.some(u => u.id === state.myId) ? " mine" : "");
    chip.textContent = `${r.emoji} ${r.users.length}`;
    chip.title = `${names.join(", ")} reacted with ${r.emoji}`;
    chip.onclick = () => sendJSON({ type: "react", msg_id: msgId, emoji: r.emoji });
    el.appendChild(chip);
  }
  el.hidden = reactions.length === 0;
}

// Someone reacted (or took a reaction back): redraw that message's chips.
export function showReactions(key, msgId, reactions) {
  const row = findRow(key, msgId);
  if (row) renderReactions(row.querySelector(".reactions"), msgId, reactions);
}

function reactButton(msgId) {
  const btn = actionButton("react-btn", "Add a reaction", SMILEY);
  btn.onclick = (e) => {
    e.stopPropagation();
    openPicker(btn, msgId);
  };
  return btn;
}

// One small menu of reactions, shown next to whichever message asked for it.
const picker = document.createElement("div");
picker.className = "react-picker";
picker.hidden = true;
picker.setAttribute("role", "menu");
document.body.appendChild(picker);
let pickerFor = null;

for (const emoji of REACTIONS) {
  const b = document.createElement("button");
  b.textContent = emoji;
  b.setAttribute("role", "menuitem");
  b.setAttribute("aria-label", "React with " + emoji);
  b.onclick = () => {
    sendJSON({ type: "react", msg_id: pickerFor, emoji });
    closePicker();
  };
  picker.appendChild(b);
}

function openPicker(button, msgId) {
  pickerFor = msgId;
  picker.hidden = false;
  const r = button.getBoundingClientRect();
  const width = picker.offsetWidth;
  picker.style.left = Math.max(8, Math.min(r.left - width / 2, window.innerWidth - width - 8)) + "px";
  picker.style.top = Math.max(8, r.top - picker.offsetHeight - 6) + "px"; // just above the button
  picker.querySelector("button").focus();
}

function closePicker() {
  picker.hidden = true;
  pickerFor = null;
}

document.addEventListener("click", (e) => { if (!picker.contains(e.target)) closePicker(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(); });
document.addEventListener("scroll", closePicker, true); // it would float away from its message

// --- Shared by edit, delete and react ---

function findRow(key, msgId) {
  const c = conversations.get(key);
  return c ? c.log.querySelector(`.row[data-msg-id="${Number(msgId)}"]`) : null;
}

function actionButton(className, label, icon) {
  const btn = document.createElement("button");
  btn.className = "msg-action " + className;
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = icon;
  return btn;
}

// --- Deleting messages ---

const TRASH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.7 7v4.5M9.3 7v4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GONE = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.1 11.9l7.8-7.8" stroke="currentColor" stroke-width="1.4"/></svg>';

// Your own messages, and (for admins) anyone's in a room. The server checks again.
function canDelete(msg) {
  if (!msg.msg_id) return false;
  const inRoom = !String(msg.room || "").startsWith("dm:") && !msg.to;
  return msg.id === state.myId || (state.isAdmin && inRoom);
}

function deleteButton(msgId) {
  const btn = actionButton("delete-btn", "Delete for everyone", TRASH);
  btn.onclick = () => {
    if (confirm("Delete this message for everyone? This can't be undone.")) {
      sendJSON({ type: "delete", msg_id: msgId });
    }
  };
  return btn;
}

function deletedBubble() {
  const bubble = document.createElement("div");
  bubble.className = "bubble deleted";
  bubble.innerHTML = GONE;
  bubble.append("This message was deleted");
  return bubble;
}

// Someone deleted a message: swap it for the placeholder, wherever it's on screen.
export function showDeleted(key, msgId) {
  const row = findRow(key, msgId);
  if (!row) return; // not loaded here: history will show it as deleted
  row.querySelector(".bubble").replaceWith(deletedBubble());
  // Nothing left to react to, edit or delete.
  for (const el of row.querySelectorAll(".msg-action, .tick, .edited, .reactions")) el.remove();
  if (pickerFor === Number(msgId)) closePicker();
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
  if (msg.id !== state.myId) noteIncoming(key, msg, openConversation); // title, sound, pop-up
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
