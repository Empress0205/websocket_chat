"""The drawing board: drawing, erasing, and moving strokes (the server's half)."""
from helpers import ServerTestCase, db, server


class BoardTestCase(ServerTestCase):
    """Alice and Bob, both with the general room's board open."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.alice, self.bob = await self.login("alice"), await self.login("bob")
        for c in (self.alice, self.bob):
            await c.send(type="board_open", room="general")
            await c.wait("board_state")

    async def draw_rect(self, points=(100, 100, 300, 200)):
        """Alice draws a rectangle in one go; returns the saved stroke."""
        await self.alice.send(type="board_draw", sid="s1", tool="rect", color="blue", points=list(points), done=True)
        return (await self.alice.wait("board_saved"))["stroke"]


class BoardTests(BoardTestCase):

    async def test_a_finished_shape_is_saved_and_shared(self):
        stroke = await self.draw_rect()
        self.assertEqual(stroke["points"], [100, 100, 300, 200])
        saved = await self.bob.wait("board_saved")
        self.assertEqual(saved["stroke"]["id"], stroke["id"])

    async def test_erase_removes_it_for_everyone(self):
        stroke = await self.draw_rect()
        await self.bob.send(type="board_erase", stroke=stroke["id"])
        removed = await self.alice.wait("board_removed")
        self.assertEqual(removed["ids"], [stroke["id"]])
        self.assertEqual(db.get_strokes("general"), [])

    async def test_dragging_is_shown_live_but_not_saved(self):
        stroke = await self.draw_rect()
        await self.alice.send(type="board_move", stroke=stroke["id"], dx=40, dy=20)
        moving = await self.bob.wait("board_moving")
        self.assertEqual((moving["stroke"], moving["dx"], moving["dy"], moving["id"]),
                         (stroke["id"], 40, 20, self.alice.id))
        await self.alice.nothing("board_moving")  # not echoed back to the person dragging
        self.assertEqual(db.get_stroke("general", stroke["id"])["points"], [100, 100, 300, 200])

    async def test_dropping_saves_the_new_place(self):
        stroke = await self.draw_rect()
        await self.alice.send(type="board_move", stroke=stroke["id"], dx=40, dy=20, done=True)
        for c in (self.alice, self.bob):
            moved = await c.wait("board_moved")
            self.assertEqual(moved["stroke"]["points"], [140, 120, 340, 220])
        self.assertEqual(db.get_stroke("general", stroke["id"])["points"], [140, 120, 340, 220])

    async def test_a_stroke_stops_at_the_edge_without_changing_shape(self):
        stroke = await self.draw_rect()
        await self.alice.send(type="board_move", stroke=stroke["id"], dx=-500, dy=0, done=True)
        moved = await self.alice.wait("board_moved")
        self.assertEqual(moved["stroke"]["points"], [0, 100, 200, 200])

    async def test_moving_an_erased_stroke_drops_the_preview(self):
        stroke = await self.draw_rect()
        await self.bob.send(type="board_erase", stroke=stroke["id"])
        await self.alice.wait("board_removed")
        await self.alice.send(type="board_move", stroke=stroke["id"], dx=10, dy=10, done=True)
        moved = await self.bob.wait("board_moved")
        self.assertIsNone(moved["stroke"])

    async def test_bad_moves_are_ignored(self):
        stroke = await self.draw_rect()
        for bad in ({"dx": 1.5, "dy": 0}, {"dx": True, "dy": 0}, {"dx": 99_999, "dy": 0}, {"dx": "5", "dy": 0}):
            await self.alice.send(type="board_move", stroke=stroke["id"], done=True, **bad)
        await self.bob.send(type="board_move", stroke="1", dx=5, dy=5, done=True)
        await self.alice.nothing("board_moved")
        self.assertEqual(db.get_stroke("general", stroke["id"])["points"], [100, 100, 300, 200])

    async def test_the_page_is_told_the_board_version(self):
        # The page warns "restart the server" when this is older than it expects.
        await self.alice.send(type="board_open", room="general")
        state = await self.alice.wait("board_state")
        self.assertGreaterEqual(state["version"], 4)


class UndoClearTests(BoardTestCase):
    """Undoing a Clear: the board comes back, for a few seconds, for the one who cleared it."""

    async def clear(self, who=None):
        await (who or self.alice).send(type="board_clear")
        return await self.bob.wait("board_cleared")

    async def test_undo_brings_the_board_back_for_everyone(self):
        first = await self.draw_rect()
        second = await self.draw_rect((400, 400, 500, 500))
        cleared = await self.clear()
        self.assertEqual((cleared["id"], cleared["undo"]), (self.alice.id, 15))
        self.assertEqual(db.get_strokes("general"), [])

        await self.alice.send(type="board_clear_undo")
        for c in (self.alice, self.bob):
            restored = await c.wait("board_restored")
            self.assertEqual([s["id"] for s in restored["strokes"]], [first["id"], second["id"]])
            self.assertEqual(restored["by"], "alice")
        self.assertEqual(db.get_strokes("general"), [first, second])  # same ids, points and order

    async def test_only_the_person_who_cleared_can_undo(self):
        await self.draw_rect()
        await self.clear()
        await self.bob.send(type="board_clear_undo")
        await self.bob.wait("error")
        await self.alice.nothing("board_restored")
        self.assertEqual(db.get_strokes("general"), [])

    async def test_it_is_too_late_after_a_few_seconds(self):
        await self.draw_rect()
        await self.clear()
        server.cleared_boards["general"]["at"] -= 16  # as if 16 seconds went by
        await self.alice.send(type="board_clear_undo")
        error = await self.alice.wait("error")
        self.assertIn("too late", error["text"])
        self.assertEqual(db.get_strokes("general"), [])

    async def test_it_only_works_once(self):
        await self.draw_rect()
        await self.clear()
        await self.alice.send(type="board_clear_undo")
        await self.alice.wait("board_restored")
        await self.alice.send(type="board_clear_undo")
        await self.alice.wait("error")
        self.assertEqual(len(db.get_strokes("general")), 1)  # not put back twice

    async def test_drawing_since_the_clear_stays_on_top(self):
        old = await self.draw_rect()
        await self.clear()
        new = await self.draw_rect((600, 600, 700, 700))
        await self.alice.send(type="board_clear_undo")
        await self.alice.wait("board_restored")
        self.assertEqual([s["id"] for s in db.get_strokes("general")], [old["id"], new["id"]])

    async def test_clearing_an_empty_board_offers_no_undo(self):
        cleared = await self.clear()
        self.assertEqual(cleared["undo"], 0)

    async def test_a_newer_clear_by_someone_else_replaces_it(self):
        await self.draw_rect()
        await self.clear()
        await self.alice.send(type="board_clear_undo")
        await self.alice.wait("board_restored")
        await self.clear(self.bob)  # bob clears it again: now only bob can undo
        await self.alice.send(type="board_clear_undo")
        await self.alice.wait("error")
        await self.bob.send(type="board_clear_undo")
        await self.bob.wait("board_restored")
