// Polls: the poll card in a conversation, voting, and the /poll command.
//
// The page never counts votes itself. Clicking an option only tells the
// server "I vote for option 2"; the server checks it, saves it, and sends
// everyone the new totals (a "poll_update"), which redraws the card.

import { state } from "./state.js";
import { sendJSON } from "./connection.js";

const MAX_OPTIONS = 10; // the server checks this too

// "/poll Lunch? | Pizza | Pilau" -> { question: "Lunch?", options: ["Pizza", "Pilau"] }
// Returns { error } if it can't be a poll, so the page can explain how to write one.
export function parsePollCommand(text) {
  const parts = text.replace(/^\/poll\b/i, "").split("|").map(s => s.trim()).filter(Boolean);
  if (parts.length < 3) {
    return { error: "To make a poll, write: /poll Question? | Option 1 | Option 2" };
  }
  if (parts.length - 1 > MAX_OPTIONS) {
    return { error: `A poll can have at most ${MAX_OPTIONS} options.` };
  }
  return { question: parts[0], options: parts.slice(1) };
}

export function isPollCommand(text) {
  return /^\/poll(\s|$)/i.test(text);
}

// A small bar-chart icon, drawn with SVG so it matches the text colour
// (the same idea as the padlock in sidebar.js).
function pollIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "poll-icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3 13.5V9M8 13.5V3M13 13.5V6.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  svg.appendChild(path);
  return svg;
}

// Build the card for one poll. Called again with fresh data after every vote.
export function buildPollCard(poll) {
  const card = document.createElement("div");
  card.className = "poll" + (poll.closed ? " closed" : "");
  card.dataset.pollId = poll.id;

  const question = document.createElement("div");
  question.className = "poll-question";
  const text = document.createElement("span");
  text.textContent = poll.question; // textContent, so nobody can inject HTML
  question.append(pollIcon(), text);
  card.appendChild(question);

  const total = poll.options.reduce((sum, o) => sum + o.voters.length, 0);
  const most = Math.max(...poll.options.map(o => o.voters.length));

  poll.options.forEach((option, i) => {
    const count = option.voters.length;
    const percent = total ? Math.round((count / total) * 100) : 0;
    const mine = option.voters.some(v => v.id === state.myId);

    const button = document.createElement("button");
    button.className = "poll-option" + (mine ? " mine" : "") +
      (poll.closed && count > 0 && count === most ? " winner" : "");
    button.disabled = poll.closed;
    button.title = poll.closed ? "This poll is closed" : mine ? "Click again to take your vote back" : "Vote for this";
    button.onclick = () => sendJSON({ type: "poll_vote", poll_id: poll.id, option: i });

    // The bar behind the text grows with the share of votes.
    const fill = document.createElement("span");
    fill.className = "poll-fill";
    fill.style.width = percent + "%";
    const label = document.createElement("span");
    label.className = "poll-label";
    label.textContent = (mine ? "✓ " : "") + option.text;
    const number = document.createElement("span");
    number.className = "poll-count";
    number.textContent = total ? `${count} · ${percent}%` : "0";
    button.append(fill, label, number);
    card.appendChild(button);

    // Named votes: who chose this option.
    if (count) {
      const voters = document.createElement("div");
      voters.className = "poll-voters";
      voters.textContent = option.voters.map(v => (v.id === state.myId ? "You" : v.name)).join(", ");
      card.appendChild(voters);
    }
  });

  const footer = document.createElement("div");
  footer.className = "poll-footer";
  const summary = document.createElement("span");
  summary.textContent = `${total} ${total === 1 ? "vote" : "votes"} · ` +
    (poll.closed ? "Closed" : "Click an option to vote");
  footer.appendChild(summary);
  // The person who made the poll (or an admin) can close it. The server checks too.
  if (!poll.closed && (poll.creator_id === state.myId || state.isAdmin)) {
    const close = document.createElement("button");
    close.className = "poll-close";
    close.textContent = "Close poll";
    close.onclick = () => sendJSON({ type: "poll_close", poll_id: poll.id });
    footer.appendChild(close);
  }
  card.appendChild(footer);
  return card;
}

