"""
Drawing board: the rules for what may be drawn.

Every screen draws the board at a different size, so points are sent in
"board units" on a fixed 2000 x 1250 board, and each page scales them to fit.
(It was 1000 wide at first. Drawings from then sit in the left half.)
The server checks every point, colour and tool, so nobody can send a million
points or draw off the board by sending messages by hand.
"""
WIDTH = 2000
HEIGHT = 1250
# Goes up when the board changes in a way an older page or server can't
# handle (2: text labels are sent live while they're typed; 3: strokes can be
# moved). The page checks it, with the size, to warn when the server needs restarting.
VERSION = 3

COLORS = ("black", "blue", "red", "green")
# Shapes are drawn between two points: where the drag started and where it is
# now (a line's two ends, or the opposite corners of the box a shape fills).
SHAPES = ("line", "arrow", "rect", "ellipse", "diamond", "triangle", "cloud", "cylinder")
TOOLS = ("pen", "text") + SHAPES

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
    # A text label is sent while it's typed, so it may be empty for a moment.
    text = clean_text(text) if tool == "text" else None
    return {"tool": tool, "color": color, "text": text, "points": []}, None


def clean_text(text):
    """A label's words: trimmed, and no longer than MAX_TEXT."""
    return str(text or "").strip()[:MAX_TEXT]


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
    """
    A pen line needs one point; a text label one point and some words. A shape
    needs its two points, and they mustn't be the same spot (a click isn't a shape).
    """
    points = stroke["points"]
    if stroke["tool"] in SHAPES:
        return len(points) == 4 and (points[0], points[1]) != (points[2], points[3])
    if stroke["tool"] == "text":
        return len(points) >= 2 and bool(stroke["text"])
    return len(points) >= 2


def clean_offset(dx, dy):
    """How far a stroke is being dragged, in board units. None if it's not two whole numbers on the board."""
    if any(isinstance(v, bool) or not isinstance(v, int) for v in (dx, dy)):
        return None
    if abs(dx) > WIDTH or abs(dy) > HEIGHT:
        return None
    return dx, dy


def move_points(points, dx, dy):
    """
    Shift every point of a stroke by (dx, dy). The stroke moves as one piece:
    if it would go past an edge, it stops at that edge instead (no point is
    squashed against the side, so its shape never changes).
    """
    xs, ys = points[0::2], points[1::2]
    dx = max(-min(xs), min(dx, WIDTH - max(xs)))
    dy = max(-min(ys), min(dy, HEIGHT - max(ys)))
    return [v + (dx if i % 2 == 0 else dy) for i, v in enumerate(points)]


def clean_cursor(x, y):
    """Where someone's pointer is, kept on the board. None if it's not numbers."""
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in (x, y)):
        return None
    return min(max(round(x), 0), WIDTH), min(max(round(y), 0), HEIGHT)
