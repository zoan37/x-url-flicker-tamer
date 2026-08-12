# Chrome Web Store listing — copy-paste material

## Store listing tab

**Title:** URL Flicker Tamer for X

**Summary (max 132 chars):**
Stops the address bar, tab title and toolbar icons flickering while x.com loads. Runs only on x.com; collects no data.

**Detailed description:**

When you open a post on x.com, the site's own code sometimes bounces the
address bar between the post URL and bare "x.com" several times while the
page loads. On slower machines this is visible as annoying URL bar flicker.

URL Flicker Tamer sits between the page and the browser's history API and
filters out that churn:

• A sudden flip to bare x.com with no click or keypress from you is held
  briefly; if the site immediately flips back (the flicker pattern), the
  bounce is discarded and the URL bar never moves.
• The tab title is steadied the same way — no more tab text flashing
  between the page title and "X".
• Rapid bursts of URL changes are collapsed into a single one. Besides the
  address bar, this quiets a knock-on effect: every URL change notifies all
  your installed extensions, many of which redraw their toolbar icon or
  badge in response — which can make the whole toolbar icon row flicker
  while x.com loads.
• Navigation is never blocked: deliberate moves (clicking Home, keyboard
  shortcuts) show in the URL bar within a fraction of a second, page content
  is never delayed at all, and the Back button keeps every one of its stops.

Why this exists: this was built to fix the flicker as seen in Google Chrome
on Omarchy (Arch Linux + Hyprland, Wayland). The flicker shows up wherever
the page loads slowly enough for the intermediate URL changes to be painted
— slower machines, Linux desktops, or profiles with many extensions — while
faster machines (e.g. Apple Silicon Macs) hide it. If your address bar
bounces between a post URL and x.com on Linux or any slower machine, this
is the fix.

Notes:
• Runs only on x.com and twitter.com. No other sites are touched.
• Collects nothing. No analytics, no network requests, no storage. The
  entire extension is one small script you can read in under a minute.
• Not affiliated with, endorsed by, or sponsored by X Corp.

**Category:** Tools (or Accessibility)
**Language:** English

## Privacy tab

**Single purpose description:**
Suppresses spurious address-bar URL changes (flicker) caused by x.com's own
scripts during page load, so the URL bar stays on the page being viewed.

**Permission justifications:**
- Host permission `https://x.com/*`, `https://twitter.com/*` (content script):
  The extension must run a small script on these sites — and only these —
  to intercept the page's own history.pushState/replaceState calls, which
  are the source of the URL bar flicker. No page content is read, stored,
  or transmitted.
- Remote code: none. All code is packaged in the extension.

**Data usage disclosures:** check "Does NOT collect user data" for every
category. No data is collected, sold, or transferred. (With no data
collected, no privacy policy URL is required, but hosting the README on a
public repo and linking it never hurts.)

## Media

- Icon 128x128: icons/icon128.png (uploaded automatically from the ZIP;
  the dev console also asks for it in the listing — same file)
- Screenshot (required, 1280x800): store-assets/screenshot-1280x800.png
- Promo tile (optional, 440x280): skip — not required

## Upload

- ZIP: dist/url-flicker-tamer-1.1.0.zip (contains manifest.json, tamer.js,
  icons/ — store assets and docs are excluded on purpose)
- Console: https://chrome.google.com/webstore/devconsole
  One-time $5 developer registration fee on first use.
- Review usually takes 1–3 days; content-script-only extensions with no
  broad host permissions tend to pass quickly.
