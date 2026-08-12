# URL Flicker Tamer for X

Stops the Chrome address bar flickering between a post URL and bare `x.com`
while x.com loads. The site's own router calls
`history.replaceState`/`pushState` repeatedly during app hydration; on
machines where hydration is slow enough to paint the intermediate states,
the URL bar visibly ping-pongs. This extension filters out that churn.

## Motivation

This was built to fix a flicker observed running **Google Chrome on
[Omarchy](https://omarchy.org/)** (Arch Linux + Hyprland, Wayland): opening
an x.com post — e.g. `x.com/<user>/status/<id>` — made the URL bar bounce
between the post URL and bare `x.com` several times before settling. The
same setup on macOS didn't show it.

The root cause isn't Omarchy, Linux, or Chrome — a clean profile shows
x.com's router firing the same `replaceState` sequence everywhere. It's a
visibility race: the intermediate URL states only get painted when the
page's JavaScript hydration is slow enough (slower single-core CPU, Linux
rendering path, extensions injecting into the page). Faster machines finish
the dance before the address bar repaints, so users never see it. So if
you're seeing URL bar flicker on x.com on any slower or Linux machine —
Omarchy, other Arch/Hyprland setups, or anything else — this extension is
the workaround: it intercepts the churn before the URL bar ever moves.

## How it works

A content script runs at `document_start` in the page's main world and wraps
`History.prototype.pushState` / `replaceState`, applying two layers.

**Layer 1 — ping-pong rule.** Catches the visible URL bar bounce:

1. A flip to bare `/` or `/home` is held for 400ms:
   - if the next call goes back to a deep URL (the flicker pattern),
     the held flip is dropped — the URL bar never moves;
   - if nothing follows, it applies late (a genuine navigation home; the
     brief URL bar lag is imperceptible since page content isn't delayed).
2. The tab title gets the same treatment: `document.title` changes to the
   generic app title ("X", "Home / X") while a specific title is showing
   are held and dropped if a specific title follows — this kills the
   matching tab-text flicker.

**Layer 2 — burst coalescing.** Every remaining `replaceState` (and title
write) is debounced by 150ms, so a rapid volley collapses into a single
native call once it goes quiet, with a 500ms ceiling so a router that never
stops churning still makes progress rather than starving.

`pushState` is deliberately exempt from layer 2 — each call creates a
session-history entry, so coalescing or reordering them would cost the back
button its stops. A `pushState` flushes any held `replaceState` first, then
applies immediately, preserving the original order.

### Why layer 2 exists

Layer 1 fixed what you could see in the URL bar, but each native history or
title call also fires `chrome.tabs.onUpdated` in *every* installed extension,
and extensions routinely respond by re-setting their toolbar icon or badge. A
hydration volley therefore made the whole Chrome toolbar icon row repaint in
lockstep — flicker in a completely unrelated part of the browser, from the
same root cause. Cutting the event storm at the source fixes it without
touching anyone else's extension.

Measured on a replayed hydration volley, layer 2 takes the native calls from
3 → 1 (history) and 2 → 1 (title); on a sustained 40-call storm, 40 → 4.

Safety nets: while a change is held, `history.state` and `document.title`
report what the page thinks it set; held changes are force-flushed on
`popstate`/`pagehide`.

## Privacy

No data collection, no network requests, no storage, no remote code.
Runs only on `x.com` and `twitter.com`.

## Development

Load unpacked via `chrome://extensions` (Developer mode). The tunables at the
top of `tamer.js`:

- `HOLD_MS` (400) — how long a flip-to-root is held while waiting for the
  reversal that marks it as churn.
- `QUIET_MS` (150) — silence that marks the end of a burst.
- `MAX_HOLD_MS` (500) — ceiling, so a sustained volley still commits.

Not affiliated with X Corp.
