// What to do with each kind of message the server sends.
// Every message has a "type"; this file is the one place that decides
// which part of the page deals with it.

import { state, conversations } from "./state.js";
import { sendJSON } from "./connection.js";
import {
  getConversation, openConversation, renderTitle, addMessage, addInfo,
  showHistory, updateReceipts, showDeleted,
} from "./conversations.js";
import { renderSidebar } from "./sidebar.js";
import { showLogin, hideLogin } from "./login.js";
import { setSendEnabled } from "./composer.js";
import { showTyping, clearTyping } from "./typing.js";
import { renderAdmin, adminMessage, isAdminOpen, setAdminButton } from "./admin.js";
import { updatePoll } from "./polls.js";
import { handleBoardMessage, boardReconnected, showBoardActivity } from "./board.js";
import { handleVoiceMessage } from "./voice.js";

export function handleMessage(msg) {
  switch (msg.type) {
    case "auth_ok": return onLoggedIn(msg);

    case "auth_error":
      // A saved token that no longer works is useless: forget it.
      sessionStorage.removeItem("chatToken");
      showLogin(msg.text);
      return;

    case "signed_out":
      // We logged out, or logged in from another tab. The server closes the
      // connection next, and connection.js shows the login screen.
      sessionStorage.removeItem("chatToken");
      state.signedOutText = msg.text;
      return;

    case "joined":
      // The server moved us into a room (it may have cleaned up the name).
      state.currentRoom = msg.room;
      sessionStorage.setItem("chatRoom", msg.room); // remembered across reloads
      // After a reconnect, stay in the private chat we were reading.
      if (state.activeKey && state.activeKey.startsWith("dm:")) renderSidebar();
      else openConversation("room:" + msg.room);
      return;

    case "history":
      return showHistory(msg);

    case "chat":
      addMessage("room:" + msg.room, msg);
      clearTyping(msg.id); // they sent it, so they're done typing
      return;

    case "dm": {
      // If I sent it, the conversation is with the recipient; otherwise with the sender.
      const otherId = msg.id === state.myId ? msg.to : msg.id;
      const other = state.people.find(p => p.id === otherId);
      getConversation("dm:" + otherId, other ? other.name : msg.name);
      addMessage("dm:" + otherId, msg);
      clearTyping(msg.id);
      return;
    }

    case "board_state":
    case "board_viewers":
    case "board_draw":
    case "board_saved":
    case "board_removed":
    case "board_cleared":
    case "board_cursor":
      // Everything to do with the drawing board (see board.js).
      return handleBoardMessage(msg);

    case "board_activity":
      // Someone is drawing on this conversation's board and ours is closed.
      return showBoardActivity(msg);

    case "voice_joined":
    case "voice_refused":
    case "voice_ended":
    case "voice_roster":
    case "voice_offer":
    case "voice_answer":
    case "voice_ice":
    case "voice_left":
      // Voice huddles: who's talking, and the WebRTC handshake (see voice.js).
      return handleVoiceMessage(msg);

    case "deleted":
      // A message was deleted for everyone (by its sender, or an admin).
      return showDeleted(msg.key, msg.msg_id);

    case "poll_update":
      // Someone voted or the poll was closed: redraw it with the new totals.
      return updatePoll(msg.poll);

    case "typing":
      return showTyping(msg.id, msg.name, msg.dm ? "dm:" + msg.id : "room:" + msg.room);

    case "info":
      return addInfo("room:" + msg.room, msg.text);

    case "users":
      state.users = msg.users;
      renderSidebar();
      renderTitle();
      return;

    case "people":
      state.people = msg.people;
      renderSidebar();
      renderTitle();
      return;

    case "unread":
      // After logging in: messages that arrived while we were away.
      for (const [key, n] of Object.entries(msg.counts)) {
        const person = state.people.find(p => "dm:" + p.id === key);
        const c = getConversation(key, person ? person.name : undefined);
        if (key !== state.activeKey) c.unread = n;
      }
      renderSidebar();
      return;

    case "seen":
      // Read receipts: someone read up to msg_id.
      if (msg.with) {
        const c = getConversation("dm:" + msg.with);
        c.otherRead = Math.max(c.otherRead, msg.msg_id);
        updateReceipts("dm:" + msg.with);
      } else {
        const c = getConversation("room:" + msg.room);
        c.reads.set(msg.id, { id: msg.id, name: msg.name, last: msg.msg_id });
        updateReceipts("room:" + msg.room);
      }
      return;

    case "rooms":
      // The rooms we may enter. Sent after logging in and whenever an admin changes them.
      state.myRooms = msg.rooms;
      state.isAdmin = msg.admin;
      setAdminButton(state.isAdmin);
      renderSidebar();
      return;

    case "admin_rooms":
      return renderAdmin(msg.rooms, msg.users);

    case "notice":
      if (isAdminOpen()) adminMessage(msg.text, false);
      else if (state.activeKey) addInfo(state.activeKey, msg.text);
      return;

    case "error":
      if (isAdminOpen()) adminMessage(msg.text, true);
      else if (state.activeKey) addInfo(state.activeKey, msg.text, true);
      return;
  }
}

// Logged in. Keep the token (only sent on a fresh login) and join a room.
function onLoggedIn(msg) {
  if (msg.token) sessionStorage.setItem("chatToken", msg.token);
  const reconnected = state.myId !== null; // we were logged in before the drop
  state.loggedIn = true;
  if (reconnected) {
    // We may have missed private messages while away: fetch history again
    // when each private chat is next opened (the open one right now).
    for (const [key, c] of conversations) if (key.startsWith("dm:")) c.historyAsked = false;
    if (state.activeKey && state.activeKey.startsWith("dm:")) {
      conversations.get(state.activeKey).historyAsked = true;
      sendJSON({ type: "dm_history", with: state.activeKey.slice(3) });
    }
  }
  state.myId = msg.user.id;
  state.myName = msg.user.name;
  document.getElementById("me-name").textContent = state.myName;
  hideLogin();
  setSendEnabled(true);
  // Go back to the room this tab was in before a reload (the server
  // checks access and falls back to #general if it's not allowed).
  sendJSON({ type: "join", room: sessionStorage.getItem("chatRoom") || "general" });
  boardReconnected(); // if the board was open before the connection dropped, reopen it
}
