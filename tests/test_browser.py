"""
Tests in a real browser: two people, each in their own Chrome window, using
the actual page (frontend/). They check what the server tests can't: that the
page shows the right thing, and that WebRTC audio really flows.

Needs Playwright (pip install playwright, then: playwright install chromium,
or have Google Chrome installed). Without it, these tests are skipped.
To skip them on purpose (they take about a minute): set SKIP_BROWSER=1.
"""
import functools
import http.server
import os
import threading
import unittest

from helpers import ROOT, ServerTestCase, db, PASSWORD

try:
    from playwright.async_api import async_playwright
except ImportError:
    async_playwright = None

FRONTEND = ROOT / "frontend"
_http = None  # one small web server for the page, shared by all the tests here


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Serves the page's files without printing a line for each one."""
    def log_message(self, *args):
        pass


def setUpModule():
    global _http
    if async_playwright is None or os.environ.get("SKIP_BROWSER"):
        return
    handler = functools.partial(QuietHandler, directory=str(FRONTEND))
    _http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=_http.serve_forever, daemon=True).start()


def tearDownModule():
    if _http:
        _http.shutdown()


@unittest.skipIf(async_playwright is None, "Playwright isn't installed (pip install playwright)")
@unittest.skipIf(os.environ.get("SKIP_BROWSER"), "SKIP_BROWSER is set")
class BrowserTestCase(ServerTestCase):
    """A fresh server, plus a browser that can open the page as different people."""

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.pw = await async_playwright().start()
        # A fake microphone (Chrome plays a beep) and no "allow the mic?" question.
        args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                "--autoplay-policy=no-user-gesture-required"]
        self.browser = None
        for channel in ("chrome", None):  # installed Chrome, else Playwright's own Chromium
            try:
                self.browser = await self.pw.chromium.launch(channel=channel, args=args)
                break
            except Exception:
                continue
        if self.browser is None:
            await self.pw.stop()
            self.skipTest("No browser found: install Chrome, or run: playwright install chromium")
        self.page_url = f"http://127.0.0.1:{_http.server_address[1]}/index.html"

    async def asyncTearDown(self):
        await self.browser.close()
        await self.pw.stop()
        await super().asyncTearDown()

    async def open_page(self, name):
        """A new browser window, logged in as `name`, in #general."""
        context = await self.browser.new_context(viewport={"width": 1300, "height": 800})
        await context.grant_permissions(["microphone"])
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        self.addCleanup(lambda: self.assertEqual(errors, [], f"JavaScript errors in {name}'s page"))

        # The page connects to ws://localhost:8765 (your real server). Point
        # this copy at the test server instead, without changing the file.
        async def to_test_server(route):
            response = await route.fetch()
            body = (await response.text()).replace("ws://localhost:8765", self.url)
            await route.fulfill(response=response, body=body)
        await page.route("**/js/connection.js", to_test_server)

        await page.goto(self.page_url)
        await page.fill("#username", name)
        await page.fill("#password", PASSWORD)
        await page.click("#login-submit")
        await page.wait_for_function("!document.getElementById('send').disabled")
        return page

    async def say(self, page, text):
        await page.fill("#text", text)
        await page.click("#send")


class VoiceInBrowserTests(BrowserTestCase):

    async def test_two_people_talk_on_the_board(self):
        alice, bob = await self.open_page("alice"), await self.open_page("bob")

        # Alice starts a huddle from the board's Talk button.
        await alice.click("#board-btn")
        await alice.click("#voice-btn")
        await alice.wait_for_selector("#voice-bar.in-call")

        # Bob is invited by the green bar, and joining opens his board.
        await bob.wait_for_selector("#voice-join:not(.hidden)")
        self.assertIn("alice is talking", await bob.text_content("#voice-text"))
        await bob.click("#voice-join")
        await bob.wait_for_selector("#voice-bar.in-call")
        self.assertTrue(await bob.is_visible("#board-panel"))

        # Both are connected (no one still "connecting"), and audio arrives:
        # the other person's fake-mic beep lights their speaking ring.
        for page, other in ((alice, "2"), (bob, "1")):
            await page.bring_to_front()
            await page.wait_for_function(
                "document.querySelectorAll('#voice-people .voice-chip').length === 2"
                " && !document.querySelector('#voice-people .voice-chip.connecting')", timeout=15_000)
            await page.wait_for_selector(f'#voice-people .voice-chip.speaking[data-id="{other}"]', timeout=10_000)

        # Mute shows on the other side; leaving leaves Bob waiting alone.
        await alice.click("#voice-mute")
        await bob.wait_for_selector('#voice-people .voice-chip[data-id="1"] svg')
        await alice.click("#voice-leave")
        await bob.wait_for_function("document.querySelectorAll('#voice-people .voice-chip').length === 1")
        await alice.wait_for_selector("#voice-join:not(.hidden)")

        # Bob closes his tab: the huddle is over, and Alice's bar goes away.
        await bob.close()
        await alice.wait_for_selector("#voice-bar.hidden", state="attached", timeout=5_000)


