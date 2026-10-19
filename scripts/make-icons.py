"""The app icons in web/public/icons, drawn from ebby's mark (web/src/components/Logo.tsx).

  uv run --with playwright python scripts/make-icons.py

The coin, with transparent corners, for the favicon and the plain manifest icons. A full square for
the iPhone home screen and Android's maskable icon, which the phone rounds itself.
"""

from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent.parent / "web/public/icons"
GREEN, WATER = "#1f7a5a", "#f6f5f2"  # the light theme's accent, and the paper colour of the old bars

COIN = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><clipPath id="c"><circle cx="32" cy="32" r="30"/></clipPath></defs>
  <circle cx="32" cy="32" r="30" fill="{GREEN}"/>
  <path clip-path="url(#c)" d="M0 39 C10 33 22 33 32 39 S54 45 64 39 V64 H0Z" fill="{WATER}"/>
  <path d="M7 28 C15 23.5 24 23.5 32 28 S49 32.5 57 28" fill="none" stroke="{WATER}" stroke-opacity=".45" stroke-width="3.2" stroke-linecap="round"/>
</svg>"""

# Full bleed: the water runs edge to edge and sits inside Android's 80% safe zone where it matters.
SQUARE = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="{GREEN}"/>
  <path d="M0 40 C10 34 22 34 32 40 S54 46 64 40 V64 H0Z" fill="{WATER}"/>
  <path d="M10 29 C17 25 25 25 32 29 S47 33 54 29" fill="none" stroke="{WATER}" stroke-opacity=".45" stroke-width="2.8" stroke-linecap="round"/>
</svg>"""

ICONS = [("favicon.png", COIN, 64), ("icon-192.png", COIN, 192), ("icon-512.png", COIN, 512),
         ("apple-touch-icon.png", SQUARE, 180), ("icon-maskable-512.png", SQUARE, 512)]

with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, svg, size in ICONS:
        page = browser.new_page(viewport={"width": size, "height": size})
        page.set_content(f'<style>html,body{{margin:0;background:transparent}}svg{{display:block;width:{size}px;height:{size}px}}</style>{svg}')
        page.locator("svg").screenshot(path=str(OUT / name), omit_background=True)
        page.close()
    browser.close()
print("wrote", ", ".join(n for n, _, _ in ICONS))
