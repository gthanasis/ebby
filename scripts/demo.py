"""Screenshots and the demo video, from the running app with the made-up demo data (app/demo.py).

Run by scripts/make-demo.sh, which seeds the demo database and starts the app first.
  python scripts/demo.py URL OUT_DIR
Writes OUT_DIR/screens/*.png (phone size, dark and light) and OUT_DIR/raw.webm (the walkthrough).
"""

import sys
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

URL, OUT = sys.argv[1].rstrip("/"), Path(sys.argv[2])
PHONE = {"width": 402, "height": 874}  # iPhone 17 Pro, in CSS pixels
SCREENS = [("login", "#/login", 2.6), ("overview", "#/home", 1.2), ("spending", "#/spending", 1.2),
           ("goals", "#/goals", 1.2), ("settings", "#/settings", 1.0)]


def go(page: Page, hash_: str, settle: float):
    page.goto(f"{URL}/{hash_}")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(settle * 1000)


def screens(p):
    for theme in ("dark", "light"):
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport=PHONE, device_scale_factor=3, color_scheme=theme, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        for name, hash_, settle in SCREENS:
            go(page, hash_, settle)
            page.screenshot(path=OUT / "screens" / f"{name}-{theme}.png")
        browser.close()


def slow_scroll(page: Page, pixels: int, steps: int = 40):
    for _ in range(steps):
        page.mouse.wheel(0, pixels / steps)
        page.wait_for_timeout(30)


def video(p):
    """About 35 seconds: sign-in screen, the month at a glance, where it went, a category, goals, connecting a bank."""
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport=PHONE, device_scale_factor=2, color_scheme="dark", is_mobile=True, has_touch=True,
                              record_video_dir=str(OUT / "video"), record_video_size=PHONE)
    page = ctx.new_page()
    go(page, "#/login", 4.5)
    go(page, "#/home", 2.0)
    slow_scroll(page, 700)
    page.wait_for_timeout(1800)
    go(page, "#/spending", 2.2)
    page.get_by_role("tab", name="Categories").click()
    page.wait_for_timeout(1500)
    slow_scroll(page, 500)
    page.wait_for_timeout(1000)
    page.locator("a.part", has_text="Delivery").first.click()
    page.wait_for_timeout(2500)
    go(page, "#/goals", 2.5)
    slow_scroll(page, 600)
    page.wait_for_timeout(1500)
    go(page, "#/accounts", 1.5)
    search = page.get_by_placeholder("Search banks, e.g. Piraeus")
    search.scroll_into_view_if_needed()
    page.wait_for_timeout(600)
    search.click()
    search.press_sequentially("pir", delay=180)
    page.wait_for_timeout(3500)
    raw = page.video.path()
    ctx.close()
    browser.close()
    Path(raw).replace(OUT / "raw.webm")


if __name__ == "__main__":
    (OUT / "screens").mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        screens(p)
        video(p)
    print("wrote", OUT)