class DeleteInBrowserTests(BrowserTestCase):

    async def test_bin_only_on_my_own_messages(self):
        alice, bob = await self.open_page("alice"), await self.open_page("bob")
        await self.say(alice, "from alice")
        await self.say(bob, "from bob")
        await bob.wait_for_selector("text=from alice")
        self.assertEqual(await bob.locator(".row .delete-btn").count(), 1)

    async def test_deleted_message_shows_a_placeholder_live_and_after_reload(self):
        alice, bob = await self.open_page("alice"), await self.open_page("bob")
        await self.say(alice, "Oops, wrong room")
        await bob.wait_for_selector("text=Oops, wrong room")
        row = alice.locator(".row.mine").last
        await row.hover()
        alice.once("dialog", lambda dialog: dialog.accept())
        await row.locator(".delete-btn").click()
        await bob.wait_for_selector(".bubble.deleted")
        self.assertFalse(await bob.is_visible("text=Oops, wrong room"))
        await bob.reload()
        await bob.wait_for_selector(".bubble.deleted")  # from the history this time

    async def test_cancelling_keeps_the_message(self):
        alice, bob = await self.open_page("alice"), await self.open_page("bob")
        await self.say(alice, "Keep this one")
        row = alice.locator(".row.mine").last
        await row.hover()
        alice.once("dialog", lambda dialog: dialog.dismiss())
        await row.locator(".delete-btn").click()
        await alice.wait_for_timeout(500)
        self.assertTrue(await bob.is_visible("text=Keep this one"))


class BoardInBrowserTests(BrowserTestCase):

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.alice, self.bob = await self.open_page("alice"), await self.open_page("bob")
        for page in (self.alice, self.bob):
            await page.click("#board-btn")
        await self.alice.wait_for_timeout(400)
        self.box = await self.alice.locator("#board-canvas").bounding_box()

    async def drag(self, x0, y0, x1, y1, steps=10, pause=0):
        page = self.alice
        await page.mouse.move(x0, y0)
        await page.mouse.down()
        for i in range(1, steps + 1):
            await page.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)
            if pause:
                await page.wait_for_timeout(pause)

    async def draw(self, shape, x0, y0, x1, y1):
        await self.alice.click("#shape-btn")
        await self.alice.click(f'[data-shape="{shape}"]')
        await self.drag(x0, y0, x1, y1)
        await self.alice.mouse.up()
        await self.alice.wait_for_timeout(400)
        return db.get_strokes("general")[-1]

    async def test_the_server_is_new_enough(self):
        self.assertNotIn("older", await self.alice.text_content("#board-note"))

    async def test_moving_is_shown_live_and_saved_on_drop(self):
        x, y = self.box["x"] + 150, self.box["y"] + 200
        rect = await self.draw("rect", x, y, x + 120, y + 80)
        await self.alice.click('[data-tool="select"]')
        await self.drag(x + 60, y + 40, x + 160, y + 90, pause=60)  # still holding the mouse
        await self.alice.wait_for_timeout(200)
        self.assertEqual(db.get_stroke("general", rect["id"])["points"], rect["points"], "saved only on drop")
        await self.alice.mouse.up()
        await self.alice.wait_for_timeout(500)
        moved = db.get_stroke("general", rect["id"])["points"]
        self.assertGreater(moved[0], rect["points"][0])
        self.assertEqual(moved[2] - moved[0], rect["points"][2] - rect["points"][0], "same width: moved as one piece")

    async def test_delete_key_removes_the_selected_shape(self):
        x, y = self.box["x"] + 150, self.box["y"] + 200
        await self.draw("rect", x, y, x + 120, y + 80)
        await self.alice.click('[data-tool="select"]')
        await self.alice.mouse.click(x + 60, y + 40)
        await self.alice.keyboard.press("Delete")
        await self.alice.wait_for_timeout(400)
        self.assertEqual(db.get_strokes("general"), [])

    async def test_drawing_lands_in_the_right_place_when_zoomed(self):
        # The same mouse drag at ~195% makes a line ~1.95x shorter in board units.
        mx, my = self.box["x"] + self.box["width"] / 2, self.box["y"] + self.box["height"] / 2
        line1 = await self.draw("line", mx - 50, my, mx + 50, my)
        for _ in range(3):
            await self.alice.click("#zoom-in")  # 1.25 ** 3 = 1.95
        self.assertEqual(await self.alice.text_content("#zoom-reset"), "195%")
        line2 = await self.draw("line", mx - 50, my + 40, mx + 50, my + 40)
        ratio = abs(line1["points"][2] - line1["points"][0]) / abs(line2["points"][2] - line2["points"][0])
        self.assertAlmostEqual(ratio, 1.953, delta=0.1)

    async def test_zoom_is_only_on_my_screen(self):
        await self.alice.click("#zoom-in")
        self.assertEqual(await self.alice.text_content("#zoom-reset"), "125%")
        self.assertEqual(await self.bob.text_content("#zoom-reset"), "100%")
        await self.alice.click("#zoom-reset")
        self.assertEqual(await self.alice.text_content("#zoom-reset"), "100%")
