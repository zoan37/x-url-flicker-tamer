# URL Flicker Tamer for X

[**Install from the Chrome Web Store**](https://chromewebstore.google.com/detail/url-flicker-tamer-for-x/dfemkbbkdllddebdecaagfhdcmagiifp)

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
`History.prototype.pushState` / `replaceState`, applying three layers.

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

**Layer 3 — settling window.** Layers 1 and 2 left a narrower version of the
original flicker on slow machines, for two reasons that compound:

- layer 1 only recognises flips to bare root, so any *other* URL the router
  passes through on the way (canonicalisation, `/i/flow/…`, the previous
  page's URL) was never held;
- layer 2 only collapses calls spaced closer than `QUIET_MS` — but the slower
  the machine, the further apart the churn lands, so exactly the machines that
  paint the intermediate states are the ones whose churn outruns the debounce.

Both holes close by widening the question: for a short window after a
navigation, *any* unattended URL or title change is suspect, not just a flip to
root, and the debounce stretches to match the churn's real spacing. The window
opens on a navigation (initial load, `pushState`, `popstate`), extends while
churn keeps arriving, and closes 1.5s after it stops — so an idle page is back
to the tight timings above.

**Layer 4 — idle churn detection.** Layer 3's window opens only on a
navigation, but churn also arrives on a page that settled minutes ago: the
[repro case](test/repro-cases.md) is URL bar flicker while simply reading an
already-open post. Nothing about that churn is different — only the window had
closed, so it fell back to the tight timings and layer 1's root-flip-only rule
and walked straight through.

Two unattended changes landing within `SETTLE_QUIET_MS` of each other are
themselves the evidence that the app has started churning again, so the second
reopens the settling window and layers 1–3 take the rest of the burst. Because
the *first* change of a burst is judged before any such evidence exists, an
unattended change is also coalesced on the churn timescale rather than the idle
one — otherwise it commits before the reversal that would identify it. The cost
is that a lone unattended change (a redirect, a canonicalisation) lands in
350ms rather than 150ms; changes from a user gesture's own task keep the tight
timing. Title writes that land back on the title already displayed are now
dropped outright rather than coalesced: invisible to the user, but each one
still fired `tabs.onUpdated` everywhere.

Changes made from inside a user gesture's own task are exempt and apply
immediately, so clicking a post feels instant. (`navigator.userActivation` is
the wrong signal here — it stays active for seconds, which is precisely the
span the churn happens in, so it would exempt the churn along with the click.)
Flips to root stay held even during a gesture: exempting them leaked in v1.0.1,
because the reversal that identifies the flicker can land arbitrarily late on a
janked main thread.

In every layer, a held change is only dropped when another change supersedes
it — a change nobody contradicts always lands. What a hold costs is URL bar
*text* lag; page content is never blocked by it.

### Measurements

`node test/replay.mjs [path/to/tamer.js]` replays captured hydration churn
against a fake `History`/`Document` on a virtual clock and counts what a user
can actually see: native history calls that move the URL bar, and native title
writes (both also stand in for the `tabs.onUpdated` events every other
installed extension receives). Point it at an older `tamer.js` to compare.

| replayed pattern | v1.1.0 | v1.2.0 | v1.3.0 |
| --- | --- | --- | --- |
| tight volley, 40ms apart | 0 URL bar moves | 0 | 0 |
| slow volley, 250ms apart, non-root intermediates | **3 moves** | **0** | 0 |
| sustained storm, 40 calls | 2 moves, 20 native calls | 0 moves, 1 native call | 0, 1 |
| spaced title churn | 2 native title writes | 1 | 1 |
| churn on a long-idle page, 250ms apart | — | **4 moves** | **0** |
| title churn on a long-idle page | — | **2 writes** | **0** |

The last two rows are the [v1.3 repro case](test/repro-cases.md). Point the
harness at an older `tamer.js` to reproduce the comparison:
`node test/replay.mjs /path/to/old/tamer.js`.

Safety nets: while a change is held, `history.state` and `document.title`
report what the page thinks it set; held changes are force-flushed on
`popstate`/`pagehide`; a held `pushState` that gets superseded is committed
rather than dropped, so the back button keeps its stops.

### Debugging a leak

The last ~400 decisions are always kept in memory, so flicker that has already
happened can still be examined — no reload, which is the point: reloading
destroys the evidence, and this kind of flicker rarely repeats on demand. In
the console on x.com:

```js
__uft.dump()    // every interception, hold, drop and native commit, timestamped
__uft.state()   // is the settling window open right now, and what is held?
```

For a live trace instead, set `localStorage['uft-debug'] = '1'` and reload;
the same records are then also printed to the console as they happen.

The buffer holds URLs and titles from the page you are already looking at. It
is never persisted and never leaves the tab.

## Privacy

No data collection, no network requests, no storage, no remote code.
Runs only on `x.com` and `twitter.com`.

## Development

For the published build, see the [Chrome Web Store
listing](https://chromewebstore.google.com/detail/url-flicker-tamer-for-x/dfemkbbkdllddebdecaagfhdcmagiifp).
To work on it, load unpacked via `chrome://extensions` (Developer mode). The
tunables at the top of `tamer.js`:

- `HOLD_MS` (400) — how long a flip-to-root is held while waiting for the
  reversal that marks it as churn.
- `QUIET_MS` (150) — silence that marks the end of a burst.
- `MAX_HOLD_MS` (500) — ceiling, so a sustained volley still commits.

Those apply to an idle page. While the app is settling after a navigation the
same three widen to `SETTLE_HOLD_MS` (600), `SETTLE_QUIET_MS` (350) and
`SETTLE_MAX_HOLD_MS` (1200), for `SETTLE_MS` (6000) after the navigation,
extended while churn keeps arriving and closed `SETTLE_EXTEND_MS` (1500) after
it stops. `SETTLE_QUIET_MS` doubles as the churn threshold for layer 4: two
unattended changes closer together than this reopen the window, and an
unattended change is coalesced on it rather than on `QUIET_MS`.

If flicker still gets through on a slower machine, `SETTLE_QUIET_MS` is the one
to raise — it has to exceed the spacing of that machine's churn. Raising it also
lengthens how long a lone unattended change waits before it lands, which is the
one thing to watch when tuning it.

New flicker sightings go in [`test/repro-cases.md`](test/repro-cases.md) with a
matching scenario in the replay harness — the ones worth keeping are
intermittent, and the details stop being recoverable within a day.

Run `node test/replay.mjs` after changing any of them.

Not affiliated with X Corp.
