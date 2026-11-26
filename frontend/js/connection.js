// The WebSocket connection: opening it, sending, and staying connected
// (reconnecting by itself and noticing dead connections, Phase 5).

import { state } from "./state.js";
import { handleMessage } from "./handlers.js";
import { showLogin } from "./login.js";
import { setSendEnabled } from "./composer.js";
import { voiceDisconnected } from "./voice.js";

// Note "ws://" instead of "http://".
const SERVER_URL = "ws://localhost:8765";
const HEARTBEAT_EVERY = 25000; // ms between our pings
const PONG_WAIT = 10000;       // ms to wait for the pong before calling it dead

const statusText = document.getElementById("status");
const dot = document.getElementById("dot");

let socket = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let countdownTimer = null;
let heartbeatTimer = null;
let pongTimer = null;

export function sendJSON(obj) {
  if (isOpen()) socket.send(JSON.stringify(obj));
}

export function isOpen() {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

function setStatus(text, dotClass) {
  statusText.textContent = text;
  dot.className = "dot " + dotClass;
}

export function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(countdownTimer);
  reconnectTimer = null;
  setStatus("Connecting…", "wait");
  socket = new WebSocket(SERVER_URL);
  socket.onopen = onOpen;
  socket.onmessage = onMessage;
  socket.onclose = onClose;
}

// Runs when a connection is ready: log back in, or show the login screen.
function onOpen() {
  setStatus("Connected", "on");
  startHeartbeat();
  const token = sessionStorage.getItem("chatToken");
  if (token) {
    sendJSON({ type: "resume", token });
  } else {
    showLogin();
  }
}

// Runs every time the server sends us something, at any moment.
function onMessage(event) {
  const msg = JSON.parse(event.data);
  if (msg.type === "pong") {
    clearTimeout(pongTimer); // still alive
    return;
  }
  if (msg.type === "auth_ok") reconnectAttempt = 0; // back to short waits next time
  handleMessage(msg); // everything else: see handlers.js
}

// Runs if the connection closes (for example, the server stopped).
function onClose() {
  stopHeartbeat();
  state.loggedIn = false;
  voiceDisconnected(); // the server has taken us out of any huddle: hang up here too
  setSendEnabled(false); // nothing can be sent until we're back
  if (state.signedOutText) {
    // We were signed out on purpose: don't reconnect, say so on the login screen.
    setStatus("Disconnected", "off");
    showLogin(state.signedOutText + " Reload the page to log in again.");
    return;
  }
  scheduleReconnect();
}

// Wait longer after each failed try: about 1s, 2s, 4s, 8s, 16s, then 30s.
// The random +-20% ("jitter") stops everyone reconnecting at the same moment
// after a server restart.
function scheduleReconnect() {
  const seconds = Math.min(30, 2 ** reconnectAttempt) * (0.8 + Math.random() * 0.4);
  reconnectAttempt++;
  let left = Math.ceil(seconds);
  setStatus(`Reconnecting in ${left}s…`, "wait");
  countdownTimer = setInterval(() => {
    left--;
    if (left > 0) statusText.textContent = `Reconnecting in ${left}s…`;
  }, 1000);
  reconnectTimer = setTimeout(connect, seconds * 1000);
}

// The network came back (e.g. wifi reconnected): don't wait, try now.
window.addEventListener("online", () => { if (reconnectTimer) connect(); });

// Our own heartbeat. A connection can die silently (laptop asleep, wifi
// switched) and still look open. If a ping gets no pong, it's dead.
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    sendJSON({ type: "ping" });
    clearTimeout(pongTimer);
    pongTimer = setTimeout(connectionLost, PONG_WAIT);
  }, HEARTBEAT_EVERY);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  clearTimeout(pongTimer);
}

function connectionLost() {
  // Give up on this socket without waiting for it to close politely.
  const dead = socket;
  dead.onclose = null;
  dead.onmessage = null;
  dead.close();
  onClose();
}
