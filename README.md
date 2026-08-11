# URL Flicker Tamer for X

Stops the Chrome address bar flickering between a post URL and bare `x.com`
while x.com loads. The site's own router calls
`history.replaceState`/`pushState` repeatedly during app hydration; on
machines where hydration is slow enough to paint the intermediate states,
the URL bar visibly ping-pongs. This extension filters out that churn.

## How it works

A content script runs at `document_start` in the page's main world and wraps
`History.prototype.pushState` / `replaceState`:

1. Changes to any deep URL (post, profile, …) apply immediately.
2. A flip to bare `/` or `/home` within 1s of a user gesture (click,
   keypress, touch) is treated as deliberate and applies immediately.
3. A gesture-less flip to bare `/` or `/home` is held for 400ms:
   - if the next call goes back to a deep URL (the flicker pattern),
     the held flip is dropped — the URL bar never moves;
   - if nothing follows, it applies late (a genuine programmatic redirect).

Safety nets: while a change is held, `history.state` reports the state the
page thinks it set; held changes are force-flushed on `popstate`/`pagehide`.

## Privacy

No data collection, no network requests, no storage, no remote code.
Runs only on `x.com` and `twitter.com`.

## Development

Load unpacked via `chrome://extensions` (Developer mode). Tunables at the
top of `tamer.js`: `HOLD_MS` (hold window) and `GESTURE_MS` (how recent a
gesture must be to count as deliberate).

Not affiliated with X Corp.
