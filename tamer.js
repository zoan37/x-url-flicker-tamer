// URL Flicker Tamer for X
//
// Originally built to fix URL bar flicker in Google Chrome on Omarchy
// (Arch Linux + Hyprland, Wayland), where opening an x.com post bounced the
// address bar between the post URL and bare x.com. The cause is site-side
// and timing-dependent, so this applies to any machine slow enough to paint
// the intermediate states.
//
// x.com's router calls history.replaceState/pushState repeatedly during app
// hydration, bouncing the URL bar between the post URL and bare x.com. On a
// machine where hydration is slow enough to paint the intermediate states,
// that reads as flicker.
//
// Two layers deal with that churn:
//
//   1. Ping-pong rule (v1.0): when the router flips the URL to "/" or "/home"
//      while we're on a deeper path, hold that change briefly. If the very
//      next call goes back to a deep URL (the flicker pattern), drop the held
//      root change entirely. If nothing follows, it was a genuine navigation
//      home — apply it, just late.
//
//   2. Burst coalescing (v1.1): every remaining replaceState is debounced, so
//      a rapid volley collapses into a single native call once the volley goes
//      quiet. This exists because each native history call also fires
//      chrome.tabs.onUpdated in *every* installed extension, and extensions
//      commonly respond by re-setting their toolbar icon or badge. A hydration
//      volley therefore made the whole Chrome toolbar icon row repaint in
//      lockstep — visible flicker in a completely different part of the
//      browser. Layer 1 hid the symptom in the URL bar; layer 2 cuts the event
//      storm that caused the rest.
//
// Every flip-to-root pays the same HOLD_MS: a genuine "go Home" only has
// its URL bar text (never its page content) lag by the hold, which is
// imperceptible, while a shorter gesture-window hold (tried in v1.0.1)
// proved leaky when the reversal landed late on a janked main thread.
//
// The tab title gets both treatments too: hydration churns document.title
// between the specific page title and the generic app title in lockstep
// with the URL churn, and title changes fire tabs.onUpdated just like URL
// changes do.
(() => {
  'use strict';

  const HOLD_MS = 400; // flip-to-root hold, waiting for the reversal
  const QUIET_MS = 150; // silence that marks the end of a burst
  const MAX_HOLD_MS = 500; // ceiling, so a sustained volley still makes progress

  // A trailing-edge debounce with a hard ceiling. Repeated schedule() calls
  // keep only the newest payload and push the timer out, but never past
  // deadline — so a router that never stops churning still commits every
  // MAX_HOLD_MS instead of being starved forever.
  //
  // Trailing-only, with no leading-edge call: an isolated change is delayed by
  // QUIET_MS, which is invisible for URL bar text (page content is never
  // blocked by this), and it makes a volley collapse to one native call rather
  // than two.
  const makeCoalescer = (apply) => {
    let held = null; // { payload, timer, deadline }

    const flush = () => {
      if (!held) return;
      const h = held;
      held = null;
      clearTimeout(h.timer);
      apply(h.payload);
    };

    const schedule = (payload) => {
      const now = performance.now();
      if (held) clearTimeout(held.timer);
      else held = { payload: null, timer: null, deadline: now + MAX_HOLD_MS };
      held.payload = payload;
      held.timer = setTimeout(flush, Math.max(0, Math.min(QUIET_MS, held.deadline - now)));
    };

    return {
      schedule,
      flush,
      peek: () => (held ? held.payload : undefined),
      isHeld: () => held !== null,
    };
  };

  // --- URL taming -----------------------------------------------------------

  const nativePush = History.prototype.pushState;
  const nativeReplace = History.prototype.replaceState;

  let rootPending = null; // { args, state, timer } — layer 1 (flip-to-root hold)

  // Layer 2. Payload is the replaceState argument list; committing is just the
  // native call we deferred.
  const replaces = makeCoalescer((args) => nativeReplace.apply(history, args));

  const resolveUrl = (args) =>
    args[2] == null ? location.href : new URL(args[2], location.href).href;

  const isBareRoot = (href) => {
    const p = new URL(href).pathname;
    return p === '/' || p === '/home';
  };

  const flushRootPending = () => {
    if (!rootPending) return;
    const p = rootPending;
    rootPending = null;
    clearTimeout(p.timer);
    // Already delayed by HOLD_MS; don't send it around the coalescer again.
    p.native.apply(history, p.args);
  };

  const flushAll = () => {
    // Ordering: when both layers hold something, the coalesced change is always
    // the older one (a flip-to-root returns early, so it can't create a burst
    // after itself), so it has to land first.
    replaces.flush();
    flushRootPending();
  };

  const wrap = (native, isPush) =>
    function (...args) {
      let target;
      try {
        target = resolveUrl(args);
      } catch {
        return native.apply(this, args); // malformed URL: let the native throw
      }

      if (rootPending) {
        // Either the held flip-to-root got reversed (ping-pong — drop it), or
        // another root flip arrived (keep only the newest). Both mean: discard
        // what's held and let the checks below decide about this call.
        clearTimeout(rootPending.timer);
        rootPending = null;
      }

      // Compared against location.href — the URL actually on display — not
      // against anything held, which is exactly the question this rule asks.
      if (isBareRoot(target) && !isBareRoot(location.href)) {
        rootPending = {
          native,
          args,
          state: args[0],
          timer: setTimeout(flushRootPending, HOLD_MS),
        };
        return;
      }

      if (isPush) {
        // pushState creates a session-history entry, so these can be neither
        // coalesced (the back button would lose stops) nor reordered. Flush any
        // held replaceState first so the two land in their original order, then
        // apply immediately.
        replaces.flush();
        return native.apply(this, args);
      }

      return replaces.schedule(args);
    };

  History.prototype.pushState = wrap(nativePush, true);
  History.prototype.replaceState = wrap(nativeReplace, false);

  // If the router reads history.state while a change is held, hand it the
  // state it thinks it just set, so its own bookkeeping stays consistent.
  // rootPending wins when both are held, since it is always the newer one.
  const stateDesc = Object.getOwnPropertyDescriptor(History.prototype, 'state');
  if (stateDesc?.get) {
    Object.defineProperty(History.prototype, 'state', {
      ...stateDesc,
      get() {
        if (rootPending) return rootPending.state;
        if (replaces.isHeld()) return replaces.peek()[0];
        return stateDesc.get.call(this);
      },
    });
  }

  // Never let a held change die silently on back/forward or page teardown.
  addEventListener('popstate', flushAll, true);
  addEventListener('pagehide', flushAll, true);

  // --- Tab title taming -----------------------------------------------------
  // Same two layers as the URL: hold changes TO the generic app title ("X",
  // "Home / X", optionally with an unread-count "(3) " prefix) while a specific
  // title is showing and drop them if a specific title follows; then coalesce
  // whatever survives, since every title write also fires tabs.onUpdated.
  const titleDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
  if (titleDesc?.get && titleDesc?.set) {
    let pendingTitle = null; // { value, timer }

    const titles = makeCoalescer((value) => titleDesc.set.call(document, value));

    const isGenericTitle = (t) => {
      const s = String(t).replace(/^\(\d+\+?\)\s*/, '').trim();
      return s === 'X' || s === 'Home / X' || s === 'X / X';
    };

    const flushTitle = () => {
      if (!pendingTitle) return;
      const p = pendingTitle;
      pendingTitle = null;
      clearTimeout(p.timer);
      titleDesc.set.call(document, p.value);
    };

    const flushAllTitles = () => {
      titles.flush();
      flushTitle();
    };

    Object.defineProperty(Document.prototype, 'title', {
      configurable: true,
      enumerable: titleDesc.enumerable,
      get() {
        // Report the title the page thinks it set, like history.state above.
        if (pendingTitle) return pendingTitle.value;
        if (titles.isHeld()) return titles.peek();
        return titleDesc.get.call(this);
      },
      set(value) {
        if (pendingTitle) {
          clearTimeout(pendingTitle.timer);
          pendingTitle = null;
          if (!isGenericTitle(value)) {
            // Churn reversed: drop the held generic title, show the real one.
            titles.schedule(value);
            return;
          }
        }
        // Compared against the displayed title, for the same reason the URL
        // rule compares against location.href.
        const current = titleDesc.get.call(this);
        if (isGenericTitle(value) && current && !isGenericTitle(current)) {
          pendingTitle = { value, timer: setTimeout(flushTitle, HOLD_MS) };
          return;
        }
        titles.schedule(value);
      },
    });

    addEventListener('popstate', flushAllTitles, true);
    addEventListener('pagehide', flushAllTitles, true);
  }
})();
