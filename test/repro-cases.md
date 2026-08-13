# Repro cases

Observed flicker, kept verbatim so a scenario in `replay.mjs` can be traced
back to the thing it was written for. Each entry records what was actually
seen, separately from what was inferred — these are intermittent and the
inference is usually the weaker half.

## 2026-08-12 — churn on an already-loaded post (v1.3)

**Page:** <https://x.com/demi_hl/status/2087421605005668439>

A post whose body opens with a `t.co` link to an OpenSea collection, rendered
as a link card. The tab title is therefore
`demi on X: "https://t.co/a5glrXMgOp art on hyperliquid. …"` — a title that
contains a URL, which matters when reading the report below.

**Environment:** Google Chrome on Omarchy (Arch Linux + Hyprland, Wayland),
extension v1.2.0 installed and active.

**Observed:** the post had been open and idle for some time — not freshly
navigated to. Moving the mouse over the post made the URL bar flicker. Whether
it was the address bar or the tab title is *not* certain; the report was "the
url bar url starts flickering! or was it the title of the tab? i don't really
remember now". Both are plausible: the tab title for this post begins with a
`https://t.co/…` URL, so title churn on this particular post looks like URL
churn at a glance.

**Not reproducible on demand.** After switching away to another window and
back, hovering no longer triggered it.

**What v1.2.0 predicts, and why it matches:** layer 3's settling window opens
only on a navigation and closes 1.5s after churn stops, so a post that has been
open for minutes is back on the v1.1 timings — `QUIET_MS` 150ms, and layer 1
holding nothing but flips to bare root. Churn arriving *then*, spaced wider than
150ms and passing through non-root URLs, is filtered by nothing at all. That is
the same hole v1.2.0 closed for the post-navigation window, still open
everywhere else. The "went away on second try" detail fits too: whatever the
hover kicked off was slower the first time (cold), and churn spaced tighter than
150ms is already coalesced by layer 2.

**What is still unverified:** what x.com does on hover that ends in a history
or title write. Hovering a link normally paints Chrome's status bubble at the
bottom left and touches neither the address bar nor the title, so the trigger
here is something else — a hover card, a link-card render, a prefetch that
settles into `replaceState`. Nobody has captured the sequence. v1.3 adds the
always-on ring buffer precisely so that next time the answer survives:

    __uft.dump()    // last ~400 decisions, no reload needed
    __uft.state()   // is the settling window open right now?

**Fix (v1.3):** layer 4, idle churn detection. Two unattended changes within
`SETTLE_QUIET_MS` of each other reopen the settling window, so a burst on a
long-idle page is tamed by layers 1-3 the same as one after a navigation.
Covered by scenarios 13-15 in `replay.mjs`. Note the residual: the *first*
change of such a burst can still move the URL bar once, because the alternative
is holding every lone change on an idle page, which layer 3 was deliberately
scoped not to do.
