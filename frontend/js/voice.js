// Voice huddles: talk with the people on a conversation's board, using WebRTC.
//
// The audio goes straight from browser to browser. Our WebSocket server never
// touches it: it only passes along the notes two browsers need to find each
// other ("signalling"):
//
//   offer / answer   what audio each side sends, and the keys that encrypt it (SDP)
//   ICE candidates   addresses and ports where each side might be reached
//
// Everyone in a huddle connects to everyone else (a "mesh"), one
// RTCPeerConnection per person. Whoever joins calls everyone already there;
// the others only answer. That way two people never call each other at once.
//
// Speaking rings are worked out here, from the sound itself, so they add no
// network messages. Mute just switches the microphone track off.

import { state } from "./state.js";
import { sendJSON } from "./connection.js";
import { openBoard } from "./board.js";

const SPEAK_LEVEL = 0.035;  // how loud (0 to 1) counts as speaking
const SPEAK_HOLD = 350;     // ms the ring stays on after the sound stops, so it doesn't flicker
const METER_EVERY = 100;    // ms between volume checks
const ANSWER_WAIT = 4000;   // ms to wait for the server to answer voice_join

const voice = {
  key: null,              // the conversation we're talking in: "room:general" or "dm:<id>"
  joining: null,          // the conversation we're joining, while we wait for the server
  stream: null,           // our microphone
  muted: false,
  iceServers: [],         // STUN servers, from the server
  peers: new Map(),       // user id -> { pc, name, audio, meter, chain, pendingIce }
  rosters: new Map(),     // conversation -> who's in its huddle: [{ id, name, muted }]
  dismissed: new Set(),   // conversations whose "Join" banner was closed
  audioCtx: null,         // for measuring volume
  myMeter: null,
  speakingAt: new Map(),  // user id -> when they were last heard
};
let meterTimer = null;
let answerTimer = null;
let noteTimer = null;

const bar = document.getElementById("voice-bar");
const barText = document.getElementById("voice-text");
const barPeople = document.getElementById("voice-people");
const joinBtn = document.getElementById("voice-join");
const muteBtn = document.getElementById("voice-mute");
const leaveBtn = document.getElementById("voice-leave");
const dismissBtn = document.getElementById("voice-dismiss");
const panelBtn = document.getElementById("voice-btn");
const audioBox = document.getElementById("voice-audio");

// --- Joining and leaving ---

export async function joinVoice(key = state.activeKey) {
  if (!key || !state.loggedIn || voice.joining) return;
  if (voice.key === key) return; // already here
  // Browsers only give a page the microphone on https:// or localhost.
  if (!window.isSecureContext || !navigator.mediaDevices) {
    showNote("The microphone only works on https:// or on localhost. Open the page that way to talk.");
    return;
  }
  if (voice.key) leaveVoice(); // one huddle at a time
  voice.joining = key;
  // Made now, during the click: browsers only let sound start after one.
  voice.audioCtx = new AudioContext();
  render();
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    endLocal();
    showNote(e.name === "NotAllowedError"
      ? "The microphone is blocked. Allow it in the browser's address bar, then try again."
      : "Couldn't find a microphone to use.");
    return;
  }
  if (voice.joining !== key || !state.loggedIn) { endLocal(); return; } // cancelled meanwhile
  voice.muted = false;
  // If the microphone is unplugged, leave instead of sending silence.
  voice.stream.getAudioTracks()[0].onended = () => {
    leaveVoice();
    showNote("The microphone stopped, so you left the huddle.");
  };
  sendJSON(key.startsWith("dm:")
    ? { type: "voice_join", with: key.slice(3) }
    : { type: "voice_join", room: key.slice(5) });
  // A server started before huddles existed ignores voice_join. Say so.
  clearTimeout(answerTimer);
  answerTimer = setTimeout(() => {
    if (voice.joining === key) {
      endLocal();
      showNote("The server isn't answering. If it was started before huddles were added, restart it.");
    }
  }, ANSWER_WAIT);
}

export function leaveVoice() {
  if (voice.key) sendJSON({ type: "voice_leave" });
  endLocal();
}

// Hang up on everyone, stop the microphone and tidy up. Nothing is sent.
function endLocal() {
  clearTimeout(answerTimer);
  for (const id of [...voice.peers.keys()]) closePeer(id);
  if (voice.stream) for (const t of voice.stream.getTracks()) t.stop();
  if (voice.audioCtx) voice.audioCtx.close();
  clearInterval(meterTimer);
  Object.assign(voice, { key: null, joining: null, stream: null, muted: false, audioCtx: null, myMeter: null });
  voice.speakingAt.clear();
  render();
}

// The connection to our server dropped. The server has already taken us out
// of the huddle (and told the others to hang up), so stop here too. We don't
// rejoin by ourselves: turning the microphone back on should take a click.
export function voiceDisconnected() {
  if (!voice.key && !voice.joining) return;
  endLocal();
  showNote("The connection dropped, so you left the huddle. Join again when it's back.");
}

