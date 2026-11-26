"""Editing messages and reacting to them."""
from helpers import ServerTestCase, db


class MessageTestCase(ServerTestCase):

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.alice, self.bob = await self.login("alice"), await self.login("bob")

    async def say(self, client, text):
        await client.send(type="chat", text=text)
        return await client.wait("chat", text=text)

    def saved(self, msg_id):
        """The message as the history shows it (what people see after a reload)."""
        history, _ = db.get_history("general")
        return next(m for m in history if m["msg_id"] == msg_id)


class EditTests(MessageTestCase):

    async def test_editing_changes_the_text_for_everyone(self):
        msg = await self.say(self.alice, "Meeting at 3pm")
        await self.alice.send(type="edit", msg_id=msg["msg_id"], text="Meeting at 4pm")
        for c in (self.alice, self.bob):
            edited = await c.wait("edited", msg_id=msg["msg_id"])
            self.assertEqual((edited["text"], edited["key"]), ("Meeting at 4pm", "room:general"))
        saved = self.saved(msg["msg_id"])
        self.assertEqual(saved["text"], "Meeting at 4pm")
        self.assertTrue(saved.get("edited"), "history must show it was edited")

    async def test_unedited_messages_are_not_marked(self):
        msg = await self.say(self.alice, "never changed")
        self.assertNotIn("edited", self.saved(msg["msg_id"]))

    async def test_cannot_edit_someone_elses_message(self):
        msg = await self.say(self.alice, "mine")
        await self.bob.send(type="edit", msg_id=msg["msg_id"], text="hacked")
        self.assertIn("own", (await self.bob.wait("error"))["text"])
        self.assertEqual(self.saved(msg["msg_id"])["text"], "mine")

    async def test_admins_cannot_edit_others_either(self):
        boss = await self.login("boss")
        msg = await self.say(self.alice, "my words")
        await boss.send(type="edit", msg_id=msg["msg_id"], text="different words")
        await boss.wait("error")
        self.assertEqual(self.saved(msg["msg_id"])["text"], "my words")

    async def test_empty_text_is_refused(self):
        msg = await self.say(self.alice, "something")
        await self.alice.send(type="edit", msg_id=msg["msg_id"], text="   ")
        self.assertIn("delete", (await self.alice.wait("error"))["text"])

    async def test_polls_cannot_be_edited(self):
        await self.alice.send(type="poll_create", question="Lunch?", options=["Pizza", "Pilau"])
        poll = await self.alice.wait("chat", text="Poll: Lunch?")
        await self.alice.send(type="edit", msg_id=poll["msg_id"], text="Dinner?")
        self.assertIn("text messages", (await self.alice.wait("error"))["text"])

    async def test_deleted_messages_cannot_be_edited(self):
        msg = await self.say(self.alice, "gone soon")
        await self.alice.send(type="delete", msg_id=msg["msg_id"])
        await self.alice.wait("deleted")
        await self.alice.send(type="edit", msg_id=msg["msg_id"], text="back again?")
        await self.bob.nothing("edited")
        self.assertTrue(self.saved(msg["msg_id"]).get("deleted"))

    async def test_long_text_is_cut_to_the_limit(self):
        msg = await self.say(self.alice, "short")
        await self.alice.send(type="edit", msg_id=msg["msg_id"], text="x" * 5000)
        edited = await self.bob.wait("edited")
        self.assertEqual(len(edited["text"]), 2000)

    async def test_editing_in_a_private_chat_only_reaches_the_two(self):
        carol = await self.login("carol")
        await self.alice.send(type="dm", to=self.bob.id, text="typo")
        dm = await self.bob.wait("dm", text="typo")
        await self.alice.send(type="edit", msg_id=dm["msg_id"], text="fixed")
        self.assertEqual((await self.bob.wait("edited"))["key"], "dm:" + self.alice.id)
        await carol.nothing("edited")


class ReactionTests(MessageTestCase):

    async def test_reacting_shows_for_everyone_with_who_reacted(self):
        msg = await self.say(self.alice, "We won the contract!")
        await self.bob.send(type="react", msg_id=msg["msg_id"], emoji="🎉")
        update = await self.alice.wait("reactions", msg_id=msg["msg_id"])
        self.assertEqual(update["reactions"], [{"emoji": "🎉", "users": [{"id": self.bob.id, "name": "bob"}]}])

    async def test_reacting_again_takes_it_back(self):
        msg = await self.say(self.alice, "hello")
        await self.bob.send(type="react", msg_id=msg["msg_id"], emoji="👍")
        await self.bob.wait("reactions")
        await self.bob.send(type="react", msg_id=msg["msg_id"], emoji="👍")
        self.assertEqual((await self.bob.wait("reactions"))["reactions"], [])

    async def test_counts_add_up_and_keep_their_order(self):
        msg = await self.say(self.alice, "lunch?")
        carol = await self.login("carol")
        await self.bob.send(type="react", msg_id=msg["msg_id"], emoji="😂")
        await self.bob.wait("reactions")
        await carol.send(type="react", msg_id=msg["msg_id"], emoji="👍")
        await carol.wait("reactions")
        await self.alice.send(type="react", msg_id=msg["msg_id"], emoji="😂")
        update = await self.alice.wait("reactions", reactions=[
            {"emoji": "😂", "users": [{"id": self.bob.id, "name": "bob"}, {"id": self.alice.id, "name": "alice"}]},
            {"emoji": "👍", "users": [{"id": carol.id, "name": "carol"}]},
        ])
        self.assertEqual(update["reactions"], self.saved(msg["msg_id"])["reactions"], "history matches the live view")

    async def test_unknown_emoji_is_refused(self):
        msg = await self.say(self.alice, "hi")
        for bad in ("💩", "<script>", None, 5):
            await self.bob.send(type="react", msg_id=msg["msg_id"], emoji=bad)
            await self.bob.wait("error")
        self.assertNotIn("reactions", self.saved(msg["msg_id"]))

    async def test_no_reacting_to_messages_you_cannot_see(self):
        db.create_room("secret")
        db.add_member("secret", self.bob.id)
        await self.bob.send(type="join", room="secret")
        await self.bob.wait("joined")
        await self.bob.send(type="chat", text="secret stuff")
        msg = await self.bob.wait("chat", text="secret stuff")
        await self.alice.send(type="react", msg_id=msg["msg_id"], emoji="👍")
        self.assertEqual((await self.alice.wait("error"))["text"], "There's no such message.")

    async def test_deleting_a_message_removes_its_reactions(self):
        msg = await self.say(self.alice, "hmm")
        await self.bob.send(type="react", msg_id=msg["msg_id"], emoji="😮")
        await self.bob.wait("reactions")
        await self.alice.send(type="delete", msg_id=msg["msg_id"])
        await self.alice.wait("deleted")
        self.assertEqual(db.reactions_for([msg["msg_id"]]), {})
        await self.bob.send(type="react", msg_id=msg["msg_id"], emoji="😮")
        await self.bob.nothing("reactions")
