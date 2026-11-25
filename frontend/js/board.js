// The drawing board: a shared canvas in the side panel, one per conversation.
//
// How it stays in step: while you draw, your points are sent in small batches
// (about 20 a second, not one message per mouse movement). The server passes
// each batch to everyone else with the board open, so they watch your line
// grow, and saves the finished line when you lift the pen.
//
// Every screen is a different size, so all points are in "board units" on a
// fixed 1000 x 1250 board (the same numbers as backend/board.py). Each page
// scales the board to fit its own panel.

import { state } from "./state.js";
import { sendJSON } from "./connection.js";

const W = 1000;
const H = 1250;
const COLORS = { black: "#111827", blue: "#2563eb", red: "#dc2626", green: "#16a34a" };
const LINE_WIDTH = 5;     // board units
const TEXT_SIZE = 34;     // board units
const SEND_EVERY = 50;    // ms between batches while drawing
const CURSOR_EVERY = 80;  // ms between cursor updates
const ERASE_DISTANCE = 14;
// Each person gets their own colour for their cursor and avatar.
const PEOPLE_COLORS = ["#ea580c", "#7c3aed", "#0891b2", "#db2777", "#65a30d", "#0d9488"];

const app = document.querySelector(".app");
const panel = document.getElementById("board-panel");
const wrap = document.getElementById("board-wrap");
const canvas = document.getElementById("board-canvas");
const ctx = canvas.getContext("2d");
const viewersEl = document.getElementById("board-viewers");
const noteEl = document.getElementById("board-note");
const boardBtn = document.getElementById("board-btn");

const NOTE = "Everyone in this conversation sees it live.";

const board = {
  open: false,
  key: null,             // the conversation it belongs to: "room:general" or "dm:<id>"
  strokes: new Map(),    // saved strokes, by id, in drawing order
  live: new Map(),       // others' strokes still being drawn: "<user id>:<sid>" -> stroke
  cursors: new Map(),    // others' pointers: user id -> { x, y, name, at }
  viewers: [],
  tool: "pen",
  color: "blue",
  mine: null,            // the stroke I'm drawing right now
  pending: [],           // my points not sent yet
  erased: new Set(),     // strokes I've asked to erase (so I ask only once)
  view: { scale: 1, x: 0, y: 0, dpr: 1, width: 0, height: 0 },
};
let strokeCount = 0;
let sendTimer = null;
let answerTimer = null;   // notices a server that never answers board_open
let lastCursorSent = 0;
let drawQueued = false;

// --- Opening and closing ---

export function toggleBoard() {
  if (board.open) closeBoard();
  else openBoard();
}

export function openBoard() {
  if (!state.activeKey || !state.loggedIn) return;
  board.open = true;
  panel.classList.remove("hidden");
  app.classList.add("with-panel");
  boardBtn.setAttribute("aria-pressed", "true");
  boardBtn.classList.add("active");
  requestBoard(state.activeKey);
  resize();
}

export function closeBoard() {
  if (!board.open) return;
  board.open = false;
  board.key = null;
  cancelMyStroke();
  removeTextBox();
  panel.classList.add("hidden");
  app.classList.remove("with-panel");
  boardBtn.setAttribute("aria-pressed", "false");
  boardBtn.classList.remove("active");
  sendJSON({ type: "board_close" });
}

// Ask the server for the board of a conversation (it checks we're allowed in).
function requestBoard(key) {
  cancelMyStroke();
  removeTextBox();
  board.key = key;
  board.strokes.clear();
  board.live.clear();
  board.cursors.clear();
  board.erased.clear();
  board.viewers = [];
  renderViewers();
  setNote(NOTE);
  queueDraw();
  sendJSON(key.startsWith("dm:")
    ? { type: "board_open", with: key.slice(3) }
    : { type: "board_open", room: key.slice(5) });
  // A server started before the board existed ignores board messages. Say so,
  // instead of letting drawing look like it works when nothing is shared or saved.
  clearTimeout(answerTimer);
  answerTimer = setTimeout(() => {
    if (board.open && board.key === key) {
      setNote("The server isn't answering. If it was started before the board was added, restart it.", true);
    }
  }, 4000);
}

