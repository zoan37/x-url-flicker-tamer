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
// Every flip-to-root pays the same HOLD_MS: a genuine "go Home" only has
// its URL bar text (never its page content) lag by the hold, which is
// imperceptible, while a shorter gesture-window hold (tried in v1.0.1)
// proved leaky when the reversal landed late on a janked main thread.
//
// The tab title gets the same treatment: hydration churns document.title
// between the specific page title and the generic app title in lockstep
// with the URL churn, so changes *to* the generic title are held and
// dropped when reversed.
(() => {
  'use strict';

  const HOLD_MS = 400;

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

  // --- Tab title taming -----------------------------------------------------
  // Same idea as the URL: hold changes TO the generic app title ("X",
  // "Home / X", optionally with an unread-count "(3) " prefix) while a
  // specific title is showing; drop the held change if a specific title
  // follows (churn), apply it if nothing follows (genuine navigation).
  const titleDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'title');
  if (titleDesc?.get && titleDesc?.set) {
    let pendingTitle = null; // { value, timer }

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

    Object.defineProperty(Document.prototype, 'title', {
      configurable: true,
      enumerable: titleDesc.enumerable,
      get() {
        // Report the title the page thinks it set, like history.state above.
        return pendingTitle ? pendingTitle.value : titleDesc.get.call(this);
      },
      set(value) {
        if (pendingTitle) {
          clearTimeout(pendingTitle.timer);
          pendingTitle = null;
          if (!isGenericTitle(value)) {
            // Churn reversed: drop the held generic title, show the real one.
            titleDesc.set.call(this, value);
            return;
          }
        }
        const current = titleDesc.get.call(this);
        if (isGenericTitle(value) && current && !isGenericTitle(current)) {
          pendingTitle = { value, timer: setTimeout(flushTitle, HOLD_MS) };
          return;
        }
        titleDesc.set.call(this, value);
      },
    });

    addEventListener('pagehide', flushTitle, true);
  }
})();
