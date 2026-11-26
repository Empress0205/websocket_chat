// The starting point. index.html loads only this file; it imports the rest.
//
//   state.js          shared values (who am I, which chat is open, ...)
//   connection.js     the WebSocket: connecting, reconnecting, heartbeat
//   handlers.js       what to do with each message from the server
//   conversations.js  message lists, history, read receipts
//   sidebar.js        rooms and people
//   login.js          the log-in screen
//   admin.js          the Admin panel
//   typing.js         "... is typing"
//   composer.js       the message box and Send button
//   polls.js          poll cards, voting and the /poll command
//   board.js          the shared drawing board in the side panel
//   voice.js          voice huddles on the board (WebRTC)
//   notify.js         "(3)" in the tab title, and the bell: sound and pop-ups

import { connect } from "./connection.js";

connect(); // start!