// Another conversation was opened: the board follows it.
export function boardFollow(key) {
  if (board.open && key !== board.key) requestBoard(key);
}

// We logged back in after the connection dropped: open the board again.
export function boardReconnected() {
  if (board.open && state.activeKey) requestBoard(state.activeKey);
}

// --- Messages from the server ---

export function handleBoardMessage(msg) {
  if (!board.open || msg.key !== board.key) return; // for a board we've left
  switch (msg.type) {
    case "board_state":
      clearTimeout(answerTimer); // the server answered
      setNote(NOTE);
      board.strokes = new Map(msg.strokes.map(s => [s.id, s]));
      break;

    case "board_viewers": {
      board.viewers = msg.viewers;
      // Forget the cursors and unfinished lines of people who left.
      const here = new Set(msg.viewers.map(v => v.id));
      for (const id of board.cursors.keys()) if (!here.has(id)) board.cursors.delete(id);
      for (const k of board.live.keys()) if (!here.has(k.split(":")[0])) board.live.delete(k);
      renderViewers();
      break;
    }

    case "board_draw": {
      // Someone else's line, a batch at a time.
      const k = msg.id + ":" + msg.sid;
      let s = board.live.get(k);
      if (!s) board.live.set(k, s = { tool: msg.tool, color: msg.color, text: msg.text, points: [] });
      s.points.push(...msg.points);
      break;
    }

    case "board_saved":
      // A finished line: swap the live copy (or my own) for the saved one.
      board.live.delete(msg.id + ":" + msg.sid);
      if (msg.stroke) board.strokes.set(msg.stroke.id, msg.stroke);
      break;

    case "board_removed":
      for (const id of msg.ids) board.strokes.delete(id);
      break;

    case "board_cleared":
      board.strokes.clear();
      board.live.clear();
      setNote(`${msg.by === state.myName ? "You" : msg.by} cleared the board.`);
      break;

    case "board_cursor":
      board.cursors.set(msg.id, { x: msg.x, y: msg.y, name: msg.name, at: Date.now() });
      break;
  }
  queueDraw();
}

// --- Who's on the board ---

function personColor(id) {
  return PEOPLE_COLORS[Number(id) % PEOPLE_COLORS.length] || PEOPLE_COLORS[0];
}

function renderViewers() {
  viewersEl.textContent = "";
  for (const v of board.viewers.slice(0, 5)) {
    const a = document.createElement("span");
    a.className = "viewer";
    a.textContent = v.name[0].toUpperCase();
    a.title = v.id === state.myId ? "You" : v.name;
    a.style.background = v.id === state.myId ? "#3b82f6" : personColor(v.id);
    viewersEl.appendChild(a);
  }
  const count = document.createElement("span");
  count.className = "viewer-count";
  count.textContent = board.viewers.length === 1 ? "Just you" : `${board.viewers.length} here`;
  viewersEl.appendChild(count);
}

let noteTimer = null;
// A short message under the board. It goes back to the usual one after a few
// seconds, unless it's a problem that stays until it's fixed (`sticky`).
function setNote(text, sticky = false) {
  noteEl.textContent = text;
  noteEl.classList.toggle("problem", sticky);
  clearTimeout(noteTimer);
  if (text !== NOTE && !sticky) noteTimer = setTimeout(() => setNote(NOTE), 5000);
}

// --- Drawing on the screen ---

