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
// Strategy: when the router flips the URL to "/" or "/home" while we're on a
// deeper path, hold that change briefly. If the very next call goes back to
// a deep URL (the flicker pattern), drop the held root change entirely. If
// nothing follows, it was a genuine navigation home — apply it, just late.
//
// The hold length depends on user gesture: within GESTURE_MS of a click or
// keypress the flip might be a deliberate "go Home", so hold only
// GESTURE_HOLD_MS — short enough to be imperceptible on the URL bar, long
// enough to catch a reversal, which arrives within tens of ms. Gesture-less
// flips are pure router churn and get the full HOLD_MS. (v1.0.0 skipped the
// hold entirely inside the gesture window, which let click-navigation
// flicker through — e.g. clicking a post from the timeline.)
(() => {
  'use strict';

  const HOLD_MS = 400;
  const GESTURE_HOLD_MS = 200;
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

      if (isBareRoot(target) && !isBareRoot(location.href)) {
        const recentGesture = performance.now() - lastGesture < GESTURE_MS;
        pending = {
          native,
          args,
          url: target,
          state: args[0],
          timer: setTimeout(flushPending, recentGesture ? GESTURE_HOLD_MS : HOLD_MS),
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
