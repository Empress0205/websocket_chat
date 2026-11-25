"""
Polls: the rules for what a poll may contain and who may use it.

The server is the vote counter. The page only says "I vote for option 2";
everything is checked here and in db.py, so nobody can vote twice, vote in a
poll they can't see, or create a poll with a thousand options.
"""
import db

MAX_QUESTION = 200
MAX_OPTION = 80
MIN_OPTIONS = 2
MAX_OPTIONS = 10


def clean_poll(question, options):
    """
    Check a new poll. Returns (question, options, None) if it's fine,
    or (None, None, "what's wrong") if not.
    """
    question = str(question or "").strip()
    if not question:
        return None, None, "A poll needs a question."
    if len(question) > MAX_QUESTION:
        return None, None, f"Keep the question under {MAX_QUESTION} characters."
    if not isinstance(options, list):
        return None, None, "A poll needs a list of options."

    cleaned = []
    for option in options:
        text = str(option or "").strip()
        if not text:
            continue  # skip empty options, e.g. from "| |"
        if len(text) > MAX_OPTION:
            return None, None, f"Keep each option under {MAX_OPTION} characters."
        if text.lower() in (c.lower() for c in cleaned):
            return None, None, f"\"{text}\" is in the poll twice."
        cleaned.append(text)

    if not MIN_OPTIONS <= len(cleaned) <= MAX_OPTIONS:
        return None, None, f"A poll needs {MIN_OPTIONS} to {MAX_OPTIONS} options."
    return question, cleaned, None


def can_use(user_id, conv):
    """
    May this user see and vote in a poll in this conversation? The same rule as
    for its messages: room members (or everyone, for public rooms), and only the
    two people in a private chat.
    """
    if conv.startswith("dm:"):
        return str(user_id) in conv[3:].split(":")
    return db.can_access(user_id, conv)


def people_in(conv):
    """The two user ids in a private chat's key ("dm:2:5")."""
    return conv[3:].split(":") if conv.startswith("dm:") else []
