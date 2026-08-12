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
// Three layers deal with that churn:
//
//   1. Ping-pong rule (v1.0): when the router flips the URL to "/" or "/home"
//      while we're on a deeper path, hold that change briefly. If another call
//      supersedes it (the flicker pattern), drop the held change entirely. If
//      nothing follows, it was a genuine navigation home — apply it, just late.
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
//   3. Settling window (v1.2): layers 1 and 2 left a narrower version of the
//      original flicker on slow machines, for two reasons that compound.
//      Layer 1 only recognises flips to bare root, so any *other* URL the
//      router passes through on its way (canonicalisation, /i/flow/..., the
//      previous page's URL) was never held. And layer 2 only collapses calls
//      spaced closer than QUIET_MS — but the slower the machine, the further
//      apart the churn lands, so exactly the machines that paint the
//      intermediate states are the ones whose churn outruns the debounce.
//      Both holes close by widening the question: for a short window after a
//      navigation, treat *any* unattended URL change as suspect, not just a
//      flip to root, and stretch the debounce to match the churn's real
//      spacing. The window opens on a navigation, extends while churn keeps
//      arriving, and closes shortly after it stops, so an idle page is back to
//      the tight v1.1 timings.
//
// Nothing is ever dropped unless another change supersedes it, in any layer —
// a held change that nobody contradicts always lands. The cost of a hold is
// URL bar *text* lag; page content is never blocked by it.
//
// Changes made from inside a user gesture's own task are exempt from the
// settling rule and apply immediately, so clicking a post feels instant. Flips
// to root are held even then: v1.0.1 tried exempting them and it leaked,
// because the reversal that identifies the flicker can land arbitrarily late
// on a janked main thread.
//
// The tab title gets the same treatment: hydration churns document.title
// between the specific page title and the generic app title in lockstep with
// the URL churn, and title changes fire tabs.onUpdated just like URL changes.
//
// Debugging: set localStorage['uft-debug'] = '1' on x.com and reload. Every
// interception, hold, drop and native commit is logged to the console with a
// timestamp, so a leak can be traced to the exact call that moved the URL bar.
(() => {
  'use strict';

  // Idle-page timings: unchanged from v1.1, and deliberately tight.
  const HOLD_MS = 400; // hold on a flip-to-root, waiting for the reversal
  const QUIET_MS = 150; // silence that marks the end of a burst
  const MAX_HOLD_MS = 500; // ceiling, so a sustained volley still makes progress

  // Settling-window timings: churn on a slow main thread is spaced further
  // apart, so every window widens while the app is settling after a navigation.
  const SETTLE_MS = 6000; // how long a navigation is presumed to be settling
  const SETTLE_EXTEND_MS = 1500; // quiet needed to declare settling over
  const SETTLE_HOLD_MS = 600;
  const SETTLE_QUIET_MS = 350;
  const SETTLE_MAX_HOLD_MS = 1200;

  let DEBUG = false;
  try {
    DEBUG = localStorage.getItem('uft-debug') === '1';
  } catch {
    // Storage can be blocked; debug logging is never worth throwing over.
  }
  const log = DEBUG
    ? (...args) => console.debug('[uft]', `${performance.now().toFixed(0)}ms`, ...args)
    : () => {};

  // --- settling window ------------------------------------------------------
  // Open at document_start (the initial load is itself a navigation), reopened
  // by each subsequent navigation, extended by each piece of churn observed
  // while it is open. It is never extended once closed, so an idle page cannot
  // drift back into the wider timings.

  let settleUntil = performance.now() + SETTLE_MS;
  const settling = () => performance.now() < settleUntil;
  const openSettling = () => {
    settleUntil = Math.max(settleUntil, performance.now() + SETTLE_MS);
  };
  const extendSettling = () => {
    if (settling()) settleUntil = performance.now() + SETTLE_EXTEND_MS;
  };

  const holdMs = () => (settling() ? SETTLE_HOLD_MS : HOLD_MS);
  const quietMs = () => (settling() ? SETTLE_QUIET_MS : QUIET_MS);
  const maxHoldMs = () => (settling() ? SETTLE_MAX_HOLD_MS : MAX_HOLD_MS);

  // --- gesture provenance ---------------------------------------------------
  // navigator.userActivation is the wrong tool here: it stays active for
  // seconds, which is precisely the span the churn happens in, so it would
  // exempt the churn along with the click. What distinguishes a navigation from
  // the churn that follows it is that the navigation is made from inside the
  // gesture's own task. The flag is therefore cleared on the next macrotask,
  // which covers the handler and its microtasks and nothing after.

  let inGestureTask = false;
  const markGesture = (event) => {
    if (!event.isTrusted || inGestureTask) return;
    inGestureTask = true;
    setTimeout(() => {
      inGestureTask = false;
    }, 0);
  };
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown', 'touchstart']) {
    addEventListener(type, markGesture, true);
  }

  // A trailing-edge debounce with a hard ceiling. Repeated schedule() calls
  // keep only the newest payload and push the timer out, but never past
  // deadline — so a router that never stops churning still commits every
  // maxHoldMs() instead of being starved forever.
  //
  // Trailing-only, with no leading-edge call: an isolated change is delayed by
  // quietMs(), which is invisible for URL bar text (page content is never
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
      else held = { payload: null, timer: null, deadline: now + maxHoldMs() };
      held.payload = payload;
      held.timer = setTimeout(flush, Math.max(0, Math.min(quietMs(), held.deadline - now)));
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

  let pending = null; // { native, args, state, isPush, timer } — layers 1 and 3

  // Layer 2. Payload is the replaceState argument list; committing is just the
  // native call we deferred.
  const replaces = makeCoalescer((args) => {
    log('commit coalesced replace →', args[2]);
    nativeReplace.apply(history, args);
  });

  const resolveUrl = (args) =>
    args[2] == null ? location.href : new URL(args[2], location.href).href;

  const isBareRoot = (href) => {
    const p = new URL(href).pathname;
    return p === '/' || p === '/home';
  };

  const flushPending = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    log('commit held', p.isPush ? 'push' : 'replace', '→', p.args[2]);
    // Already delayed by holdMs(); don't send it around the coalescer again.
    p.native.apply(history, p.args);
    if (p.isPush) openSettling();
  };

  const dropPending = () => {
    if (!pending) return;
    log('drop held', pending.isPush ? 'push' : 'replace', '→', pending.args[2]);
    clearTimeout(pending.timer);
    pending = null;
  };

  const flushAll = () => {
    // Ordering: a held change always postdates anything sitting in the
    // coalescer, because a hold returns early and so cannot start a burst after
    // itself. The coalesced change therefore has to land first.
    replaces.flush();
    flushPending();
  };

  const wrap = (native, isPush) =>
    function (...args) {
      let target;
      try {
        target = resolveUrl(args);
      } catch {
        return native.apply(this, args); // malformed URL: let the native throw
      }

      if (pending) {
        // The held change has been superseded. Dropping a held replaceState is
        // free — replace semantics mean only the newest one matters. Dropping a
        // held pushState would cost the back button a stop, so it gets committed
        // instead, unless this call is the reversal back to the displayed URL,
        // which cancels it outright.
        if (pending.isPush && target !== location.href) flushPending();
        else dropPending();
      }

      // Compared against location.href — the URL actually on display — not
      // against anything held, which is exactly the question these rules ask.
      const displayed = location.href;
      const rootFlip = isBareRoot(target) && !isBareRoot(displayed);
      const suspect = target !== displayed && (rootFlip || (settling() && !inGestureTask));

      if (suspect) {
        extendSettling();
        log('hold', isPush ? 'push' : 'replace', '→', target, rootFlip ? '(root flip)' : '(settling)');
        pending = {
          native,
          args,
          state: args[0],
          isPush,
          timer: setTimeout(flushPending, holdMs()),
        };
        return;
      }

      if (isPush) {
        // pushState creates a session-history entry, so these can be neither
        // coalesced (the back button would lose stops) nor reordered. Flush any
        // held replaceState first so the two land in their original order, then
        // apply immediately. A push is a navigation, so the app is about to
        // hydrate again: reopen the settling window for the churn that follows.
        replaces.flush();
        log('commit push →', target);
        openSettling();
        return native.apply(this, args);
      }

      extendSettling();
      return replaces.schedule(args);
    };

  History.prototype.pushState = wrap(nativePush, true);
  History.prototype.replaceState = wrap(nativeReplace, false);

  // If the router reads history.state while a change is held, hand it the
  // state it thinks it just set, so its own bookkeeping stays consistent.
  // pending wins when both layers hold something, since it is always the newer.
  const stateDesc = Object.getOwnPropertyDescriptor(History.prototype, 'state');
  if (stateDesc?.get) {
    Object.defineProperty(History.prototype, 'state', {
      ...stateDesc,
      get() {
        if (pending) return pending.state;
        if (replaces.isHeld()) return replaces.peek()[0];
        return stateDesc.get.call(this);
      },
    });
  }

  // Never let a held change die silently on back/forward or page teardown. A
  // popstate is also a navigation, so churn is about to follow it.
  addEventListener(
    'popstate',
    () => {
      flushAll();
      openSettling();
    },
    true
  );
  addEventListener('pagehide', flushAll, true);

  // --- Tab title taming -----------------------------------------------------
  // Same layers as the URL. Outside the settling window only a change to the
  // generic app title ("X", "Home / X", optionally with an unread-count "(3) "
  // prefix) is suspect; inside it, any unattended title change is, since
  // hydration churns between two specific titles as readily as it churns to the
  // generic one. Whatever survives is coalesced, because every title write
  // fires tabs.onUpdated just like a history call.
  const titleDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
  if (titleDesc?.get && titleDesc?.set) {
    let pendingTitle = null; // { value, timer }

    const titles = makeCoalescer((value) => {
      log('commit coalesced title →', value);
      titleDesc.set.call(document, value);
    });

    const isGenericTitle = (t) => {
      const s = String(t).replace(/^\(\d+\+?\)\s*/, '').trim();
      return s === 'X' || s === 'Home / X' || s === 'X / X';
    };

    const flushTitle = () => {
      if (!pendingTitle) return;
      const p = pendingTitle;
      pendingTitle = null;
      clearTimeout(p.timer);
      log('commit held title →', p.value);
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
          // Superseded; the replacement is judged on its own merits below.
          clearTimeout(pendingTitle.timer);
          pendingTitle = null;
        }

        // Compared against the displayed title, for the same reason the URL
        // rules compare against location.href.
        const current = titleDesc.get.call(this);
        const generic = isGenericTitle(value) && current && !isGenericTitle(current);
        const suspect =
          String(value) !== String(current) && (generic || (settling() && !inGestureTask));

        if (suspect) {
          extendSettling();
          pendingTitle = { value, timer: setTimeout(flushTitle, holdMs()) };
          return;
        }
        titles.schedule(value);
      },
    });

    addEventListener('popstate', flushAllTitles, true);
    addEventListener('pagehide', flushAllTitles, true);
  }
})();