function toggleMute() {
  if (!voice.stream) return;
  voice.muted = !voice.muted;
  // A switched-off track sends silence: the connections stay up, so
  // unmuting is instant.
  for (const t of voice.stream.getAudioTracks()) t.enabled = !voice.muted;
  sendJSON({ type: "voice_mute", muted: voice.muted }); // so others see the crossed-out mic
  render();
}

// --- One connection per person ---

function makePeer(id, name) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: voice.iceServers });
  // Our microphone goes to them...
  for (const track of voice.stream.getTracks()) pc.addTrack(track, voice.stream);
  // ...and their sound plays here, in a hidden <audio>.
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audioBox.appendChild(audio);
  const peer = { pc, name, audio, meter: null, chain: Promise.resolve(), pendingIce: [] };
  voice.peers.set(id, peer);

  // Each address the browser finds goes to them, through our server.
  pc.onicecandidate = e => {
    if (e.candidate) sendJSON({ type: "voice_ice", to: id, candidate: e.candidate.toJSON() });
  };
  pc.ontrack = e => {
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
    peer.meter = makeMeter(e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      // Usually a network that blocks direct connections. A TURN relay server would fix it.
      showNote(`Couldn't reach ${name}. Their network may block direct audio.`);
    }
    render();
  };
  return peer;
}

function closePeer(id) {
  const peer = voice.peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peer.audio.srcObject = null;
  peer.audio.remove();
  voice.peers.delete(id);
  voice.speakingAt.delete(id);
}

// Notes from one person are handled one at a time, in order: setting up a
// connection is "async", and an ICE candidate must not be added before the
// offer or answer it belongs to.
function queue(peer, step) {
  peer.chain = peer.chain.then(step).catch(e => console.warn("Voice:", e));
}

