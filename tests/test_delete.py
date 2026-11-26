"""Deleting messages: who may delete what, and who hears about it."""
from helpers import ServerTestCase, db


class DeleteTests(ServerTestCase):

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.alice, self.bob = await self.login("alice"), await self.login("bob")

    async def say(self, client, text):
        """Send a chat message and return it as saved (with its msg_id)."""
        await client.send(type="chat", text=text)
        return await client.wait("chat", text=text)

    async def test_deleting_my_message_tells_everyone(self):
        msg = await self.say(self.alice, "oops, wrong room")
        await self.alice.send(type="delete", msg_id=msg["msg_id"])
        for c in (self.alice, self.bob):
            note = await c.wait("deleted", msg_id=msg["msg_id"])
            self.assertEqual(note["key"], "room:general")

    async def test_deleted_message_is_a_placeholder_with_its_text_wiped(self):
        msg = await self.say(self.alice, "secret plan")
        await self.alice.send(type="delete", msg_id=msg["msg_id"])
        await self.alice.wait("deleted")
        history, _ = db.get_history("general")
        saved = next(m for m in history if m["msg_id"] == msg["msg_id"])
        self.assertTrue(saved.get("deleted"))
        self.assertEqual(saved["text"], "")
        self.assertEqual(db.get_message(msg["msg_id"])["text"], "", "the text must be gone from the database")

    async def test_cannot_delete_someone_elses_message(self):
        msg = await self.say(self.alice, "keep me")
        self.alice.clear()
        await self.bob.send(type="delete", msg_id=msg["msg_id"])
        error = await self.bob.wait("error")
        self.assertIn("own", error["text"])
        await self.alice.nothing("deleted")

    async def test_admin_can_delete_in_a_room(self):
        boss = await self.login("boss")
        msg = await self.say(self.alice, "spam")
        await boss.send(type="delete", msg_id=msg["msg_id"])
        await self.alice.wait("deleted", msg_id=msg["msg_id"])

    async def test_admin_cannot_delete_in_other_peoples_private_chat(self):
        boss = await self.login("boss")
        await self.alice.send(type="dm", to=self.bob.id, text="private")
        dm = await self.bob.wait("dm", text="private")
        await boss.send(type="delete", msg_id=dm["msg_id"])
        await boss.wait("error")
        await self.alice.nothing("deleted")

    async def test_private_chat_delete_only_reaches_the_two(self):
        carol = await self.login("carol")
        await self.alice.send(type="dm", to=self.bob.id, text="just us")
        dm = await self.bob.wait("dm", text="just us")
        await self.alice.send(type="delete", msg_id=dm["msg_id"])
        self.assertEqual((await self.bob.wait("deleted"))["key"], "dm:" + self.alice.id)
        self.assertEqual((await self.alice.wait("deleted"))["key"], "dm:" + self.bob.id)
        await carol.nothing("deleted")

    async def test_people_in_another_room_are_told_too(self):
        # Their page still has the message on screen from when they were there.
        db.create_room("secret")
        db.add_member("secret", self.bob.id)
        await self.bob.send(type="join", room="secret")
        await self.bob.wait("joined")
        msg = await self.say(self.alice, "seen from afar")
        await self.alice.send(type="delete", msg_id=msg["msg_id"])
        await self.bob.wait("deleted", msg_id=msg["msg_id"])

    async def test_hidden_room_message_looks_like_a_missing_one(self):
        # Someone outside a private room can't find out its messages exist.
        db.create_room("secret")
        db.add_member("secret", self.bob.id)
        await self.bob.send(type="join", room="secret")
        await self.bob.wait("joined")
        msg = await self.say(self.bob, "secret stuff")
        carol = await self.login("carol")
        await carol.send(type="delete", msg_id=msg["msg_id"])
        hidden = await carol.wait("error")
        await carol.send(type="delete", msg_id=999_999)
        missing = await carol.wait("error")
        self.assertEqual(hidden["text"], missing["text"])

    async def test_bad_ids_are_refused(self):
        for bad in ("5", True, -1, None, 1.5):
            await self.alice.send(type="delete", msg_id=bad)
            await self.alice.wait("error")

    async def test_deleting_a_poll_removes_it_and_its_votes(self):
        await self.alice.send(type="poll_create", question="Lunch?", options=["Pizza", "Pilau"])
        poll_msg = await self.alice.wait("chat", text="Poll: Lunch?")
        poll_id = poll_msg["poll"]["id"]
        await self.bob.send(type="poll_vote", poll_id=poll_id, option=0)
        await self.alice.wait("poll_update")
        await self.alice.send(type="delete", msg_id=poll_msg["msg_id"])
        await self.alice.wait("deleted")
        self.assertIsNone(db.get_poll(poll_id))
        votes = db._conn.execute("SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?", (poll_id,)).fetchone()
        self.assertEqual(votes["n"], 0)
        await self.bob.send(type="poll_vote", poll_id=poll_id, option=1)
        self.assertIn("no such poll", (await self.bob.wait("error"))["text"].lower())

    async def test_deleted_messages_are_not_unread(self):
        carol = await self.login("carol")
        await self.alice.send(type="dm", to=carol.id, text="one")
        await self.alice.send(type="dm", to=carol.id, text="two")
        two = await self.alice.wait("dm", text="two")
        await self.alice.send(type="delete", msg_id=two["msg_id"])
        await self.alice.wait("deleted")
        counts = db.unread_counts(carol.id, ["general"])
        self.assertEqual(counts.get(db.dm_key(self.alice.id, carol.id)), 1)

    async def test_deleting_twice_does_nothing(self):
        msg = await self.say(self.alice, "once")
        await self.alice.send(type="delete", msg_id=msg["msg_id"])
        await self.alice.wait("deleted")
        await self.alice.send(type="delete", msg_id=msg["msg_id"])
        await self.alice.nothing("deleted")
        await self.alice.nothing("error")