// Fit the 1000 x 1250 board into the panel, keeping its shape.
function resize() {
  const rect = wrap.getBoundingClientRect();
  const v = board.view;
  v.dpr = window.devicePixelRatio || 1;
  v.width = rect.width;
  v.height = rect.height;
  canvas.width = Math.round(rect.width * v.dpr);
  canvas.height = Math.round(rect.height * v.dpr);
  v.scale = Math.min(rect.width / W, rect.height / H);
  v.x = (rect.width - W * v.scale) / 2;
  v.y = (rect.height - H * v.scale) / 2;
  queueDraw();
}
new ResizeObserver(() => { if (board.open) resize(); }).observe(wrap);

// Draw at most once per screen refresh, however many messages arrive.
function queueDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawBoard(); });
}

function drawBoard() {
  const v = board.view;
  ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
  ctx.clearRect(0, 0, v.width, v.height);
  ctx.save();
  ctx.translate(v.x, v.y);
  ctx.scale(v.scale, v.scale);
  drawPaper(ctx);
  for (const s of board.strokes.values()) drawStroke(ctx, s);
  for (const s of board.live.values()) drawStroke(ctx, s);
  if (board.mine) drawStroke(ctx, board.mine);
  ctx.restore();
  drawCursors();
}

// White paper with a light dot grid.
function drawPaper(c) {
  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, W, H);
  c.fillStyle = "#d7dde6";
  for (let x = 25; x < W; x += 50) {
    for (let y = 25; y < H; y += 50) c.fillRect(x - 1.5, y - 1.5, 3, 3);
  }
}

// One stroke, in board units. Also used for snapshot pictures in the chat.
function drawStroke(c, s) {
  const p = s.points;
  c.strokeStyle = c.fillStyle = COLORS[s.color] || COLORS.black;
  c.lineWidth = LINE_WIDTH;
  c.lineCap = c.lineJoin = "round";
  if (s.tool === "text") {
    if (p.length < 2 || !s.text) return;
    c.font = `600 ${TEXT_SIZE}px system-ui, "Segoe UI", sans-serif`;
    c.textBaseline = "middle";
    c.fillText(s.text, p[0], p[1]);
  } else if (s.tool === "arrow") {
    if (p.length < 4) return;
    const [x1, y1, x2, y2] = [p[0], p[1], p[p.length - 2], p[p.length - 1]];
    const angle = Math.atan2(y2 - y1, x2 - x1);
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    for (const side of [-1, 1]) {  // the two sides of the arrow head
      c.moveTo(x2, y2);
      c.lineTo(x2 - 26 * Math.cos(angle + side * 0.45), y2 - 26 * Math.sin(angle + side * 0.45));
    }
    c.stroke();
  } else {
    if (p.length < 2) return;
    c.beginPath();
    c.moveTo(p[0], p[1]);
    if (p.length === 2) c.lineTo(p[0] + 0.1, p[1]); // a single dot
    // Curves through the middle of each pair of points look smoother than straight lines.
    for (let i = 2; i < p.length - 2; i += 2) {
      c.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    }
    if (p.length > 2) c.lineTo(p[p.length - 2], p[p.length - 1]);
    c.stroke();
  }
}

// Other people's pointers, with their names, drawn in screen pixels so they
// stay the same size however small the board is.
function drawCursors() {
  const v = board.view;
  const now = Date.now();
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (const [id, cur] of board.cursors) {
    if (now - cur.at > 4000) { board.cursors.delete(id); continue; } // gone quiet
    const x = v.x + cur.x * v.scale;
    const y = v.y + cur.y * v.scale;
    const color = personColor(id);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 11, y + 5);
    ctx.lineTo(x + 5, y + 7);
    ctx.lineTo(x + 3, y + 13);
    ctx.closePath();
    ctx.fill();
    const w = ctx.measureText(cur.name).width + 12;
    ctx.beginPath();
    ctx.roundRect(x + 10, y + 12, w, 20, 5);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(cur.name, x + 16, y + 22);
  }
}
// Fade out cursors that stopped moving.
setInterval(() => { if (board.open && board.cursors.size) queueDraw(); }, 1000);

// --- Drawing with the mouse, a pen or a finger ---

