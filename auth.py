"""
Accounts: checking usernames and passwords, hashing passwords, and login tokens.

Only Python's standard library is used, so there is nothing extra to install.
"""
import hashlib
import hmac
import re
import secrets

# How many times the password is hashed. More rounds make each guess slower for
# an attacker who steals the database (about 0.3 seconds per guess here).
PBKDF2_ROUNDS = 600_000

SESSION_DAYS = 30  # how long a login token stays valid


def check_username(username):
    """Return an error message, or None if the username is fine."""
    if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", username or ""):
        return "Usernames are 3 to 20 letters, digits or underscores."
    return None


def check_password(password):
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        return "Passwords need at least 8 characters."
    return None


def hash_password(password):
    """
    Turn a password into something safe to store.

    We never store the password itself. A random "salt" makes two people with
    the same password get different hashes, so one cracked hash doesn't reveal
    the other. The result keeps the salt, so we can check the password later.
    """
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password, stored):
    salt_hex, digest_hex = stored.split("$")
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), PBKDF2_ROUNDS)
    # compare_digest takes the same time whether the first or the last
    # character is wrong, so timing can't leak how close a guess was.
    return hmac.compare_digest(digest.hex(), digest_hex)


def new_token():
    """A long random login token, impossible to guess."""
    return secrets.token_urlsafe(32)


def hash_token(token):
    """
    The database stores only a hash of each token. If someone copies the
    database, they still can't use the tokens in it to log in as anyone.
    """
    return hashlib.sha256(token.encode()).hexdigest()
