// Replay harness for tamer.js.
//
//   node test/replay.mjs [path/to/tamer.js]
//
// Runs the content script against a fake History/Document/location on a virtual
// clock, replays hydration churn patterns captured from x.com, and counts what
// the user can actually see: native history calls that move the URL bar, and
// native title writes. Both also stand in for the tabs.onUpdated events every
// other installed extension receives.
//
// The virtual clock means the whole suite runs instantly and deterministically —
// no sleeps, no flaky timing.

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const scriptPath = process.argv[2] ?? new URL('../tamer.js', import.meta.url).pathname;
const source = readFileSync(scriptPath, 'utf8');

// --- fake environment ------------------------------------------------------

function makeEnv(startUrl) {
  let now = 0;
  let seq = 1;
  let timers = [];

  const setTimeout_ = (fn, ms) => {
    const t = { id: seq++, at: now + (Number(ms) || 0), fn };
    timers.push(t);
    return t.id;
  };
  const clearTimeout_ = (id) => {
    timers = timers.filter((t) => t.id !== id);
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      if (!timers.length || timers[0].at > end) break;
      const t = timers.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };

  // What the user sees. A native call is only "visible" in the URL bar if it
  // lands on a different URL than the one currently displayed.
  const urlMoves = [];
  const nativeHistoryCalls = [];
  const nativeTitleWrites = [];

  const location = { href: startUrl };

  function History() {}
  let historyState = null;
  const commit = (kind) =>
    function (state, _title, url) {
      const next = url == null ? location.href : new URL(url, location.href).href;
      nativeHistoryCalls.push({ kind, url: next, at: now });
      if (next !== location.href) urlMoves.push({ kind, url: next, at: now });
      location.href = next;
      historyState = state;
    };
  History.prototype.pushState = commit('push');
  History.prototype.replaceState = commit('replace');
  Object.defineProperty(History.prototype, 'state', {
    configurable: true,
    get: () => historyState,
  });
  const history = new History();

  function Document() {}
  let titleValue = '';
  Object.defineProperty(Document.prototype, 'title', {
    configurable: true,
    get() {
      return titleValue;
    },
    set(v) {
      nativeTitleWrites.push({ value: String(v), at: now });
      titleValue = String(v);
    },
  });
  const document = new Document();

  const listeners = new Map();
  const addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const dispatch = (type) => {
    for (const fn of listeners.get(type) ?? []) fn({ type, isTrusted: true });
  };

  const sandbox = {
    History,
    Document,
    history,
    document,
    location,
    navigator: { userActivation: { isActive: false, hasBeenActive: false } },
    performance: { now: () => now },
    setTimeout: setTimeout_,
    clearTimeout: clearTimeout_,
    addEventListener,
    console,
    localStorage: { getItem: () => null },
    URL,
    Math,
    String,
    Object,
    Number,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  return {
    sandbox,
    advance,
    dispatch,
    at: () => now,
    urlMoves,
    nativeHistoryCalls,
    nativeTitleWrites,
    location,
    document,
    history,
    setTitle: (v) => {
      document.title = v;
    },
  };
}

function load(startUrl) {
  const env = makeEnv(startUrl);
  runInContext(source, createContext(env.sandbox), { filename: scriptPath });
  return env;
}

// --- assertions ------------------------------------------------------------

let failures = 0;
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

function scenario(name, fn) {
  const out = fn();
  const ok = out.ok;
  check(name, ok, out.detail);
}

// --- scenarios -------------------------------------------------------------

const POST = 'https://x.com/someone/status/1234567890';

// 1. Tight hydration volley: churn calls closer together than QUIET_MS.
//    v1.1.0 already handles this one.
scenario('tight volley (calls 40ms apart) → URL bar never moves', () => {
  const env = load(POST);
  env.advance(30);
  env.history.replaceState({ a: 1 }, '', 'https://x.com/');
  env.advance(40);
  env.history.replaceState({ a: 2 }, '', POST);
  env.advance(40);
  env.history.replaceState({ a: 3 }, '', 'https://x.com/home');
  env.advance(40);
  env.history.replaceState({ a: 4 }, '', POST);
  env.advance(5000);
  return {
    ok: env.urlMoves.length === 0 && env.location.href === POST,
    detail: `${env.urlMoves.length} move(s), final ${env.location.href}`,
  };
});

// 2. THE REGRESSION CASE: slow hydration spaces the same churn past QUIET_MS,
//    and the intermediate URLs are not bare root, so layer 1 never sees them.
scenario('slow volley (calls 250ms apart, non-root intermediates) → URL bar never moves', () => {
  const env = load(POST);
  env.advance(200);
  env.history.replaceState({ a: 1 }, '', 'https://x.com/i/flow/single-sign-on');
  env.advance(250);
  env.history.replaceState({ a: 2 }, '', 'https://x.com/someone');
  env.advance(250);
  env.history.replaceState({ a: 3 }, '', 'https://x.com/home');
  env.advance(250);
  env.history.replaceState({ a: 4 }, '', POST);
  env.advance(5000);
  return {
    ok: env.urlMoves.length === 0 && env.location.href === POST,
    detail: `${env.urlMoves.length} move(s): ${env.urlMoves.map((m) => m.url).join(' → ') || '(none)'}`,
  };
});

// 3. Sustained storm: 40 calls, 120ms apart, ending on the post URL.
scenario('sustained storm (40 calls) → at most 1 visible move, correct final URL', () => {
  const env = load(POST);
  for (let i = 0; i < 39; i++) {
    env.advance(120);
    env.history.replaceState({ i }, '', i % 2 ? 'https://x.com/home' : 'https://x.com/i/flow/x');
  }
  env.advance(120);
  env.history.replaceState({ i: 40 }, '', POST);
  env.advance(5000);
  return {
    ok: env.urlMoves.length <= 1 && env.location.href === POST,
    detail: `${env.urlMoves.length} move(s), ${env.nativeHistoryCalls.length} native call(s), final ${env.location.href}`,
  };
});

// 4. Clicking a post in the timeline must not be delayed by the settling rule.
scenario('click → pushState to a deep URL applies immediately', () => {
  const env = load('https://x.com/home');
  env.advance(400);
  env.dispatch('pointerdown');
  env.dispatch('click');
  env.history.pushState({ nav: 1 }, '', POST);
  const immediate = env.location.href === POST;
  env.advance(5000);
  return {
    ok: immediate && env.location.href === POST,
    detail: immediate ? 'applied synchronously' : `not applied: ${env.location.href}`,
  };
});

// 4b. A click-driven flip to Home is deliberately still held (v1.0.1: exempting
//     the gesture window leaked, because the reversal can land late on a janked
//     main thread). It must land promptly, though — only the URL bar text lags.
scenario('click → flip to Home is held by design, but lands < 700ms', () => {
  const env = load(POST);
  env.advance(400);
  env.dispatch('pointerdown');
  env.dispatch('click');
  env.history.pushState({ nav: 1 }, '', 'https://x.com/home');
  const t0 = env.at();
  env.advance(700);
  return {
    ok: env.location.href === 'https://x.com/home',
    detail: `landed ${(env.urlMoves.at(-1)?.at ?? NaN) - t0}ms after the call`,
  };
});

// 5. Churn that follows a click-driven navigation is still tamed.
scenario('click → nav, then churn after it → no extra moves', () => {
  const env = load('https://x.com/home');
  env.advance(400);
  env.dispatch('pointerdown');
  env.dispatch('click');
  env.history.pushState({ nav: 1 }, '', POST);
  env.advance(300);
  env.history.replaceState({ c: 1 }, '', 'https://x.com/i/flow/x');
  env.advance(300);
  env.history.replaceState({ c: 2 }, '', 'https://x.com/home');
  env.advance(300);
  env.history.replaceState({ c: 3 }, '', POST);
  env.advance(5000);
  const moves = env.urlMoves.filter((m) => m.kind !== 'push');
  return {
    ok: moves.length === 0 && env.location.href === POST,
    detail: `${moves.length} extra move(s), final ${env.location.href}`,
  };
});

// 6. A genuine unattended navigation (no reversal) must still land.
scenario('unattended redirect with no reversal → applies (late, but applies)', () => {
  const env = load(POST);
  env.advance(300);
  env.history.replaceState({ r: 1 }, '', 'https://x.com/i/flow/login');
  env.advance(5000);
  return {
    ok: env.location.href === 'https://x.com/i/flow/login',
    detail: `final ${env.location.href} after ${env.urlMoves[0]?.at ?? '-'}ms`,
  };
});

// 7. Back/forward must never strand a held change.
scenario('popstate flushes a held change', () => {
  const env = load(POST);
  env.advance(300);
  env.history.replaceState({ h: 1 }, '', 'https://x.com/home');
  env.advance(10);
  env.dispatch('popstate');
  return {
    ok: env.location.href === 'https://x.com/home',
    detail: `final ${env.location.href}`,
  };
});

// 8. pushState must not lose session-history stops when superseded.
scenario('pushState superseded by a different URL → still commits (back stops kept)', () => {
  const env = load(POST);
  env.advance(300);
  env.history.pushState({ p: 1 }, '', 'https://x.com/explore');
  env.advance(50);
  env.history.replaceState({ p: 2 }, '', 'https://x.com/explore/tabs/for-you');
  env.advance(5000);
  const pushes = env.nativeHistoryCalls.filter((c) => c.kind === 'push');
  return {
    ok: pushes.length === 1 && env.location.href === 'https://x.com/explore/tabs/for-you',
    detail: `${pushes.length} native push(es), final ${env.location.href}`,
  };
});

// 9. Long after load, the page is idle: a lone change must not be held long.
//    v1.3 relaxed this from 200ms to 400ms — an unattended change is coalesced
//    on the churn timescale (SETTLE_QUIET_MS) so that the first change of an
//    idle burst can still be superseded by its reversal. See scenario 9b for
//    the tight path, which is the one a user's own action takes.
scenario('idle page → lone unattended replaceState lands within 400ms', () => {
  const env = load(POST);
  env.advance(30000);
  const t0 = env.at();
  env.history.replaceState({ z: 1 }, '', 'https://x.com/someone/status/999');
  env.advance(400);
  return {
    ok: env.location.href === 'https://x.com/someone/status/999',
    detail: `landed ${(env.urlMoves.at(-1)?.at ?? NaN) - t0}ms after the call`,
  };
});

// 9b. A change from inside a user gesture's own task keeps the tight timing.
scenario('idle page → gesture-driven replaceState lands within 200ms', () => {
  const env = load(POST);
  env.advance(30000);
  const t0 = env.at();
  env.dispatch('pointerdown');
  env.dispatch('click');
  env.history.replaceState({ z: 1 }, '', 'https://x.com/someone/status/999');
  env.advance(200);
  return {
    ok: env.location.href === 'https://x.com/someone/status/999',
    detail: `landed ${(env.urlMoves.at(-1)?.at ?? NaN) - t0}ms after the call`,
  };
});

// 10. history.state stays consistent while a change is held.
scenario('history.state reports what the page just set', () => {
  const env = load(POST);
  env.advance(300);
  env.history.replaceState({ marker: 'held' }, '', 'https://x.com/home');
  const seen = env.history.state;
  env.advance(5000);
  return {
    ok: seen && seen.marker === 'held',
    detail: `saw ${JSON.stringify(seen)}`,
  };
});

// 11. Title churn: generic ↔ specific, spaced out.
scenario('title churn (spaced) → one native title write, specific title wins', () => {
  const env = load(POST);
  env.setTitle('Someone on X: "hello" / X');
  const before = env.nativeTitleWrites.length;
  env.advance(200);
  env.setTitle('X');
  env.advance(250);
  env.setTitle('Home / X');
  env.advance(250);
  env.setTitle('Someone on X: "hello" / X');
  env.advance(5000);
  const writes = env.nativeTitleWrites.slice(before);
  return {
    ok: writes.length <= 1 && env.document.title === 'Someone on X: "hello" / X',
    detail: `${writes.length} write(s), final "${env.document.title}"`,
  };
});

// 12. A real title change on an idle page still lands.
scenario('idle page → title change lands', () => {
  const env = load(POST);
  env.advance(30000);
  env.setTitle('(3) Someone on X: "hi" / X');
  env.advance(300);
  return {
    ok: env.document.title === '(3) Someone on X: "hi" / X',
    detail: `final "${env.document.title}"`,
  };
});

// 13. THE v1.3 CASE (see test/repro-cases.md): the page loaded minutes ago and
//     has long since settled, then the app starts churning again — flicker
//     while merely reading a post. Layer 3's window is closed by then, so
//     before v1.3 every non-root intermediate walked straight through.
scenario('churn on a long-idle page (250ms apart) → at most 1 visible move', () => {
  const env = load(POST);
  env.advance(120000); // read the post for two minutes
  const before = env.urlMoves.length;
  env.history.replaceState({ h: 1 }, '', 'https://x.com/someone');
  env.advance(250);
  env.history.replaceState({ h: 2 }, '', POST);
  env.advance(250);
  env.history.replaceState({ h: 3 }, '', 'https://x.com/someone');
  env.advance(250);
  env.history.replaceState({ h: 4 }, '', POST);
  env.advance(5000);
  const moves = env.urlMoves.slice(before);
  return {
    ok: moves.length <= 1 && env.location.href === POST,
    detail: `${moves.length} move(s): ${moves.map((m) => m.url).join(' → ') || '(none)'}`,
  };
});

// 14. The same burst, in the tab title.
scenario('title churn on a long-idle page → at most 1 visible write', () => {
  const env = load(POST);
  env.setTitle('demi on X: "art on hyperliquid" / X');
  env.advance(120000);
  const before = env.nativeTitleWrites.length;
  env.setTitle('X');
  env.advance(250);
  env.setTitle('demi on X: "art on hyperliquid" / X');
  env.advance(250);
  env.setTitle('X');
  env.advance(250);
  env.setTitle('demi on X: "art on hyperliquid" / X');
  env.advance(5000);
  const writes = env.nativeTitleWrites.slice(before);
  return {
    ok: writes.length <= 1 && env.document.title === 'demi on X: "art on hyperliquid" / X',
    detail: `${writes.length} write(s), final "${env.document.title}"`,
  };
});

// 15. The detector must not turn an idle page into a held one. Two changes
//     spaced further apart than the churn threshold are two navigations, not a
//     burst, and both have to land promptly.
scenario('idle page → two well-spaced changes both land promptly', () => {
  const env = load(POST);
  env.advance(30000);
  env.history.replaceState({ n: 1 }, '', 'https://x.com/explore');
  env.advance(400);
  const first = env.location.href === 'https://x.com/explore';
  env.advance(3000);
  const t0 = env.at();
  env.history.replaceState({ n: 2 }, '', 'https://x.com/messages');
  env.advance(400);
  return {
    ok: first && env.location.href === 'https://x.com/messages',
    detail: first
      ? `second landed ${(env.urlMoves.at(-1)?.at ?? NaN) - t0}ms after the call`
      : 'first change did not land',
  };
});

// --- report ----------------------------------------------------------------

const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}  ${r.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} passed  (${scriptPath})`);
process.exit(failures ? 1 : 0);
