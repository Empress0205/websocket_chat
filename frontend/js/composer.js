// The message box and Send button at the bottom of the chat.

import { state } from "./state.js";
import { sendJSON } from "./connection.js";
import { addInfo } from "./conversations.js";
import { isPollCommand, parsePollCommand, createPoll, openPollDialog } from "./polls.js";

const sendBtn = document.getElementById("send");
const pollBtn = document.getElementById("poll-btn");
const textInput = document.getElementById("text");

// Send is only allowed while connected and logged in (see connection.js).
export function setSendEnabled(enabled) {
  sendBtn.disabled = !enabled;
  pollBtn.disabled = !enabled;
}

export function focusInput() {
  textInput.focus();
}

// Send a message to whatever conversation is open.
function send() {
  const text = textInput.value.trim();
  if (!text || !state.activeKey || !state.loggedIn) return;
  const inDm = state.activeKey.startsWith("dm:");
  const inRoom = state.activeKey === "room:" + state.currentRoom;
  if (!inDm && !inRoom) return;

  if (isPollCommand(text)) {
    // A shortcut for people who know it: /poll Question? | Option 1 | Option 2
    const poll = parsePollCommand(text);
    if (poll.error) {
      addInfo(state.activeKey, poll.error, true); // keep the text, so it can be fixed
      return;
    }
    createPoll(poll.question, poll.options);
  } else if (inDm) {
    sendJSON({ type: "dm", to: state.activeKey.slice(3), text });
  } else {
    sendJSON({ type: "chat", text });
  }
  textInput.value = "";
  textInput.focus();
}

sendBtn.onclick = send;
pollBtn.onclick = openPollDialog; // the "New poll" form (polls.js)
textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
