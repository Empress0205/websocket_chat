"""
Voice huddles: talking on the board, with WebRTC.

The audio itself never comes through this server. Each pair of browsers sends
it straight to each other (peer-to-peer). Before they can, they must swap two
kinds of notes, and they have no way to reach each other yet, so the server
passes the notes along. That's called "signalling":

  - an offer and an answer (SDP): what audio each side will send, and the
    keys that encrypt it
  - ICE candidates: the addresses and ports where each side might be reached

This file keeps track of who is in which huddle and checks every note before
it's passed on. server.py does the sending.

A huddle belongs to a conversation (a room or a private chat), like its board.
Everyone in it connects to everyone else (a "mesh"), so it's kept small: with
5 people, each browser sends its audio 4 times.
"""

MAX_PEOPLE = 5
MAX_SDP = 10_000        # characters in an offer or answer (a real one is ~1,500 to 4,000)
MAX_CANDIDATE = 1_000   # characters in an ICE candidate (a real one is ~100)

# STUN servers tell a browser what its address looks like from the internet,
# so the other side knows where to send audio. These are Google's free public
# ones. They're sent to the page when it joins (not written into the page),
# so a TURN relay can be added here later without changing the page.
ICE_SERVERS = [{"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]}]

# Who is talking where. Nothing is saved: a huddle only exists while people are in it.
#   conversation -> {user id: {"name": "alice", "muted": False, "ws": <connection>}}
huddles = {}


def join(conv, user_id, name, ws):
    """Add someone to a huddle. Returns None if it worked, or "what's wrong"."""
    people = huddles.setdefault(conv, {})
    if user_id not in people and len(people) >= MAX_PEOPLE:
        if not people:
            del huddles[conv]
        return f"The huddle is full ({MAX_PEOPLE} people). Each person connects to everyone else, so it's kept small."
    people[user_id] = {"name": name, "muted": False, "ws": ws}
    return None


def leave(conv, user_id, ws):
    """
    Take someone out of a huddle. Only their own connection can do it, so an old
    tab closing late can't remove the same person after they joined from a new one.
    Returns True if they were in it.
    """
    people = huddles.get(conv, {})
    entry = people.get(user_id)
    if entry is None or entry["ws"] is not ws:
        return False
    del people[user_id]
    if not people:
        del huddles[conv]  # the last person left: the huddle is over
    return True


def is_in(conv, user_id):
    return user_id in huddles.get(conv, {})


def set_muted(conv, user_id, muted):
    entry = huddles.get(conv, {}).get(user_id)
    if entry is not None:
        entry["muted"] = bool(muted)


def people(conv):
    """Who is in a huddle, to show on the page (never the connections)."""
    return [{"id": uid, "name": p["name"], "muted": p["muted"]} for uid, p in huddles.get(conv, {}).items()]


def clean_description(value, kind):
    """
    Check an offer or answer: {"type": "offer", "sdp": "v=0..."}.
    Returns a clean copy, or None. The server doesn't read the SDP itself, it
    only checks its shape and size, so nobody can push megabytes through the relay.
    """
    if not isinstance(value, dict) or value.get("type") != kind:
        return None
    sdp = value.get("sdp")
    if not isinstance(sdp, str) or not sdp or len(sdp) > MAX_SDP:
        return None
    return {"type": kind, "sdp": sdp}


def clean_candidate(value):
    """
    Check an ICE candidate, as the browser's candidate.toJSON() gives it:
    {"candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0, "usernameFragment": "..."}.
    Returns a clean copy with only those fields, or None.
    """
    if not isinstance(value, dict):
        return None
    candidate = value.get("candidate")
    if not isinstance(candidate, str) or len(candidate) > MAX_CANDIDATE:
        return None
    mid = value.get("sdpMid")
    index = value.get("sdpMLineIndex")
    fragment = value.get("usernameFragment")
    if mid is not None and (not isinstance(mid, str) or len(mid) > 32):
        return None
    if index is not None and (not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < 16):
        return None
    if fragment is not None and (not isinstance(fragment, str) or len(fragment) > 256):
        return None
    return {"candidate": candidate, "sdpMid": mid, "sdpMLineIndex": index, "usernameFragment": fragment}
