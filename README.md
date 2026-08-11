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
`History.prototype.pushState` / `replaceState`:

1. Changes to any deep URL (post, profile, …) apply immediately.
2. A flip to bare `/` or `/home` is held for 400ms:
   - if the next call goes back to a deep URL (the flicker pattern),
     the held flip is dropped — the URL bar never moves;
   - if nothing follows, it applies late (a genuine navigation home; the
     brief URL bar lag is imperceptible since page content isn't delayed).
3. The tab title gets the same treatment: `document.title` changes to the
   generic app title ("X", "Home / X") while a specific title is showing
   are held and dropped if a specific title follows — this kills the
   matching tab-text flicker.

Safety nets: while a change is held, `history.state` reports the state the
page thinks it set; held changes are force-flushed on `popstate`/`pagehide`.

## Privacy

No data collection, no network requests, no storage, no remote code.
Runs only on `x.com` and `twitter.com`.

## Development

Load unpacked via `chrome://extensions` (Developer mode). The one tunable
at the top of `tamer.js` is `HOLD_MS` (how long a suspicious change is held
while waiting for the reversal that marks it as churn).

Not affiliated with X Corp.
