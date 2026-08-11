// X URL Flicker Tamer
//
// x.com's router calls history.replaceState/pushState repeatedly during app
// hydration, bouncing the URL bar between the post URL and bare x.com. On a
// machine where hydration is slow enough to paint the intermediate states,
// that reads as flicker.
//
// Strategy: when the router flips the URL to "/" or "/home" while we're on a
// deeper path AND the user hasn't interacted recently, hold that change for
// HOLD_MS. If the very next call goes back to a deep URL (the flicker
// pattern), drop the held root change entirely. If nothing follows, it was a
// genuine programmatic navigation home — apply it, just HOLD_MS late.
//
// Deliberate navigations (clicking Home, keyboard shortcuts) always follow a
// user gesture within milliseconds, so anything within GESTURE_MS of a
// pointer/key event passes through with zero delay. Hydration churn fires
// with no gesture anywhere near it, so only it pays the hold.
(() => {
  'use strict';

  const HOLD_MS = 400;
  const GESTURE_MS = 1000;

  let lastGesture = -Infinity;
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    addEventListener(ev, () => { lastGesture = performance.now(); }, {
      capture: true,
      passive: true,
    });
  }

  const nativePush = History.prototype.pushState;
  const nativeReplace = History.prototype.replaceState;

  let pending = null; // { native, args, url, state, timer }

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
    p.native.apply(history, p.args);
  };

  const wrap = (native) =>
    function (...args) {
      let target;
      try {
        target = resolveUrl(args);
      } catch {
        return native.apply(this, args); // malformed URL: let the native throw
      }

      if (pending) {
        if (!isBareRoot(target)) {
          // Ping-pong detected: the held flip-to-root got reversed. Drop it.
          clearTimeout(pending.timer);
          pending = null;
          return native.apply(this, args);
        }
        // Another root-flip while one is held: keep only the newest.
        clearTimeout(pending.timer);
        pending = null;
      }

      const recentGesture = performance.now() - lastGesture < GESTURE_MS;
      if (isBareRoot(target) && !isBareRoot(location.href) && !recentGesture) {
        pending = {
          native,
          args,
          url: target,
          state: args[0],
          timer: setTimeout(flushPending, HOLD_MS),
        };
        return;
      }

      return native.apply(this, args);
    };

  History.prototype.pushState = wrap(nativePush);
  History.prototype.replaceState = wrap(nativeReplace);

  // If the router reads history.state while a change is held, hand it the
  // state it thinks it just set, so its own bookkeeping stays consistent.
  const stateDesc = Object.getOwnPropertyDescriptor(History.prototype, 'state');
  if (stateDesc?.get) {
    Object.defineProperty(History.prototype, 'state', {
      ...stateDesc,
      get() {
        return pending ? pending.state : stateDesc.get.call(this);
      },
    });
  }

  // Never let a held change die silently on back/forward or page teardown.
  addEventListener('popstate', flushPending, true);
  addEventListener('pagehide', flushPending, true);
})();
