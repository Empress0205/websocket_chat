// The message box and Send button at the bottom of the chat.

import { state } from "./state.js";
import { sendJSON } from "./connection.js";

const sendBtn = document.getElementById("send");
const textInput = document.getElementById("text");

// Send is only allowed while connected and logged in (see connection.js).
export function setSendEnabled(enabled) {
  sendBtn.disabled = !enabled;
}

export function focusInput() {
  textInput.focus();
}

// Send a message to whatever conversation is open.
function send() {
  const text = textInput.value.trim();
  if (!text || !state.activeKey || !state.loggedIn) return;
  if (state.activeKey.startsWith("dm:")) {
    sendJSON({ type: "dm", to: state.activeKey.slice(3), text });
  } else if (state.activeKey === "room:" + state.currentRoom) {
    sendJSON({ type: "chat", text });
  }
  textInput.value = "";
  textInput.focus();
}

sendBtn.onclick = send;
textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