async function addPendingIce(peer) {
  for (const c of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(c);
}

// --- Messages from the server ---

export function handleVoiceMessage(msg) {
  switch (msg.type) {
    case "voice_joined": {
      if (voice.joining !== msg.key) return; // we gave up waiting
      clearTimeout(answerTimer);
      voice.key = msg.key;
      voice.joining = null;
      voice.iceServers = msg.ice_servers || [];
      voice.dismissed.delete(msg.key);
      voice.myMeter = makeMeter(voice.stream);
      clearInterval(meterTimer);
      meterTimer = setInterval(checkSpeaking, METER_EVERY);
      // We're the newcomer: call everyone already here.
      for (const p of msg.peers) {
        const peer = makePeer(p.id, p.name);
        queue(peer, async () => {
          await peer.pc.setLocalDescription(await peer.pc.createOffer());
          sendJSON({ type: "voice_offer", to: p.id, sdp: peer.pc.localDescription });
        });
      }
      // It's a huddle on the board: have the board in front of you.
      if (msg.key === state.activeKey) openBoard();
      break;
    }

    case "voice_refused":
      endLocal();
      showNote(msg.text);
      break;

    case "voice_ended":
      // The server took us out (e.g. our access to the room was removed).
      endLocal();
      showNote(msg.text);
      break;

    case "voice_offer": {
      // Someone new is calling us: answer.
      if (!voice.key) return;
      const peer = makePeer(msg.from, msg.name);
      queue(peer, async () => {
        await peer.pc.setRemoteDescription(msg.sdp);
        await addPendingIce(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        sendJSON({ type: "voice_answer", to: msg.from, sdp: peer.pc.localDescription });
      });
      break;
    }

    case "voice_answer": {
      const peer = voice.peers.get(msg.from);
      if (peer) queue(peer, async () => {
        await peer.pc.setRemoteDescription(msg.sdp);
        await addPendingIce(peer);
      });
      break;
    }

    case "voice_ice": {
      const peer = voice.peers.get(msg.from);
      if (peer) queue(peer, async () => {
        // Too early (before their offer or answer): keep it for later.
        if (!peer.pc.remoteDescription) peer.pendingIce.push(msg.candidate);
        else await peer.pc.addIceCandidate(msg.candidate);
      });
      break;
    }

    case "voice_left":
      closePeer(msg.id);
      break;

    case "voice_roster": {
      if (msg.people.length) voice.rosters.set(msg.key, msg.people);
      else {
        voice.rosters.delete(msg.key);
        voice.dismissed.delete(msg.key); // the next huddle here gets a banner again
      }
      if (msg.key === voice.key) {
        // Hang up on anyone who's no longer in it (in case a voice_left was missed).
        const here = new Set(msg.people.map(p => p.id));
        for (const id of [...voice.peers.keys()]) if (!here.has(id)) closePeer(id);
      }
      break;
    }
  }
  render();
}

// Another conversation was opened: its banner (if any) shows instead.
export function voiceFollow() {
  render();
}

// --- Who is speaking ---

function makeMeter(stream) {
  if (!voice.audioCtx) return null;
  const analyser = voice.audioCtx.createAnalyser();
  analyser.fftSize = 512;
  voice.audioCtx.createMediaStreamSource(stream).connect(analyser); // listens only, plays nothing
  return { analyser, data: new Uint8Array(analyser.fftSize) };
}

function loudness(meter) {
  if (!meter) return 0;
  meter.analyser.getByteTimeDomainData(meter.data);
  // RMS: the average size of the sound wave around its middle (128).
  let sum = 0;
  for (const v of meter.data) sum += ((v - 128) / 128) ** 2;
  return Math.sqrt(sum / meter.data.length);
}

function checkSpeaking() {
  const now = Date.now();
  if (!voice.muted && loudness(voice.myMeter) > SPEAK_LEVEL) voice.speakingAt.set(state.myId, now);
  for (const [id, peer] of voice.peers) {
    if (loudness(peer.meter) > SPEAK_LEVEL) voice.speakingAt.set(id, now);
  }
  // Only switch classes here: redrawing the whole bar 10 times a second isn't needed.
  for (const chip of barPeople.children) {
    const at = voice.speakingAt.get(chip.dataset.id) || 0;
    chip.classList.toggle("speaking", now - at < SPEAK_HOLD);
  }
}

// --- On screen ---

function convName(key) {
  if (key.startsWith("room:")) return "#" + key.slice(5);
  const person = state.people.find(p => p.id === key.slice(3));
  return person ? person.name : "a private chat";
}

function listNames(names) {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const MIC_OFF = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8a2.2 2.2 0 0 0-2.2 2.2v3.6a2.2 2.2 0 0 0 4.4 0V4A2.2 2.2 0 0 0 8 1.8zM3.8 7.4a4.2 4.2 0 0 0 8.4 0M8 11.6v2.6M2.5 2.5l11 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function render() {
  const active = state.activeKey;
  const roster = active ? voice.rosters.get(active) || [] : [];
  const inCall = voice.key !== null;
  const joining = voice.joining !== null;
  const invite = !inCall && !joining && roster.length > 0 && !voice.dismissed.has(active);
  const noting = noteTimer !== null;

  bar.classList.toggle("hidden", !(inCall || joining || invite || noting));
  bar.classList.toggle("in-call", inCall);
  joinBtn.classList.toggle("hidden", !invite);
  dismissBtn.classList.toggle("hidden", !invite && !(noting && !inCall && !joining));
  muteBtn.classList.toggle("hidden", !inCall);
  leaveBtn.classList.toggle("hidden", !(inCall || joining));
  muteBtn.classList.toggle("active", voice.muted);
  muteBtn.setAttribute("aria-pressed", String(voice.muted));
  muteBtn.title = voice.muted ? "Unmute your microphone" : "Mute your microphone";
  muteBtn.setAttribute("aria-label", muteBtn.title);

  if (!noting) {
    if (inCall) {
      const people = voice.rosters.get(voice.key) || [];
      barText.textContent = people.length <= 1
        ? `Huddle in ${convName(voice.key)}: waiting for others to join`
        : `Huddle in ${convName(voice.key)}`;
    } else if (joining) {
      barText.textContent = `Joining the huddle in ${convName(voice.joining)}…`;
    } else if (invite) {
      const names = roster.map(p => p.name);
      barText.textContent = `${listNames(names)} ${names.length === 1 ? "is" : "are"} talking on the board`;
    }
  }

  // The people in our huddle, with a ring when they speak.
  barPeople.textContent = "";
  if (inCall) {
    for (const p of voice.rosters.get(voice.key) || []) {
      const chip = document.createElement("span");
      chip.className = "voice-chip";
      chip.dataset.id = p.id;
      const me = p.id === state.myId;
      const peer = voice.peers.get(p.id);
      const connecting = !me && (!peer || peer.pc.connectionState !== "connected");
      if (connecting) chip.classList.add("connecting");
      chip.title = me ? "You" : connecting ? `${p.name} (connecting…)` : p.name;
      const name = document.createElement("span");
      name.textContent = me ? "You" : p.name;
      chip.appendChild(name);
      if (me ? voice.muted : p.muted) chip.insertAdjacentHTML("beforeend", MIC_OFF);
      barPeople.appendChild(chip);
    }
  }

  // The Talk button in the board panel: join this conversation's huddle, or leave it.
  const here = inCall && voice.key === active;
  panelBtn.classList.toggle("active", here);
  panelBtn.setAttribute("aria-pressed", String(here));
  panelBtn.title = here ? "Leave the huddle"
    : roster.length ? `Join the huddle (${roster.length} talking)` : "Start a huddle on this board";
  panelBtn.classList.toggle("live", !here && roster.length > 0);
}

// A short message in the bar (an error, or why we left), then back to normal.
function showNote(text) {
  barText.textContent = text;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { noteTimer = null; render(); }, 7000);
  render();
}

joinBtn.onclick = () => joinVoice();
leaveBtn.onclick = leaveVoice;
muteBtn.onclick = toggleMute;
dismissBtn.onclick = () => {
  if (noteTimer !== null) { clearTimeout(noteTimer); noteTimer = null; }
  else if (state.activeKey) voice.dismissed.add(state.activeKey);
  render();
};
panelBtn.onclick = () => {
  if (voice.key && voice.key === state.activeKey) leaveVoice();
  else joinVoice();
};
// Closing or reloading the tab: hang up properly.
window.addEventListener("pagehide", () => { if (voice.key) leaveVoice(); });
