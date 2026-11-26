// Not missing messages: "(3) WebSocket Chat" in the tab title, and, if you
// turn on the bell, a soft sound and a pop-up for new messages while you're
// looking elsewhere.
//
// The pop-up uses the browser's Notification API. The browser asks you once
// whether to allow it, which is why the bell is off until you click it.

import { state, conversations } from "./state.js";

const BASE_TITLE = document.title;
const SOUND_GAP = 1500;  // ms: at most one sound this often, however many messages arrive

const bell = document.getElementById("notify-btn");
let enabled = localStorage.getItem("chatNotify") === "on";
let hiddenCount = 0;     // messages in the open conversation that arrived while the tab was hidden
let audio = null;        // made on a click: browsers only allow sound after one
let lastSound = 0;

// A message from someone else arrived (not from the history). `open` shows a
// conversation; it's passed in so this file doesn't depend on conversations.js.
export function noteIncoming(key, msg, open) {
  const hidden = document.visibilityState !== "visible";
  if (hidden && key === state.activeKey) {
    hiddenCount++; // on screen, but nobody's looking: count it in the title too
    updateTitle();
  }
  if (!enabled || (!hidden && key === state.activeKey)) return; // you're looking at it
  playSound();
  if (hidden) showPopup(key, msg, open);
}

// "(3) WebSocket Chat": unread messages everywhere, plus the open conversation's
// while the tab is hidden. Called whenever the sidebar's unread counts change.
export function updateTitle() {
  let total = hiddenCount;
  for (const c of conversations.values()) total += c.unread;
  document.title = total ? `(${total > 99 ? "99+" : total}) ${BASE_TITLE}` : BASE_TITLE;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    hiddenCount = 0; // you're back: you've seen them
    updateTitle();
  }
});

// A soft two-note "ding", made with the Web Audio API, so there's no sound file.
function playSound() {
  const now = Date.now();
  if (now - lastSound < SOUND_GAP) return;
  lastSound = now;
  audio = audio || new AudioContext();
  const t = audio.currentTime;
  for (const [pitch, start] of [[880, 0], [1320, 0.09]]) {
    const osc = audio.createOscillator();
    const volume = audio.createGain();
    osc.frequency.value = pitch;
    volume.gain.setValueAtTime(0.0001, t + start);
    volume.gain.exponentialRampToValueAtTime(0.12, t + start + 0.01); // quick start...
    volume.gain.exponentialRampToValueAtTime(0.0001, t + start + 0.3); // ...and fade out
    osc.connect(volume).connect(audio.destination);
    osc.start(t + start);
    osc.stop(t + start + 0.35);
  }
}

function showPopup(key, msg, open) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const title = key.startsWith("dm:") ? msg.name : `${msg.name} in #${key.slice(5)}`;
  const text = msg.board ? "Posted a board snapshot" : msg.text || "";
  // "tag": a newer message from the same conversation replaces the old pop-up
  // instead of piling up.
  const popup = new Notification(title, { body: text.slice(0, 140), tag: key });
  popup.onclick = () => {
    window.focus();
    open(key);
    popup.close();
  };
}

// --- The bell in the header ---

function renderBell() {
  bell.classList.toggle("active", enabled);
  bell.setAttribute("aria-pressed", String(enabled));
  const blocked = enabled && "Notification" in window && Notification.permission === "denied";
  bell.title = !enabled ? "Turn on notifications"
    : blocked ? "Notifications on (sound only: pop-ups are blocked in the browser's site settings)"
    : "Turn off notifications";
  bell.setAttribute("aria-label", bell.title);
}

bell.onclick = async () => {
  enabled = !enabled;
  localStorage.setItem("chatNotify", enabled ? "on" : "off");
  if (enabled) {
    audio = audio || new AudioContext(); // during the click, so sound is allowed
    lastSound = 0;
    playSound(); // a sample, so you know what it sounds like
  }
  renderBell(); // straight away: the browser's question below may wait a while for an answer
  if (enabled && "Notification" in window && Notification.permission === "default") {
    await Notification.requestPermission(); // the browser asks once
    renderBell(); // allowed or blocked: the bell's tooltip says which
  }
};

// After a reload with the bell on, the browser only allows sound again after
// your first click on the page.
document.addEventListener("pointerdown", () => { if (audio && audio.state === "suspended") audio.resume(); });

renderBell();
