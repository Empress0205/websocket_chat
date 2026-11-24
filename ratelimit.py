"""
Rate limiting: stop one connection from sending too much, too fast.
"""
import time


class RateLimiter:
    """
    A "token bucket". The bucket holds up to `capacity` tokens and refills at
    `per_second` tokens a second. Every action spends one token; when the bucket
    is empty, the action is refused.

    This allows a short burst (say, 5 quick messages) but not a steady flood.
    """

    def __init__(self, capacity, per_second):
        self.capacity = capacity
        self.per_second = per_second
        self.tokens = capacity
        self.updated = time.monotonic()

    def allow(self):
        now = time.monotonic()
        # Add back the tokens earned since we last looked, up to the maximum.
        self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.per_second)
        self.updated = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False
