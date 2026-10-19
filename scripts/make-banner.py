"""The README's banner: the logo, the name and two phones showing the app, in a light and a dark version.

  uv run --with playwright python scripts/make-banner.py     # after scripts/make-demo.sh made docs/screens/

Writes docs/banner-light.png and docs/banner-dark.png (GitHub shows the one matching the visitor's theme).
"""

import base64
from pathlib import Path

from playwright.sync_api import sync_playwright

DOCS = Path(__file__).resolve().parent.parent / "docs"
THEMES = {  # the app's tokens (web/src/styles.css)
    "light": {"bg": "#f6f5f2", "text": "#1c1b19", "muted": "#6f6c66", "line": "rgba(28,27,25,.1)", "accent": "#1f7a5a",
              "contrast": "#ffffff", "ai": "#6b4fd8", "ai2": "#2f7fd9"},
    "dark": {"bg": "#121211", "text": "#ecebe8", "muted": "#9a978f", "line": "rgba(236,235,232,.1)", "accent": "#4cc391",
             "contrast": "#0d2a1e", "ai": "#a996ff", "ai2": "#6cb4ff"},
}
LOGO = """<svg viewBox="0 0 64 64"><defs><clipPath id="c"><circle cx="32" cy="32" r="30"/></clipPath></defs>
  <circle cx="32" cy="32" r="30" fill="var(--accent)"/>
  <path clip-path="url(#c)" d="M0 39 C10 33 22 33 32 39 S54 45 64 39 V64 H0Z" fill="var(--contrast)"/>
  <path d="M7 28 C15 23.5 24 23.5 32 28 S49 32.5 57 28" fill="none" stroke="var(--contrast)" stroke-opacity=".45" stroke-width="3.2" stroke-linecap="round"/></svg>"""


def page(theme: str) -> str:
    t = THEMES[theme]
    tokens = ";".join(f"--{k}:{v}" for k, v in t.items())
    # Inlined: a page set from a string may not read file:// images.
    shot = lambda name: "data:image/png;base64," + base64.b64encode((DOCS / "screens" / f"{name}-{theme}.png").read_bytes()).decode()
    return f"""<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {{ {tokens} }}
html, body {{ margin: 0; background: transparent; }}
.b {{ position: relative; width: 1280px; height: 440px; overflow: hidden; border-radius: 28px; background: var(--bg);
  font-family: Inter, sans-serif; color: var(--text); isolation: isolate; }}
.sky i {{ position: absolute; border-radius: 50%; filter: blur(80px); opacity: .24; z-index: -2; }}
.sky i:nth-child(1) {{ width: 620px; height: 620px; background: var(--accent); top: -330px; left: -200px; }}
.sky i:nth-child(2) {{ width: 620px; height: 620px; background: var(--ai); bottom: -380px; right: -120px; }}
.sky i:nth-child(3) {{ width: 380px; height: 380px; background: var(--ai2); top: 120px; left: 520px; opacity: .12; }}
.dots {{ position: absolute; inset: 0; z-index: -1; background: radial-gradient(color-mix(in srgb, var(--text) 16%, transparent) 1.2px, transparent 1.8px) 0 0 / 24px 24px;
  -webkit-mask: radial-gradient(ellipse 45% 70% at 28% 50%, #000 15%, transparent 75%); }}
.brand {{ position: absolute; left: 88px; top: 50%; transform: translateY(-50%); width: 560px; }}
.row {{ display: flex; align-items: center; gap: 22px; }}
.row svg {{ width: 96px; height: 96px; filter: drop-shadow(0 14px 40px color-mix(in srgb, var(--accent) 45%, transparent)); }}
.word {{ font-size: 92px; font-weight: 600; letter-spacing: -3.5px; line-height: 1; }}
.tag {{ margin-top: 26px; font-size: 27px; line-height: 1.35; color: var(--muted); letter-spacing: -.3px; }}
.phones {{ position: absolute; right: 70px; top: 40px; display: flex; gap: 26px; transform: rotate(-7deg); }}
.phones img {{ width: 230px; border-radius: 34px; box-shadow: 0 0 0 6px #0b0b0b, 0 30px 70px rgba(0,0,0,.35); }}
.phones img:nth-child(2) {{ margin-top: 70px; }}
</style></head><body>
<div class="b"><div class="sky"><i></i><i></i><i></i></div><div class="dots"></div>
  <div class="brand"><div class="row">{LOGO}<span class="word">ebby</span></div>
    <div class="tag">Every bank you use, in one place,<br>and where the money actually went.</div></div>
  <div class="phones"><img src="{shot('overview')}"><img src="{shot('spending')}"></div>
</div></body></html>"""


with sync_playwright() as p:
    browser = p.chromium.launch()
    for theme in THEMES:
        tab = browser.new_page(viewport={"width": 1280, "height": 440}, device_scale_factor=2)
        tab.set_content(page(theme), wait_until="networkidle")
        tab.locator(".b").screenshot(path=str(DOCS / f"banner-{theme}.png"), omit_background=True)
        tab.close()
    browser.close()
print("wrote docs/banner-light.png, docs/banner-dark.png")
