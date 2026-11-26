"""The drawing board: drawing, erasing, and moving strokes (the server's half)."""
from helpers import ServerTestCase, db


class BoardTests(ServerTestCase):

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
        self.assertGreaterEqual(state["version"], 3)
