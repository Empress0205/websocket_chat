"""The basics everything else relies on: logging in, rooms, private messages, limits."""
from helpers import Client, ServerTestCase, db


class LoginTests(ServerTestCase):

    async def test_wrong_password_is_refused(self):
        c = Client("alice", self.url)
        await c.open()
        self.connected.append(c)
        await c.send(type="login", username="alice", password="not-the-password")
        error = await c.wait("auth_error")
        self.assertEqual(error["text"], "Wrong username or password.")

    async def test_unknown_user_gets_the_same_answer(self):
        # So nobody can find out which usernames exist by trying them.
        c = Client("nobody", self.url)
        await c.open()
        self.connected.append(c)
        await c.send(type="login", username="nobody", password="whatever123")
        self.assertEqual((await c.wait("auth_error"))["text"], "Wrong username or password.")

    async def test_there_is_no_sign_up(self):
        c = Client("new", self.url)
        await c.open()
        self.connected.append(c)
        await c.send(type="signup", username="newbie", password="password123")
        await c.wait("auth_error")
        self.assertIsNone(db.get_user_by_name("newbie"))

    async def test_nothing_works_before_logging_in(self):
        c = Client("anon", self.url)
        await c.open()
        self.connected.append(c)
        await c.send(type="chat", text="hello?")
        await c.wait("auth_error")


class ChatTests(ServerTestCase):

    async def test_room_message_reaches_the_room(self):
        alice, bob = await self.login("alice"), await self.login("bob")
        await alice.send(type="chat", text="hello")
        msg = await bob.wait("chat", text="hello")
        self.assertEqual(msg["name"], "alice")

    async def test_private_room_is_refused_without_access(self):
        db.create_room("secret")
        carol = await self.login("carol")
        await carol.send(type="join", room="secret")
        await carol.wait("error")

    async def test_private_message_only_reaches_the_two(self):
        alice, bob, carol = await self.login("alice"), await self.login("bob"), await self.login("carol")
        await alice.send(type="dm", to=bob.id, text="psst")
        await bob.wait("dm", text="psst")
        await alice.wait("dm", text="psst")  # back to the sender, shown as sent
        await carol.nothing("dm")


class RateLimitTests(ServerTestCase):
    FAST = False  # the real limit: 5 messages in a burst, then 1 a second

    async def test_flooding_is_refused(self):
        alice = await self.login("alice")
        for i in range(8):
            await alice.send(type="chat", text=f"spam {i}")
        error = await alice.wait("error")
        self.assertIn("too fast", error["text"])
