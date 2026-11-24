// The Admin panel: create accounts and private rooms, and choose who may
// enter each room. The page only shows it to admins, but that's just
// convenience: the server checks admin rights again on every admin_* message.

import { sendJSON } from "./connection.js";
import { roomLabel } from "./sidebar.js";

const adminButton = document.getElementById("manage-rooms");
const adminPanel = document.getElementById("admin");
const adminRooms = document.getElementById("admin-rooms");
const adminMsg = document.getElementById("admin-msg");

export function setAdminButton(isAdmin) {
  adminButton.classList.toggle("hidden", !isAdmin);
}

export function isAdminOpen() {
  return !adminPanel.classList.contains("hidden");
}

// Show a message at the top of the panel (red for errors, grey otherwise).
export function adminMessage(text, isError) {
  adminMsg.textContent = text;
  adminMsg.classList.toggle("error", isError);
  adminMsg.classList.remove("hidden");
}

// Send an admin action, clearing the last message first.
function adminSend(obj) {
  adminMsg.classList.add("hidden");
  sendJSON(obj);
}

adminButton.onclick = () => {
  adminPanel.classList.remove("hidden");
  adminSend({ type: "admin_list" });
};
document.getElementById("admin-close").onclick = () => adminPanel.classList.add("hidden");

document.getElementById("create-user").onsubmit = (e) => {
  e.preventDefault();
  const username = document.getElementById("new-username");
  const password = document.getElementById("new-password");
  adminSend({ type: "admin_create_user", username: username.value.trim(), password: password.value });
  username.value = "";
  password.value = "";
};

document.getElementById("create-room").onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById("create-room-name");
  if (input.value.trim()) adminSend({ type: "admin_create_room", name: input.value.trim() });
  input.value = "";
};

// `allUsers` is every account's username, for the "add a member" dropdown.
export function renderAdmin(rooms, allUsers) {
  adminRooms.textContent = "";
  for (const room of rooms) {
    const box = document.createElement("div");
    box.className = "admin-room";

    const title = document.createElement("div");
    title.className = "admin-room-name";
    roomLabel(title, room.name, room.public);
    const kind = document.createElement("span");
    kind.textContent = room.public ? "public, everyone can enter" : "private";
    title.appendChild(kind);
    box.appendChild(title);

    if (!room.public) {
      box.appendChild(memberChips(room));
      box.appendChild(addMemberForm(room, allUsers));
    }
    adminRooms.appendChild(box);
  }
}

// Members of a private room, each with a remove button.
function memberChips(room) {
  const chips = document.createElement("div");
  chips.className = "chips";
  if (room.members.length === 0) {
    const none = document.createElement("span");
    none.className = "muted";
    none.textContent = "No members yet. Only admins can enter.";
    chips.appendChild(none);
  }
  for (const member of room.members) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = member;
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove " + member;
    x.onclick = () => adminSend({ type: "admin_remove_member", room: room.name, username: member });
    chip.appendChild(x);
    chips.appendChild(chip);
  }
  return chips;
}

// Add someone: pick from the accounts that aren't members yet, so a typo
// can't send a name that doesn't exist.
function addMemberForm(room, allUsers) {
  const candidates = allUsers.filter(u => !room.members.includes(u));
  if (candidates.length === 0) {
    const all = document.createElement("span");
    all.className = "muted";
    all.textContent = "Every account is already a member.";
    return all;
  }
  const form = document.createElement("form");
  form.className = "row-form";
  const select = document.createElement("select");
  const placeholder = new Option("Choose someone to add…", "");
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  for (const u of candidates) select.appendChild(new Option(u, u));
  const add = document.createElement("button");
  add.textContent = "Add";
  form.append(select, add);
  form.onsubmit = (e) => {
    e.preventDefault();
    if (select.value) adminSend({ type: "admin_add_member", room: room.name, username: select.value });
    else adminMessage("Choose someone from the list first.", true);
  };
  return form;
}