// New totals arrived: redraw every card showing this poll.
export function updatePoll(poll) {
  for (const card of document.querySelectorAll(`.poll[data-poll-id="${poll.id}"]`)) {
    card.replaceWith(buildPollCard(poll));
  }
}

// Send a new poll to the conversation that's open (a room or a private chat).
// Returns false if no conversation is open to post it in.
export function createPoll(question, options) {
  const key = state.activeKey;
  if (!key || !state.loggedIn) return false;
  const message = { type: "poll_create", question, options };
  if (key.startsWith("dm:")) message.to = key.slice(3);
  else if (key !== "room:" + state.currentRoom) return false;
  sendJSON(message);
  return true;
}

// --- The "New poll" form ---

const dialog = document.getElementById("poll-dialog");
const form = document.getElementById("poll-form");
const questionInput = document.getElementById("poll-question");
const optionsBox = document.getElementById("poll-options");
const addButton = document.getElementById("poll-add");
const errorText = document.getElementById("poll-error");
const whereText = document.getElementById("poll-where");

// One row per option: a text box, and a × to remove it (when there are more than 2).
function addOptionRow(value = "") {
  const row = document.createElement("div");
  row.className = "poll-option-row";
  const input = document.createElement("input");
  input.className = "field";
  input.maxLength = 80;
  input.value = value;
  // Enter in an option box moves to the next one (or adds a new one) instead of submitting.
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const inputs = [...optionsBox.querySelectorAll("input")];
    const next = inputs[inputs.indexOf(input) + 1];
    if (next) next.focus();
    else if (inputs.length < MAX_OPTIONS) addOptionRow().querySelector("input").focus();
    else form.requestSubmit();
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "dialog-close";
  remove.title = "Remove this option";
  remove.textContent = "×";
  remove.onclick = () => { row.remove(); refreshOptionRows(); };
  row.append(input, remove);
  optionsBox.appendChild(row);
  refreshOptionRows();
  return row;
}

// Number the boxes "Option 1, Option 2...", hide × below 2 options, and hide
// "+ Add option" at the maximum.
function refreshOptionRows() {
  const rows = [...optionsBox.children];
  rows.forEach((row, i) => {
    row.querySelector("input").placeholder = `Option ${i + 1}`;
    row.querySelector("button").classList.toggle("invisible", rows.length <= 2);
  });
  addButton.classList.toggle("hidden", rows.length >= MAX_OPTIONS);
}

function showError(text) {
  errorText.textContent = text;
  errorText.classList.remove("hidden");
}

export function openPollDialog() {
  if (!state.activeKey) return;
  // Say where the poll will go, so nobody posts it in the wrong place.
  if (state.activeKey.startsWith("dm:")) {
    const person = state.people.find(p => "dm:" + p.id === state.activeKey);
    whereText.textContent = "In your private chat with " + (person ? person.name : "them");
  } else {
    whereText.textContent = "In #" + state.activeKey.slice(5);
  }
  questionInput.value = "";
  optionsBox.textContent = "";
  addOptionRow();
  addOptionRow();
  errorText.classList.add("hidden");
  dialog.classList.remove("hidden");
  questionInput.focus();
}

function closePollDialog() {
  dialog.classList.add("hidden");
}

form.onsubmit = (e) => {
  e.preventDefault();
  const question = questionInput.value.trim();
  const options = [...optionsBox.querySelectorAll("input")].map(i => i.value.trim()).filter(Boolean);
  // Quick checks for a friendly message. The server checks all of this again.
  if (!question) return showError("Write a question first.");
  if (options.length < 2) return showError("Give at least 2 options.");
  const lower = options.map(o => o.toLowerCase());
  if (new Set(lower).size !== lower.length) return showError("Two options are the same.");
  if (!createPoll(question, options)) return showError("Open a room or a private chat first.");
  closePollDialog();
};

addButton.onclick = () => addOptionRow().querySelector("input").focus();
document.getElementById("poll-close").onclick = closePollDialog;
document.getElementById("poll-cancel").onclick = closePollDialog;
// Enter in the question box jumps to the first option instead of submitting.
questionInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  optionsBox.querySelector("input")?.focus();
});
// Escape or a click outside the form closes it.
dialog.addEventListener("click", (e) => { if (e.target === dialog) closePollDialog(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !dialog.classList.contains("hidden")) closePollDialog();
});
