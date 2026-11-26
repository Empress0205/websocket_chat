// The drawing board: a shared canvas in the side panel, one per conversation.
//
// How it stays in step: while you draw, your points are sent in small batches
// (about 20 a second, not one message per mouse movement). The server passes
// each batch to everyone else with the board open, so they watch your line
// grow, and saves the finished line when you lift the pen.
//
// Every screen is a different size, so all points are in "board units" on a
// fixed 2000 x 1250 board (the same numbers as backend/board.py). Each page
// scales the board to fit the height of its panel ("100%"). You can zoom in
// and out and move around (pan); that's only on your screen, like Expand.
//
// The canvas is always exactly the size of the panel. Zooming doesn't make it
// bigger: the board is drawn into it with a scale and an offset ("the view").
// A canvas the size of a 4x board would take hundreds of megabytes.

import { state } from "./state.js";
import { sendJSON } from "./connection.js";

const W = 2000;
const H = 1250;
const BOARD_VERSION = 3;  // the same as VERSION in backend/board.py
const ZOOM_MAX = 4;       // 400% of the "fit the height" size
const ZOOM_STEP = 1.25;   // each click of + or -
const COLORS = { black: "#111827", blue: "#2563eb", red: "#dc2626", green: "#16a34a" };
// Shapes are drawn between two points: where the drag started and where it
// is now. The same list is in backend/board.py.
const SHAPES = new Set(["line", "arrow", "rect", "ellipse", "diamond", "triangle", "cloud", "cylinder"]);
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
  tool: "pen",           // pen, text, eraser, or one of the SHAPES
  shape: "rect",         // the shape the Shapes button picks
  color: "blue",
  mine: null,            // the stroke I'm drawing right now
  pending: [],           // my points not sent yet (pen)
  changed: false,        // my shape changed since it was last sent
  erased: new Set(),     // strokes I've asked to erase (so I ask only once)
  hiddenId: null,        // a label hidden while its text is being edited
  selected: null,        // the stroke picked with the Select tool (its id)
  drag: null,            // the stroke I'm dragging: { id, from: {x, y}, dx, dy }
  moving: new Map(),     // strokes being dragged (by anyone) and not saved yet: id -> { dx, dy, by }
  pan: null,             // panning by dragging: where it started
  zoom: 1,               // 1 = the board fits the panel's height
  // How the board is drawn: board units * scale + (x, y) = screen pixels.
  // base is the "100%" scale; scale = base * zoom.
  view: { base: 1, scale: 1, x: 0, y: 0, dpr: 1, width: 0, height: 0 },
};
let spaceHeld = false;    // Space + drag pans, whatever the tool
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
  if (board.open || !state.activeKey || !state.loggedIn) return;
  hideBanner();
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
  commitText(); // a label still being typed is saved before the board closes
  setExpanded(false);
  board.open = false;
  board.key = null;
  cancelMyStroke();
  panel.classList.add("hidden");
  app.classList.remove("with-panel");
  boardBtn.setAttribute("aria-pressed", "false");
  boardBtn.classList.remove("active");
  sendJSON({ type: "board_close" });
}

// Ask the server for the board of a conversation (it checks we're allowed in).
function requestBoard(key) {
  // Save a label still being typed to the board it was typed on, before
  // switching (messages arrive in order, so it lands on the old board).
  if (board.key && board.key !== key) commitText();
  else removeTextBox();
  cancelMyStroke();
  board.key = key;
  board.strokes.clear();
  board.live.clear();
  board.cursors.clear();
  board.erased.clear();
  board.moving.clear();
  board.selected = null;
  board.drag = null;
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
  hideBanner(); // the banner was about the conversation we just left
  if (board.open && key !== board.key) requestBoard(key);
}

// --- "<name> is drawing on the board" ---
// Live drawing only reaches people with the board open. When someone starts
// drawing and ours is closed, the server tells us, and a banner offers to open it.

const banner = document.getElementById("board-banner");
const bannerText = document.getElementById("board-banner-text");
const drawers = new Map(); // name -> when we last heard they were drawing
let bannerTimer = null;

