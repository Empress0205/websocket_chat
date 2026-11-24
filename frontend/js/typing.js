// The "Alex is typing…" indicator.

import { state } from "./state.js";
import { sendJSON } from "./connection.js";

const typingDiv = document.getElementById("typing");
const textInput = document.getElementById("text");

// --- Receiving side ---
// id -> { name, key, timer }. Each person's "typing" disappears 2s after their
// last keystroke, and only shows in the conversation they're typing in.
const typers = new Map();

export function renderTyping() {
  const names = [...typers.values()].filter(t => t.key === state.activeKey).map(t => t.name);
  typingDiv.textContent = "";
  if (names.length === 0) return;

  const dots = document.createElement("span");
  dots.className = "dots";
  dots.innerHTML = "<span></span><span></span><span></span>";
  typingDiv.appendChild(dots);

  const label = document.createElement("span");
  label.textContent = names.length === 1
    ? `${names[0]} is typing…`
    : `${names.join(", ")} are typing…`;
  typingDiv.appendChild(label);
}

export function showTyping(id, name, key) {
  const old = typers.get(id);
  if (old) clearTimeout(old.timer);
  typers.set(id, { name, key, timer: setTimeout(() => clearTyping(id), 2000) });
  renderTyping();
}

export function clearTyping(id) {
  const t = typers.get(id);
  if (!t) return;
  clearTimeout(t.timer);
  typers.delete(id);
  renderTyping();
}

// --- Sending side ---
// Sending on every keystroke would flood the server, so send at most once per second.
let lastTypingSent = 0;
textInput.addEventListener("input", () => {
  const now = Date.now();
  if (now - lastTypingSent < 1000 || !state.activeKey) return;
  lastTypingSent = now;
  sendJSON(state.activeKey.startsWith("dm:")
    ? { type: "typing", to: state.activeKey.slice(3) }
    : { type: "typing" });
});