// Screen position -> board units.
function toBoard(e) {
  const rect = canvas.getBoundingClientRect();
  const v = board.view;
  const x = (e.clientX - rect.left - v.x) / v.scale;
  const y = (e.clientY - rect.top - v.y) / v.scale;
  return { x: Math.round(Math.min(Math.max(x, 0), W)), y: Math.round(Math.min(Math.max(y, 0), H)), inside: x >= 0 && x <= W && y >= 0 && y <= H };
}

canvas.addEventListener("pointerdown", (e) => {
  if (!board.open || !state.loggedIn) return;
  const p = toBoard(e);
  if (!p.inside) return;
  e.preventDefault();
  if (board.tool === "text") { showTextBox(p); return; }
  canvas.setPointerCapture(e.pointerId);
  if (board.tool === "eraser") { eraseAt(p); return; }

  board.mine = { sid: Date.now().toString(36) + (strokeCount++), tool: board.tool, color: board.color, points: [p.x, p.y] };
  board.pending = [p.x, p.y];
  if (board.tool === "pen") sendTimer = setInterval(() => sendBatch(false), SEND_EVERY);
  queueDraw();
});

canvas.addEventListener("pointermove", (e) => {
  if (!board.open) return;
  const p = toBoard(e);
  sendCursor(p);
  if (board.tool === "eraser" && e.buttons) { eraseAt(p); return; }
  const m = board.mine;
  if (!m) return;
  if (m.tool === "arrow") {
    m.points = [m.points[0], m.points[1], p.x, p.y]; // just the two ends
  } else {
    // Skip points too close to the last one: the line looks the same, with fewer messages.
    const lx = m.points[m.points.length - 2], ly = m.points[m.points.length - 1];
    if (Math.hypot(p.x - lx, p.y - ly) < 3) return;
    m.points.push(p.x, p.y);
    board.pending.push(p.x, p.y);
  }
  queueDraw();
});

canvas.addEventListener("pointerup", finishMyStroke);
canvas.addEventListener("pointercancel", finishMyStroke);

function finishMyStroke() {
  const m = board.mine;
  if (!m) return;
  clearInterval(sendTimer);
  if (m.tool === "arrow") {
    if (m.points.length < 4) { cancelMyStroke(); return; } // a click, not an arrow
    board.pending = m.points;
  }
  sendBatch(true);
  // Keep showing it until the server sends back the saved copy.
  board.live.set(state.myId + ":" + m.sid, m);
  board.mine = null;
  queueDraw();
}

function cancelMyStroke() {
  clearInterval(sendTimer);
  board.mine = null;
  board.pending = [];
}

// Send the points drawn since the last batch (and "done" at the end).
function sendBatch(done) {
  const m = board.mine;
  if (!m || (!done && board.pending.length === 0)) return;
  sendJSON({ type: "board_draw", sid: m.sid, tool: m.tool, color: m.color, points: board.pending, done });
  board.pending = [];
}

function sendCursor(p) {
  const now = Date.now();
  if (!p.inside || now - lastCursorSent < CURSOR_EVERY) return;
  lastCursorSent = now;
  sendJSON({ type: "board_cursor", x: p.x, y: p.y });
}

// --- Eraser: rub out whole strokes ---

function eraseAt(p) {
  // The newest stroke under the pointer goes first.
  const strokes = [...board.strokes.values()].reverse();
  const hit = strokes.find(s => !board.erased.has(s.id) && touches(s, p));
  if (!hit) return;
  board.erased.add(hit.id);
  sendJSON({ type: "board_erase", stroke: hit.id });
}

function touches(s, p) {
  const pts = s.points;
  if (s.tool === "text") {
    const width = s.text.length * TEXT_SIZE * 0.58;
    return p.x >= pts[0] - 6 && p.x <= pts[0] + width && Math.abs(p.y - pts[1]) <= TEXT_SIZE * 0.6;
  }
  const line = s.tool === "arrow" ? [pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]] : pts;
  if (line.length === 2) return Math.hypot(p.x - line[0], p.y - line[1]) <= ERASE_DISTANCE;
  for (let i = 0; i + 3 < line.length; i += 2) {
    if (distanceToSegment(p, line[i], line[i + 1], line[i + 2], line[i + 3]) <= ERASE_DISTANCE) return true;
  }
  return false;
}