export function showBoardActivity(msg) {
  if (board.open || msg.key !== state.activeKey) return; // already watching, or not on screen
  drawers.set(msg.name, Date.now());
  for (const [name, at] of drawers) if (Date.now() - at > 30000) drawers.delete(name);
  const names = [...drawers.keys()];
  bannerText.textContent = names.length === 1
    ? `${names[0]} is drawing on the board`
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are drawing on the board`;
  banner.classList.remove("hidden");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, 30000); // gone quiet: tidy it away
}

function hideBanner() {
  banner.classList.add("hidden");
  drawers.clear();
  clearTimeout(bannerTimer);
}

document.getElementById("board-banner-open").onclick = openBoard;
document.getElementById("board-banner-close").onclick = hideBanner;

// We logged back in after the connection dropped: open the board again.
export function boardReconnected() {
  if (board.open && state.activeKey) requestBoard(state.activeKey);
}

// --- Messages from the server ---

export function handleBoardMessage(msg) {
  if (!board.open || msg.key !== board.key) return; // for a board we've left
  switch (msg.type) {
    case "board_state": {
      clearTimeout(answerTimer); // the server answered
      board.strokes = new Map(msg.strokes.map(s => [s.id, s]));
      // A server started before the newest board changes (missing tools, the
      // old board size, or an older board version): say so, instead of
      // drawing alone silently or having drawings pushed back to the old edge.
      const known = new Set(msg.tools || []);
      const missing = ["pen", "text", ...SHAPES].filter(t => !known.has(t));
      const [w, h] = msg.size || [];
      if (missing.length || w !== W || h !== H || (msg.version || 0) < BOARD_VERSION) {
        setNote("The server is older than this page, so the board won't work properly. Restart the server.", true);
      } else {
        setNote(NOTE);
      }
      break;
    }

    case "board_viewers": {
      board.viewers = msg.viewers;
      // Forget the cursors, unfinished lines and half-done moves of people who left.
      const here = new Set(msg.viewers.map(v => v.id));
      for (const id of board.cursors.keys()) if (!here.has(id)) board.cursors.delete(id);
      for (const k of board.live.keys()) if (!here.has(k.split(":")[0])) board.live.delete(k);
      for (const [id, m] of board.moving) if (!here.has(m.by)) board.moving.delete(id);
      renderViewers();
      break;
    }

    case "board_draw": {
      // Someone else's line, a batch at a time.
      const k = msg.id + ":" + msg.sid;
      let s = board.live.get(k);
      if (!s) board.live.set(k, s = { tool: msg.tool, color: msg.color, text: msg.text, points: [] });
      // A shape arrives whole each time (it stretches as it's dragged), and a
      // label with its words so far; a pen line arrives a piece at a time.
      if (msg.replace) s.points = msg.points.slice();
      else s.points.push(...msg.points);
      if (msg.tool === "text") s.text = msg.text;
      break;
    }

    case "board_saved":
      // A finished line: swap the live copy (or my own) for the saved one.
      board.live.delete(msg.id + ":" + msg.sid);
      if (msg.stroke) board.strokes.set(msg.stroke.id, msg.stroke);
      break;

    case "board_removed":
      for (const id of msg.ids) {
        board.strokes.delete(id);
        board.moving.delete(id);
        if (board.selected === id) board.selected = null;
        if (board.drag && board.drag.id === id) board.drag = null;
      }
      break;

    case "board_moving":
      // Someone is dragging a stroke: show it where they have it now.
      if (!board.drag || board.drag.id !== msg.stroke) {
        board.moving.set(msg.stroke, { dx: msg.dx, dy: msg.dy, by: msg.id });
      }
      break;

    case "board_moved":
      // A stroke was dropped in its new place, and saved: swap the preview for it.
      if (board.drag && board.drag.id === msg.stroke_id && msg.id !== state.myId) break; // I'm dragging it now
      board.moving.delete(msg.stroke_id);
      if (msg.stroke) board.strokes.set(msg.stroke.id, msg.stroke); // same place in the drawing order
      break;

    case "board_cleared":
      board.strokes.clear();
      board.live.clear();
      board.moving.clear();
      board.selected = null;
      board.drag = null;
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

// The canvas fills the panel. "100%" fits the board to the panel's height:
// the board is wide, so in the side panel you pan sideways for the rest.
// Expanded, it fills nearly all of the space (centred if there's room to spare).
function resize() {
  const v = board.view;
  const first = v.width === 0;
  v.dpr = window.devicePixelRatio || 1;
  v.width = wrap.clientWidth;
  v.height = wrap.clientHeight;
  v.base = v.height / H;
  // Only a little too wide (up to 15%)? Fit the width instead: a slightly
  // smaller board beats panning sideways for almost nothing.
  if (W * v.base > v.width && W * v.base <= v.width * 1.15) v.base = v.width / W;
  board.zoom = Math.min(Math.max(board.zoom, minZoom()), ZOOM_MAX);
  v.scale = v.base * board.zoom;
  if (first) v.x = v.y = 0;
  clampView();
  canvas.style.width = v.width + "px";
  canvas.style.height = v.height + "px";
  canvas.width = Math.round(v.width * v.dpr);
  canvas.height = Math.round(v.height * v.dpr);
  updateZoomLabel();
  queueDraw();
}
new ResizeObserver(() => { if (board.open) resize(); }).observe(wrap);

// --- Zoom and pan (only on your screen) ---

// Zoomed out far enough to see the whole board, but never smaller than that.
function minZoom() {
  const v = board.view;
  return Math.min(1, Math.min(v.width / W, v.height / H) / v.base);
}

// Keep the board in view: no panning past its edges, and centred when it's
// smaller than the panel (like a scroll area, but our own).
function clampView() {
  const v = board.view;
  const bw = W * v.scale, bh = H * v.scale;
  v.x = bw <= v.width ? (v.width - bw) / 2 : Math.min(0, Math.max(v.width - bw, v.x));
  v.y = bh <= v.height ? (v.height - bh) / 2 : Math.min(0, Math.max(v.height - bh, v.y));
}

// Zoom so the board point under (sx, sy) stays under it: zooming "toward the mouse".
function zoomAt(zoom, sx = board.view.width / 2, sy = board.view.height / 2) {
  const v = board.view;
  zoom = Math.min(Math.max(zoom, minZoom()), ZOOM_MAX);
  if (zoom === board.zoom) return;
  commitText(); // the text box sits at a fixed spot on screen: finish the label first
  const bx = (sx - v.x) / v.scale, by = (sy - v.y) / v.scale;
  board.zoom = zoom;
  v.scale = v.base * zoom;
  v.x = sx - bx * v.scale;
  v.y = sy - by * v.scale;
  clampView();
  updateZoomLabel();
  queueDraw();
}

function panBy(dx, dy) {
  const v = board.view;
  v.x += dx;
  v.y += dy;
  clampView();
  queueDraw();
}

const zoomLabel = document.getElementById("zoom-reset");
function updateZoomLabel() {
  zoomLabel.textContent = Math.round(board.zoom * 100) + "%";
}

document.getElementById("zoom-in").onclick = () => zoomAt(board.zoom * ZOOM_STEP);
document.getElementById("zoom-out").onclick = () => zoomAt(board.zoom / ZOOM_STEP);
zoomLabel.onclick = () => {
  // Back to 100%, at the left edge.
  commitText();
  board.zoom = 1;
  board.view.scale = board.view.base;
  board.view.x = board.view.y = 0;
  clampView();
  updateZoomLabel();
  queueDraw();
};

// The mouse wheel or touchpad: Ctrl + wheel (or a pinch, which the browser
// sends as Ctrl + wheel) zooms; otherwise it pans.
wrap.addEventListener("wheel", (e) => {
  if (!board.open) return;
  e.preventDefault(); // don't scroll the page
  const lines = e.deltaMode === 1 ? 16 : 1; // some mice count lines, not pixels
  if (e.ctrlKey || e.metaKey) {
    const rect = canvas.getBoundingClientRect();
    zoomAt(board.zoom * Math.exp(-e.deltaY * lines * 0.002), e.clientX - rect.left, e.clientY - rect.top);
    return;
  }
  let dx = e.deltaX * lines, dy = e.deltaY * lines;
  // An ordinary wheel only goes up and down. If the board can't move up and
  // down (it fits the height), let it move sideways instead. Shift does that too.
  if (!dx && (e.shiftKey || H * board.view.scale <= board.view.height)) [dx, dy] = [dy, 0];
  panBy(-dx, -dy);
}, { passive: false });

function startPan(e) {
  commitText();
  board.pan = { x: e.clientX, y: e.clientY, vx: board.view.x, vy: board.view.y };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("panning");
}

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
  for (const s of board.strokes.values()) {
    if (s.id === board.hiddenId) continue;
    const m = board.moving.get(s.id);
    if (!m) { drawStroke(ctx, s); continue; }
    // Being dragged: draw it shifted, without changing the saved points.
    ctx.save();
    ctx.translate(m.dx, m.dy);
    drawStroke(ctx, s);
    ctx.restore();
  }
  for (const s of board.live.values()) drawStroke(ctx, s);
  if (board.mine) drawStroke(ctx, board.mine);
  drawSelection();
  ctx.restore();
  drawCursors();
}

// A dashed box around the selected stroke (in board units, drawn the same
// thickness on screen whatever the zoom).
function drawSelection() {
  const s = board.selected !== null && board.strokes.get(board.selected);
  if (!s) return;
  const m = board.moving.get(s.id) || { dx: 0, dy: 0 };
  const b = bounds(s);
  const pad = 10;
  ctx.save();
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 1.5 / board.view.scale;
  ctx.setLineDash([6 / board.view.scale, 4 / board.view.scale]);
  ctx.strokeRect(b.x0 + m.dx - pad, b.y0 + m.dy - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad);
  ctx.restore();
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

// One stroke, in board units. Also used for snapshot pictures in the chat,
// which draw lines thicker (`thicker`) so they stay clear when shrunk.
function drawStroke(c, s, thicker = 1) {
  const p = s.points;
  c.strokeStyle = c.fillStyle = COLORS[s.color] || COLORS.black;
  c.lineWidth = LINE_WIDTH * thicker;
  c.lineCap = c.lineJoin = "round";
  if (s.tool === "text") {
    if (p.length < 2 || !s.text) return;
    c.font = `600 ${TEXT_SIZE}px system-ui, "Segoe UI", sans-serif`;
    c.textBaseline = "middle";
    c.fillText(s.text, p[0], p[1]);
  } else if (SHAPES.has(s.tool)) {
    if (p.length < 4) return;
    drawShape(c, s.tool, p[0], p[1], p[p.length - 2], p[p.length - 1]);
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

// A shape between two points (ax, ay) and (bx, by). Lines and arrows go from
// one to the other; every other shape fills the box with those two corners.
function drawShape(c, tool, ax, ay, bx, by) {
  const x = Math.min(ax, bx), y = Math.min(ay, by);
  const w = Math.abs(bx - ax), h = Math.abs(by - ay);
  const cx = x + w / 2, cy = y + h / 2;
  const at = (u, v) => [x + u * w, y + v * h]; // a spot in the box, 0..1 across and down
  c.beginPath();
  switch (tool) {
    case "line":
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      break;
    case "arrow": {
      const angle = Math.atan2(by - ay, bx - ax);
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      for (const side of [-1, 1]) {  // the two sides of the arrow head
        c.moveTo(bx, by);
        c.lineTo(bx - 26 * Math.cos(angle + side * 0.45), by - 26 * Math.sin(angle + side * 0.45));
      }
      break;
    }
    case "rect":
      c.roundRect(x, y, w, h, Math.min(10, w / 4, h / 4));
      break;
    case "ellipse":
      c.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "diamond":
      c.moveTo(cx, y); c.lineTo(x + w, cy); c.lineTo(cx, y + h); c.lineTo(x, cy);
      c.closePath();
      break;
    case "triangle":
      c.moveTo(cx, y); c.lineTo(x + w, y + h); c.lineTo(x, y + h);
      c.closePath();
      break;
    case "cloud":
      // Four bumps on top and a flat bottom: the usual "internet" cloud.
      c.moveTo(...at(0.25, 0.9));
      c.bezierCurveTo(...at(0.06, 0.9), ...at(0, 0.62), ...at(0.17, 0.54));
      c.bezierCurveTo(...at(0.1, 0.28), ...at(0.36, 0.16), ...at(0.48, 0.3));
      c.bezierCurveTo(...at(0.56, 0.06), ...at(0.88, 0.1), ...at(0.85, 0.4));
      c.bezierCurveTo(...at(1.02, 0.45), ...at(1, 0.9), ...at(0.78, 0.9));
      c.closePath();
      break;
    case "cylinder": {
      // A database or server: an oval top, straight sides, a curved bottom.
      const ry = Math.min(h * 0.15, w * 0.3);
      c.ellipse(cx, y + ry, w / 2, ry, 0, 0, Math.PI * 2);
      c.moveTo(x, y + ry);
      c.lineTo(x, y + h - ry);
      c.ellipse(cx, y + h - ry, w / 2, ry, 0, Math.PI, 0, true);
      c.lineTo(x + w, y + ry);
      break;
    }
  }
  c.stroke();
}

// Holding Shift: shapes become perfect squares or circles, and lines snap to
// every 45 degrees. Returns the (possibly adjusted) end point.
function constrain(x0, y0, p, shift, tool) {
  if (!shift) return [p.x, p.y];
  const dx = p.x - x0, dy = p.y - y0;
  let x, y;
  if (tool === "line" || tool === "arrow") {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const length = Math.hypot(dx, dy);
    x = x0 + Math.cos(angle) * length;
    y = y0 + Math.sin(angle) * length;
  } else {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    x = x0 + Math.sign(dx || 1) * size;
    y = y0 + Math.sign(dy || 1) * size;
  }
  return [Math.round(Math.min(Math.max(x, 0), W)), Math.round(Math.min(Math.max(y, 0), H))];
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
  return { x: Math.round(Math.min(Math.max(x, 0), W)), y: Math.round(Math.min(Math.max(y, 0), H)),
           rx: x, ry: y, inside: x >= 0 && x <= W && y >= 0 && y <= H };
}

canvas.addEventListener("pointerdown", (e) => {
  if (!board.open || !state.loggedIn) return;
  const p = toBoard(e);
  // Space + drag, or the middle mouse button: move around, whatever the tool.
  if (e.button === 1 || spaceHeld) { e.preventDefault(); startPan(e); return; }
  if (e.button !== 0) return;
  if (board.tool === "select") { e.preventDefault(); startSelect(e, p); return; }
  if (!p.inside) return;
  e.preventDefault();
  // Clicking the board while a label is being typed keeps that label. (The
  // preventDefault above stops the text box losing focus by itself.)
  commitText();
  if (board.tool === "text") {
    // On an existing label: edit it, in its own place. Elsewhere: a new label.
    const label = textLabelAt(p);
    showTextBox(label ? { x: label.points[0], y: label.points[1] } : p, label);
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  if (board.tool === "eraser") { eraseAt(p); return; }

  const shape = SHAPES.has(board.tool);
  // A shape starts as two points in the same spot; dragging moves the second.
  board.mine = { sid: Date.now().toString(36) + (strokeCount++), tool: board.tool, color: board.color,
                 points: shape ? [p.x, p.y, p.x, p.y] : [p.x, p.y] };
  board.pending = shape ? [] : [p.x, p.y];
  board.changed = false;
  sendTimer = setInterval(() => sendBatch(false), SEND_EVERY);
  queueDraw();
});

canvas.addEventListener("pointermove", (e) => {
  if (!board.open) return;
  if (board.pan) {
    const v = board.view;
    v.x = board.pan.vx + e.clientX - board.pan.x;
    v.y = board.pan.vy + e.clientY - board.pan.y;
    clampView();
    queueDraw();
    return;
  }
  const p = toBoard(e);
  sendCursor(p);
  if (board.tool === "select") { dragSelected(p); return; }
  if (board.tool === "eraser" && e.buttons) { eraseAt(p); return; }
  const m = board.mine;
  if (!m) return;
  if (SHAPES.has(m.tool)) {
    const [x, y] = constrain(m.points[0], m.points[1], p, e.shiftKey, m.tool);
    m.points = [m.points[0], m.points[1], x, y]; // just the two points
    board.changed = true;
  } else {
    // Skip points too close to the last one: the line looks the same, with fewer messages.
    const lx = m.points[m.points.length - 2], ly = m.points[m.points.length - 1];
    if (Math.hypot(p.x - lx, p.y - ly) < 3) return;
    m.points.push(p.x, p.y);
    board.pending.push(p.x, p.y);
  }
  queueDraw();
});

canvas.addEventListener("pointerup", pointerDone);
canvas.addEventListener("pointercancel", pointerDone);

function pointerDone() {
  if (board.pan) {
    board.pan = null;
    canvas.classList.remove("panning");
    return;
  }
  if (board.drag) { dropSelected(); return; }
  finishMyStroke();
}

function finishMyStroke() {
  const m = board.mine;
  if (!m) return;
  clearInterval(sendTimer);
  const [x0, y0, x1, y1] = m.points;
  if (SHAPES.has(m.tool) && Math.hypot(x1 - x0, y1 - y0) < 4) {
    // A click, not a shape. Others may already see a tiny live shape, so tell
    // the server it's finished but empty: it saves nothing and everyone drops it.
    m.points = [x0, y0, x0, y0];
    sendBatch(true);
    board.mine = null;
    queueDraw();
    return;
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
// A shape is sent whole each time, and only if it changed.
function sendBatch(done) {
  const m = board.mine;
  if (!m) return;
  if (SHAPES.has(m.tool)) {
    if (!done && !board.changed) return;
    sendJSON({ type: "board_draw", sid: m.sid, tool: m.tool, color: m.color, points: m.points, done });
    board.changed = false;
    return;
  }
  if (!done && board.pending.length === 0) return;
  sendJSON({ type: "board_draw", sid: m.sid, tool: m.tool, color: m.color, points: board.pending, done });
  board.pending = [];
}

function sendCursor(p) {
  const now = Date.now();
  if (!p.inside || now - lastCursorSent < CURSOR_EVERY) return;
  lastCursorSent = now;
  sendJSON({ type: "board_cursor", x: p.x, y: p.y });
}

// --- Select and move ---
// Click a stroke with the Select tool to pick it, then drag it. Others watch it
// move (about 20 updates a second); it's saved in its new place when you let
// go. Delete removes it, Escape lets go of it. Clicking empty space pans.

let moveTimer = null;

// Is this stroke under the point? Lines by their edge; boxes, ovals and the
// other closed shapes anywhere inside too, so a big shape is easy to grab.
function strokeAt(p) {
  for (const s of [...board.strokes.values()].reverse()) {
    if (touches(s, p)) return s;
    if (SHAPES.has(s.tool) && s.tool !== "line" && s.tool !== "arrow") {
      const b = bounds(s);
      if (p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) return s;
    }
  }
  return null;
}

// The box a stroke fills, in board units.
function bounds(s) {
  const pts = s.points;
  if (s.tool === "text") {
    const width = (s.text || "").length * TEXT_SIZE * 0.58;
    return { x0: pts[0], y0: pts[1] - TEXT_SIZE * 0.6, x1: pts[0] + width, y1: pts[1] + TEXT_SIZE * 0.6 };
  }
  const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function select(id) {
  board.selected = id;
  queueDraw();
}

function startSelect(e, p) {
  commitText();
  const hit = p.inside ? strokeAt(p) : null;
  if (!hit) {
    select(null);
    startPan(e); // empty space: move around instead
    return;
  }
  select(hit.id);
  canvas.setPointerCapture(e.pointerId);
  board.drag = { id: hit.id, from: { x: p.rx, y: p.ry }, dx: 0, dy: 0, sent: { dx: 0, dy: 0 } };
  clearInterval(moveTimer);
  moveTimer = setInterval(sendMove, SEND_EVERY);
}

function dragSelected(p) {
  const d = board.drag;
  if (!d) {
    // Not dragging: show a "move" pointer over things that can be picked.
    canvas.classList.toggle("over-stroke", p.inside && strokeAt(p) !== null);
    return;
  }
  const s = board.strokes.get(d.id);
  if (!s) return;
  // Keep the whole stroke on the board (the server checks this again).
  const b = bounds(s);
  d.dx = Math.round(Math.min(Math.max(p.rx - d.from.x, -b.x0), W - b.x1));
  d.dy = Math.round(Math.min(Math.max(p.ry - d.from.y, -b.y0), H - b.y1));
  board.moving.set(d.id, { dx: d.dx, dy: d.dy, by: state.myId });
  queueDraw();
}

// Send where it is now, if it moved since the last time.
function sendMove(done = false) {
  const d = board.drag;
  if (!d || (!done && d.dx === d.sent.dx && d.dy === d.sent.dy)) return;
  sendJSON({ type: "board_move", stroke: d.id, dx: d.dx, dy: d.dy, done });
  d.sent = { dx: d.dx, dy: d.dy };
}

function dropSelected() {
  clearInterval(moveTimer);
  const d = board.drag;
  if (d.dx || d.dy) {
    sendMove(true); // saved by the server; it stays shown here until the saved copy comes back
  } else {
    board.moving.delete(d.id); // just a click: nothing moved
    if (d.sent.dx || d.sent.dy) sendJSON({ type: "board_move", stroke: d.id, dx: 0, dy: 0, done: true });
  }
  board.drag = null;
  queueDraw();
}

// Delete / Backspace removes the selected stroke; Escape lets go of it. Space
// held down lets you drag the board around with any tool.
document.addEventListener("keydown", (e) => {
  if (!board.open) return;
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target.isContentEditable;
  if (typing) return;
  if (e.key === " " && !spaceHeld && (e.target === document.body || e.target === canvas)) {
    e.preventDefault(); // don't scroll the page
    spaceHeld = true;
    canvas.classList.add("can-pan");
  }
  if (board.selected === null || board.drag) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    sendJSON({ type: "board_erase", stroke: board.selected });
    select(null);
  } else if (e.key === "Escape") {
    select(null);
  }
});
document.addEventListener("keyup", (e) => {
  if (e.key === " ") {
    spaceHeld = false;
    canvas.classList.remove("can-pan");
  }
});

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
  const line = SHAPES.has(s.tool) ? outline(s.tool, pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]) : pts;
  if (line.length === 2) return Math.hypot(p.x - line[0], p.y - line[1]) <= ERASE_DISTANCE;
  for (let i = 0; i + 3 < line.length; i += 2) {
    if (distanceToSegment(p, line[i], line[i + 1], line[i + 2], line[i + 3]) <= ERASE_DISTANCE) return true;
  }
  return false;
}

// A shape's edge as a list of points, so the eraser can tell when it touches
// the edge. (Rubbing inside a big box doesn't erase it, only its edge does.)
function outline(tool, ax, ay, bx, by) {
  const x = Math.min(ax, bx), y = Math.min(ay, by);
  const w = Math.abs(bx - ax), h = Math.abs(by - ay);
  const cx = x + w / 2, cy = y + h / 2;
  switch (tool) {
    case "line":
    case "arrow":
      return [ax, ay, bx, by];
    case "diamond":
      return [cx, y, x + w, cy, cx, y + h, x, cy, cx, y];
    case "triangle":
      return [cx, y, x + w, y + h, x, y + h, cx, y];
    case "ellipse":
    case "cloud": {
      // Near enough for a cloud too: points around an oval.
      const points = [];
      for (let i = 0; i <= 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        points.push(cx + (w / 2) * Math.cos(a), cy + (h / 2) * Math.sin(a));
      }
      return points;
    }
    default: // rect, cylinder
      return [x, y, x + w, y, x + w, y + h, x, y + h, x, y];
  }
}

function distanceToSegment(p, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.y - y1) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
}

// --- Text labels ---

// A label is sent while it's typed (about 10 times a second), so others watch
// the words appear. Editing a label works the same way: on the first change
// the old label is erased and the new words are sent live in its place.
const TEXT_EVERY = 100;   // ms between live updates while typing

let textBox = null;
let text = null;          // the label being typed: { sid, point, color, original, sent, erased }
let textTimer = null;

// The newest text label under the pointer, if any (clicking one edits it).
function textLabelAt(p) {
  return [...board.strokes.values()].reverse().find(s => s.tool === "text" && touches(s, p));
}

// Open a text box: empty for a new label, or filled with an existing label's
// words to edit it. The label itself is hidden meanwhile, so the box sits in its place.
function showTextBox(p, label = null) {
  commitText(); // a label still being typed is kept, not thrown away
  text = { sid: Date.now().toString(36) + (strokeCount++), point: p,
           color: label ? label.color : board.color, original: label, sent: false, erased: false };
  board.hiddenId = label ? label.id : null;
  queueDraw();
  const v = board.view;
  const size = Math.max(13, TEXT_SIZE * v.scale); // the same size as the label on the board
  textBox = document.createElement("input");
  textBox.className = "board-text";
  textBox.maxLength = 80;
  textBox.placeholder = "Type, then Enter";
  textBox.value = label ? label.text : "";
  textBox.style.fontSize = size + "px";
  textBox.style.left = v.x + p.x * v.scale - 7 + "px";
  textBox.style.top = v.y + p.y * v.scale - size / 2 - 5 + "px";
  textBox.style.color = COLORS[text.color];
  textBox.addEventListener("input", textChanged);
  textBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitText();
    else if (e.key === "Escape") removeTextBox(); // puts things back as they were
  });
  // Clicking elsewhere on the page finishes the label. Switching to another
  // window or tab doesn't: the label stays open, and focus comes back to it.
  const box = textBox;
  textBox.addEventListener("blur", () => setTimeout(() => {
    if (textBox === box && document.hasFocus() && document.activeElement !== box) commitText();
  }, 0));
  wrap.appendChild(textBox);
  textBox.focus();
  textBox.setSelectionRange(textBox.value.length, textBox.value.length); // cursor at the end
}

// Send label t's words as they are now. `done` saves it (empty words: nothing is saved).
function sendText(t, words, done) {
  clearTimeout(textTimer);
  textTimer = null;
  sendJSON({ type: "board_draw", sid: t.sid, tool: "text", color: t.color, text: words,
             points: [t.point.x, t.point.y], done });
  t.sent = true;
}

// Editing an existing label: the first change erases the old one, so others
// see the new words being typed in its place instead of on top of it.
function eraseOriginal(t) {
  if (t.original && !t.erased) {
    sendJSON({ type: "board_erase", stroke: t.original.id });
    t.erased = true;
  }
}

function textChanged() {
  const t = text;
  if (!t) return;
  if (!t.sent && !t.original && !textBox.value.trim()) return; // nothing typed yet
  eraseOriginal(t);
  // Send at most every TEXT_EVERY ms, always ending with the latest words.
  if (!textTimer) textTimer = setTimeout(() => { if (text === t && textBox) sendText(t, textBox.value, false); }, TEXT_EVERY);
}

// Finish the label (Enter, a click elsewhere, closing the board...).
function commitText() {
  if (!textBox) return;
  const t = text;
  const words = textBox.value.trim();
  closeTextBox();
  if (t.original && !t.erased && words === t.original.text) return; // opened, but nothing changed
  eraseOriginal(t);                                                  // editing: the old one goes
  if (!t.sent && !t.erased && !words) return;                        // never typed anything
  sendText(t, words, true);                                          // empty words: nothing saved
  if (words) {
    // Keep showing it until the server sends back the saved copy.
    board.live.set(state.myId + ":" + t.sid, { tool: "text", color: t.color, text: words, points: [t.point.x, t.point.y] });
    queueDraw();
  }
}

// Escape (or switching away): put things back as they were.
function removeTextBox() {
  if (!textBox) return;
  const t = text;
  closeTextBox();
  if (t.original && t.erased) sendText(t, t.original.text, true); // restore the label as it was
  else if (!t.original && t.sent) sendText(t, "", true);         // tell others to drop the half-typed label
}

function closeTextBox() {
  const box = textBox;
  textBox = null;   // first, so the blur from remove() doesn't commit it again
  clearTimeout(textTimer);
  textTimer = null;
  text = null;
  board.hiddenId = null;  // show the label again (if it was being edited)
  box?.remove();
  queueDraw();
}

// --- The toolbar ---

// Pick a tool: pen, text, eraser, or a shape (which lights up the Shapes button).
function selectTool(tool) {
  if (tool !== "select") select(null);
  if (tool === "select" && board.tool !== "select") {
    setNote("Drag something to move it. Delete removes it. Drag empty space to look around.");
  }
  canvas.classList.remove("over-stroke");
  board.tool = tool;
  for (const b of panel.querySelectorAll("[data-tool]")) {
    const on = b.dataset.tool === tool || (b.dataset.tool === "shape" && SHAPES.has(tool));
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  canvas.dataset.tool = SHAPES.has(tool) ? "shape" : tool; // the CSS picks a matching mouse pointer
}

for (const btn of panel.querySelectorAll('[data-tool]:not([data-tool="shape"])')) {
  btn.onclick = () => selectTool(btn.dataset.tool);
}

// The Shapes menu. The button shows the last shape picked.
const shapeBtn = document.getElementById("shape-btn");
const shapeMenu = document.getElementById("shape-menu");
const shapeBtnIcon = document.getElementById("shape-btn-icon");

function setShapeMenu(open) {
  shapeMenu.classList.toggle("hidden", !open);
  shapeBtn.setAttribute("aria-expanded", String(open));
  if (open) shapeMenu.querySelector(`[data-shape="${board.shape}"]`)?.focus();
}

shapeBtn.onclick = (e) => {
  e.stopPropagation();
  setShapeMenu(shapeMenu.classList.contains("hidden"));
};

for (const item of shapeMenu.querySelectorAll("[data-shape]")) {
  item.onclick = () => {
    board.shape = item.dataset.shape;
    shapeBtnIcon.replaceChildren(item.querySelector("svg").cloneNode(true));
    const label = "Shapes: " + item.textContent.trim();
    shapeBtn.title = label;
    shapeBtn.setAttribute("aria-label", label);
    for (const other of shapeMenu.querySelectorAll("[data-shape]")) other.classList.toggle("current", other === item);
    selectTool(board.shape);
    setShapeMenu(false);
  };
}
shapeMenu.querySelector(`[data-shape="${board.shape}"]`).classList.add("current");

// Up and down arrows move through the menu; a click outside or Escape closes it.
shapeMenu.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...shapeMenu.querySelectorAll("[data-shape]")];
  const i = items.indexOf(document.activeElement);
  items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
});
document.addEventListener("click", (e) => {
  if (!shapeMenu.contains(e.target)) setShapeMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !shapeMenu.classList.contains("hidden")) {
    setShapeMenu(false);
    shapeBtn.focus();
  }
});
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

// --- Making the board bigger ---

// Expand: the board takes the main space and the chat docks to the side
// (Option B in the layout design). The drawing itself doesn't change: it's
// the same board, just drawn larger, so everyone still sees the same thing.
const expandBtn = document.getElementById("board-expand");

function setExpanded(on) {
  app.classList.toggle("board-expanded", on);
  expandBtn.setAttribute("aria-pressed", String(on));
  const label = on ? "Back to the side panel" : "Expand the board";
  expandBtn.setAttribute("aria-label", label);
  expandBtn.title = label;
}
expandBtn.onclick = () => setExpanded(!app.classList.contains("board-expanded"));

// Resize: drag the panel's left edge. The width is remembered in this browser.
const MIN_WIDTH = 340;
const DEFAULT_WIDTH = 460;
const resizer = document.getElementById("panel-resize");

function maxWidth() {
  return Math.max(MIN_WIDTH, Math.min(1000, window.innerWidth - 560)); // leave room for the chat
}

function setPanelWidth(width, save = true) {
  const w = Math.round(Math.min(Math.max(width, MIN_WIDTH), maxWidth()));
  app.style.setProperty("--panel-w", w + "px");
  resizer.setAttribute("aria-valuenow", String(w));
  resizer.setAttribute("aria-valuemin", String(MIN_WIDTH));
  resizer.setAttribute("aria-valuemax", String(maxWidth()));
  if (save) localStorage.setItem("boardWidth", String(w));
}
setPanelWidth(Number(localStorage.getItem("boardWidth")) || DEFAULT_WIDTH, false);

resizer.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startWidth = panel.getBoundingClientRect().width;
  app.classList.add("resizing");
  const move = (ev) => setPanelWidth(startWidth + (startX - ev.clientX)); // dragging left makes it wider
  const stop = () => {
    app.classList.remove("resizing");
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", stop);
    resizer.removeEventListener("pointercancel", stop);
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", stop);
  resizer.addEventListener("pointercancel", stop);
});
// Arrow keys resize too; double-click goes back to the normal width.
resizer.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 80 : 20;
  const now = panel.getBoundingClientRect().width;
  if (e.key === "ArrowLeft") setPanelWidth(now + step);
  else if (e.key === "ArrowRight") setPanelWidth(now - step);
  else return;
  e.preventDefault();
});
resizer.addEventListener("dblclick", () => setPanelWidth(DEFAULT_WIDTH));
window.addEventListener("resize", () => {
  const now = Number(localStorage.getItem("boardWidth")) || DEFAULT_WIDTH;
  setPanelWidth(now, false); // keep it within the window as it changes size
});

// --- Snapshots in the chat ---

// A picture of the board, as it was when someone posted it.
export function buildSnapshotCard(snapshot) {
  const card = document.createElement("div");
  card.className = "snapshot";

  const title = document.createElement("div");
  title.className = "poll-question";
  title.textContent = "Board snapshot";
  card.appendChild(title);

  const width = 300; // the whole wide board, small
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
  for (const s of snapshot ? snapshot.strokes : []) drawStroke(c, s, 2.5);
  card.appendChild(picture);

  const open = document.createElement("button");
  open.className = "poll-close";
  open.textContent = "Open the board";
  open.onclick = openBoard;
  card.appendChild(open);
  return card;
}
