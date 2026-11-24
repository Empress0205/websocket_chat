// Values that several files need to read and change.
// Keeping them in one object makes it clear what's shared, instead of
// having loose global variables everywhere.

export const state = {
  // Our user id and name come from our account once we log in.
  // We compare the id with each message's id to decide left or right.
  myId: null,
  myName: null,
  loggedIn: false,
  signedOutText: null, // set when we were signed out on purpose

  currentRoom: null,   // the room the server has us in
  activeKey: null,     // the conversation on screen: "room:general" or "dm:<id>"

  users: [],           // everyone online: [{ id, name, room }]
  people: [],          // everyone with an account: [{ id, name }]
  myRooms: [],         // the rooms we may enter: [{ name, public }]
  isAdmin: false,
};

// A conversation is either a room ("room:general") or a private chat with
// one person ("dm:<their id>"). Each one gets its own message list, so
// switching between them doesn't mix messages up. See conversations.js.
export const conversations = new Map();