function distanceToSegment(p, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
}

// --- Text labels ---

let textBox = null;

function showTextBox(p) {
  removeTextBox();
  const v = board.view;
  textBox = document.createElement("input");
  textBox.className = "board-text";
  textBox.maxLength = 80;
  textBox.placeholder = "Type, then Enter";
  textBox.style.left = v.x + p.x * v.scale + "px";
  textBox.style.top = v.y + p.y * v.scale - 16 + "px";
  textBox.style.color = COLORS[board.color];
  textBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitText(p);
    else if (e.key === "Escape") removeTextBox();
  });
  textBox.addEventListener("blur", () => commitText(p));
  wrap.appendChild(textBox);
  textBox.focus();
}

function commitText(p) {
  if (!textBox) return;
  const text = textBox.value.trim();
  removeTextBox();
  if (!text) return;
  const sid = Date.now().toString(36) + (strokeCount++);
  const stroke = { sid, tool: "text", color: board.color, text, points: [p.x, p.y] };
  sendJSON({ type: "board_draw", sid, tool: "text", color: board.color, text, points: [p.x, p.y], done: true });
  board.live.set(state.myId + ":" + sid, stroke);
  queueDraw();
}

function removeTextBox() {
  const box = textBox;
  textBox = null;   // first, so the blur from remove() doesn't commit it again
  box?.remove();
}

// --- The toolbar ---

for (const btn of panel.querySelectorAll("[data-tool]")) {
  btn.onclick = () => {
    board.tool = btn.dataset.tool;
    for (const b of panel.querySelectorAll("[data-tool]")) {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    }
    canvas.dataset.tool = board.tool; // the CSS picks a matching mouse pointer
  };
}
for (const btn of panel.querySelectorAll("[data-color]")) {
  btn.onclick = () => {
    board.color = btn.dataset.color;
    for (const b of panel.querySelectorAll("[data-color]")) {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    }
  };
}
canvas.dataset.tool = board.tool;

document.getElementById("board-undo").onclick = () => sendJSON({ type: "board_undo" });
document.getElementById("board-clear").onclick = () => {
  if (board.strokes.size && confirm("Clear the board for everyone in this conversation?")) {
    sendJSON({ type: "board_clear" });
  }
};
document.getElementById("board-snapshot").onclick = () => {
  sendJSON({ type: "board_snapshot" });
  setNote("Snapshot posted to the chat.");
};
document.getElementById("board-close").onclick = closeBoard;

// --- Snapshots in the chat ---

// A picture of the board, as it was when someone posted it.
export function buildSnapshotCard(snapshot) {
  const card = document.createElement("div");
  card.className = "snapshot";

  const title = document.createElement("div");
  title.className = "poll-question";
  title.textContent = "Board snapshot";
  card.appendChild(title);

  const width = 260;
  const picture = document.createElement("canvas");
  picture.className = "snapshot-picture";
  const dpr = window.devicePixelRatio || 1;
  picture.width = Math.round(width * dpr);
  picture.height = Math.round(width * (H / W) * dpr);
  picture.style.width = width + "px";
  picture.setAttribute("role", "img");
  picture.setAttribute("aria-label", "A picture of the drawing board");
  const c = picture.getContext("2d");
  c.scale((width / W) * dpr, (width / W) * dpr);
  drawPaper(c);
  for (const s of snapshot ? snapshot.strokes : []) drawStroke(c, s);
  card.appendChild(picture);

  const open = document.createElement("button");
  open.className = "poll-close";
  open.textContent = "Open the board";
  open.onclick = openBoard;
  card.appendChild(open);
  return card;
}
