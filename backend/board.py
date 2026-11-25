"""
Drawing board: the rules for what may be drawn.

Every screen draws the board at a different size, so points are sent in
"board units" on a fixed 1000 x 1250 board, and each page scales them to fit.
The server checks every point, colour and tool, so nobody can send a million
points or draw off the board by sending messages by hand.
"""
WIDTH = 1000
HEIGHT = 1250

COLORS = ("black", "blue", "red", "green")
TOOLS = ("pen", "arrow", "text")

MAX_BATCH = 400       # numbers in one message (200 points)
MAX_POINTS = 6000     # numbers in one stroke (3000 points)
MAX_TEXT = 80         # characters in a text label
MAX_STROKES = 3000    # strokes on one board before it must be cleared


def start_stroke(tool, color, text):
    """
    Check the first message of a new stroke. Returns (stroke, None) if it's
    fine, or (None, "what's wrong").
    """
    if tool not in TOOLS:
        return None, "Unknown drawing tool."
    if color not in COLORS:
        return None, "Unknown colour."
    if tool == "text":
        text = str(text or "").strip()[:MAX_TEXT]
        if not text:
            return None, "Write something first."
    else:
        text = None
    return {"tool": tool, "color": color, "text": text, "points": []}, None


def clean_points(points):
    """
    Check a batch of points: a flat list [x1, y1, x2, y2, ...] of numbers on
    the board. Returns whole numbers (they're plenty precise), or None if bad.
    """
    if not isinstance(points, list) or len(points) % 2 or len(points) > MAX_BATCH:
        return None
    cleaned = []
    for i, value in enumerate(points):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        limit = WIDTH if i % 2 == 0 else HEIGHT
        cleaned.append(min(max(round(value), 0), limit))  # keep it on the board
    return cleaned


def is_complete(stroke):
    """A pen line needs at least one point, an arrow two, a text label one."""
    needed = 4 if stroke["tool"] == "arrow" else 2
    return len(stroke["points"]) >= needed


def clean_cursor(x, y):
    """Where someone's pointer is, kept on the board. None if it's not numbers."""
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in (x, y)):
        return None
    return min(max(round(x), 0), WIDTH), min(max(round(y), 0), HEIGHT)
