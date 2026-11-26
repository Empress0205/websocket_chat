"""Voice huddles: the server's half (who's in each huddle, and the signalling relay)."""
import asyncio

from helpers import ServerTestCase, db, voice

OFFER = {"type": "offer", "sdp": "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n"}
ANSWER = {"type": "answer", "sdp": "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n"}
CANDIDATE = {"candidate": "candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host",
             "sdpMid": "0", "sdpMLineIndex": 0, "usernameFragment": "abcd"}


class HuddleTests(ServerTestCase):

    async def test_joining_shows_the_huddle_to_the_room(self):
        alice, bob = await self.login("alice"), await self.login("bob")
        await alice.send(type="voice_join", room="general")
        joined = await alice.wait("voice_joined")
        self.assertEqual(joined["key"], "room:general")
        self.assertEqual(joined["peers"], [])
        self.assertTrue(joined["ice_servers"], "the page needs STUN servers to connect")
        roster = await bob.wait("voice_roster", key="room:general")
        self.assertEqual([p["name"] for p in roster["people"]], ["alice"])

    async def test_newcomer_gets_the_people_to_call(self):
        alice, bob = await self.login("alice"), await self.login("bob")
        await alice.send(type="voice_join", room="general")
        await alice.wait("voice_joined")
        await bob.send(type="voice_join", room="general")
        joined = await bob.wait("voice_joined")
        self.assertEqual([p["name"] for p in joined["peers"]], ["alice"])

    async def test_late_login_sees_a_huddle_going_on(self):
        alice = await self.login("alice")
        await alice.send(type="voice_join", room="general")
        await alice.wait("voice_joined")
        dave = await self.login("dave")
        roster = await dave.wait("voice_roster", key="room:general")
        self.assertEqual([p["name"] for p in roster["people"]], ["alice"])

    async def test_huddle_is_full_at_five(self):
        people = [await self.login(n) for n in ("alice", "bob", "carol", "dave", "erin", "frank")]
        for p in people[:5]:
            await p.send(type="voice_join", room="general")
            await p.wait("voice_joined")
        await people[5].send(type="voice_join", room="general")
        refused = await people[5].wait("voice_refused")
        self.assertIn("full", refused["text"])

    async def test_one_huddle_at_a_time(self):
        alice, bob = await self.login("alice"), await self.login("bob")
        await alice.send(type="voice_join", **{"with": bob.id})
        await alice.wait("voice_joined", key="dm:" + bob.id)
        await alice.send(type="voice_join", room="general")
        await alice.wait("voice_joined", key="room:general")
        self.assertEqual(list(voice.huddles), ["general"], "the private-chat huddle should be over")

    async def test_mute_shows_in_the_roster(self):
        alice, bob = await self.login("alice"), await self.login("bob")
        for p in (alice, bob):
            await p.send(type="voice_join", room="general")
            await p.wait("voice_joined")
        bob.clear()
        await alice.send(type="voice_mute", muted=True)
        roster = await bob.wait("voice_roster")
        self.assertEqual({p["name"]: p["muted"] for p in roster["people"]}, {"alice": True, "bob": False})

    async def test_disconnecting_leaves_the_huddle(self):
        alice, bob = await self.login("alice"), await self.login("bob")
        for p in (alice, bob):
            await p.send(type="voice_join", room="general")
            await p.wait("voice_joined")
        await bob.close()
        left = await alice.wait("voice_left")
        self.assertEqual(left["id"], bob.id)

    async def test_last_one_out_ends_the_huddle(self):
        alice = await self.login("alice")
        await alice.send(type="voice_join", room="general")
        await alice.wait("voice_joined")
        await alice.send(type="voice_leave")
        await asyncio.sleep(0.2)
        self.assertEqual(voice.huddles, {})


class PrivacyTests(ServerTestCase):

    async def test_private_chat_huddle_is_only_seen_by_the_two(self):
        alice, bob, carol = await self.login("alice"), await self.login("bob"), await self.login("carol")
        carol.clear()
        await alice.send(type="voice_join", **{"with": bob.id})
        await alice.wait("voice_joined")
        await bob.wait("voice_roster", key="dm:" + alice.id)
        await carol.nothing("voice_roster")

    async def test_no_access_no_join(self):
        db.create_room("secret")
        carol = await self.login("carol")
        await carol.send(type="voice_join", room="secret")
        await carol.wait("voice_refused")


class SignallingTests(ServerTestCase):
    """The relay: offers, answers and ICE candidates between two people."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.alice, self.bob = await self.login("alice"), await self.login("bob")
        for p in (self.alice, self.bob):
            await p.send(type="voice_join", room="general")
            await p.wait("voice_joined")

    async def test_offer_answer_and_ice_are_passed_on(self):
        await self.bob.send(type="voice_offer", to=self.alice.id, sdp=OFFER)
        offer = await self.alice.wait("voice_offer")
        self.assertEqual((offer["from"], offer["name"], offer["sdp"]), (self.bob.id, "bob", OFFER))
        await self.alice.send(type="voice_answer", to=self.bob.id, sdp=ANSWER)
        self.assertEqual((await self.bob.wait("voice_answer"))["sdp"], ANSWER)
        await self.alice.send(type="voice_ice", to=self.bob.id, candidate={**CANDIDATE, "extra": "x"})
        ice = await self.bob.wait("voice_ice")
        self.assertEqual(ice["candidate"], CANDIDATE, "only the known fields are passed on")

    async def test_from_is_filled_in_by_the_server(self):
        carol = await self.login("carol")
        await self.bob.send(type="voice_offer", to=self.alice.id, sdp=OFFER, **{"from": carol.id})
        self.assertEqual((await self.alice.wait("voice_offer"))["from"], self.bob.id)

    async def test_relay_only_works_inside_the_huddle(self):
        carol = await self.login("carol")
        await self.alice.send(type="voice_offer", to=carol.id, sdp=OFFER)
        await carol.nothing("voice_offer")
        await carol.send(type="voice_offer", to=self.alice.id, sdp=OFFER)
        await self.alice.nothing("voice_offer")

    async def test_bad_notes_are_dropped(self):
        too_big = {"type": "offer", "sdp": "x" * 20_000}
        await self.bob.send(type="voice_offer", to=self.alice.id, sdp=too_big)
        await self.bob.send(type="voice_offer", to=self.alice.id, sdp=ANSWER)  # an answer sent as an offer
        await self.bob.send(type="voice_ice", to=self.alice.id, candidate={"candidate": 5})
        await self.alice.nothing("voice_offer")
        await self.alice.nothing("voice_ice")
