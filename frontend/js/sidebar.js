// The sidebar: the rooms you may enter, and everyone with an account.

import { state, conversations } from "./state.js";
import { sendJSON } from "./connection.js";
import { getConversation, openConversation } from "./conversations.js";

const roomsList = document.getElementById("rooms");
const usersList = document.getElementById("users");

// A small outline padlock, drawn with SVG so it matches the text colour.
function lockIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "lock");
  svg.setAttribute("aria-label", "private");
  for (const d of ["M4 7h8v7H4z", "M5.5 7V5a2.5 2.5 0 0 1 5 0v2"]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  }
  return svg;
}

// Public rooms get a "#", private ones the lock. (Also used by admin.js.)
export function roomLabel(el, name, isPublic) {
  el.textContent = isPublic ? "# " + name : name;
  if (!isPublic) el.prepend(lockIcon());
}

function makeItem(label, { active, meta, badge, avatar, onClick, isPrivate }) {
  const li = document.createElement("li");
  li.className = "item" + (active ? " active" : "");
  if (avatar) {
    const a = document.createElement("span");
    a.className = "avatar";
    a.textContent = avatar;
    li.appendChild(a);
  }
  const l = document.createElement("span");
  l.className = "label";
  l.textContent = label;
  if (isPrivate) l.prepend(lockIcon());
  li.appendChild(l);
  if (badge) {
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = badge;
    li.appendChild(b);
  } else if (meta) {
    const m = document.createElement("span");
    m.className = "meta";
    m.textContent = meta;
    li.appendChild(m);
  }
  li.onclick = onClick;
  return li;
}

export function renderSidebar() {
  // Rooms: only the ones the server says we may enter.
  roomsList.textContent = "";
  for (const { name: room, public: isPublic } of state.myRooms) {
    const key = "room:" + room;
    const count = state.users.filter(u => u.room === room).length;
    roomsList.appendChild(makeItem(isPublic ? "# " + room : room, {
      isPrivate: !isPublic,
      active: key === state.activeKey,
      meta: count ? String(count) : "",
      badge: conversations.get(key)?.unread || 0,
      onClick: () => switchRoom(room),
    }));
  }

  // People: everyone with an account except me, online first. You can
  // message someone who's offline: it waits for them (Phase 5).
  const online = new Map(state.users.map(u => [u.id, u]));
  const others = state.people.filter(p => p.id !== state.myId)
    .sort((a, b) => (online.has(b.id) - online.has(a.id)) || a.name.localeCompare(b.name));
  usersList.textContent = "";
  if (others.length === 0) {
    const p = document.createElement("li");
    p.className = "empty";
    p.textContent = "No one else has an account yet.";
    usersList.appendChild(p);
  }
  for (const person of others) {
    const key = "dm:" + person.id;
    const here = online.get(person.id);
    const item = makeItem(person.name, {
      active: key === state.activeKey,
      avatar: person.name.charAt(0).toUpperCase(),
      // Their room, unless it's a private room we can't enter.
      meta: here ? (here.room ? "#" + here.room : "online") : "offline",
      badge: conversations.get(key)?.unread || 0,
      onClick: () => {
        getConversation(key, person.name);
        openConversation(key);
      },
    });
    item.querySelector(".avatar").classList.add(here ? "online" : "offline");
    usersList.appendChild(item);
  }
}

function switchRoom(room) {
  if (room === state.currentRoom) {
    openConversation("room:" + room);
  } else {
    sendJSON({ type: "join", room }); // the server replies with "joined"
  }
}
