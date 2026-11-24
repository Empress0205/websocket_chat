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


class RateLimiterGroup:
    """
    One RateLimiter per key, e.g. per username. A limit kept on the connection
    can be dodged by reconnecting; a limit kept on the username can't, because
    every new connection that tries "alice" spends from the same bucket.
    """

    def __init__(self, capacity, per_second, max_keys=10_000):
        self.capacity = capacity
        self.per_second = per_second
        self.max_keys = max_keys
        self.buckets = {}

    def allow(self, key):
        if len(self.buckets) >= self.max_keys:
            # Don't let someone fill memory by trying millions of usernames:
            # forget the buckets nobody has used recently.
            cutoff = time.monotonic() - self.capacity / self.per_second
            self.buckets = {k: b for k, b in self.buckets.items() if b.updated > cutoff}
        bucket = self.buckets.get(key)
        if bucket is None:
            bucket = self.buckets[key] = RateLimiter(self.capacity, self.per_second)
        return bucket.allow()
