// Client-side persistence. Two tiers, both keyed by a schema version so a
// format change never has to migrate old entries — it just misses them.
//
//   localStorage   durable: swimmer identities, best-time payloads, the pinned
//                  swimmer, UI preferences. Survives browser restarts.
//   sessionStorage per-tab: search results, which are cheap to refetch and
//                  shouldn't outlive the tab.

const V = "swimpb:v1";
const TTL_MS = 12 * 60 * 60 * 1000; // PBs only change when he races

function read(store, key) {
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // corrupt or quota-cleared entry — treat as absent
  }
}

function write(store, key, value) {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded. Dropping a cache write is always safe, so don't let it
    // break the render.
  }
}

/** Cached value plus its age, or null. Returns stale entries too — callers decide. */
export function getEntry(key) {
  const e = read(localStorage, `${V}:${key}`);
  if (!e || typeof e.fetchedAt !== "number") return null;
  return { data: e.data, fetchedAt: e.fetchedAt, stale: Date.now() - e.fetchedAt > TTL_MS };
}

export function setEntry(key, data) {
  write(localStorage, `${V}:${key}`, { data, fetchedAt: Date.now() });
}

/**
 * Stale-while-revalidate. Renders cached data immediately when present, then
 * refetches in the background and calls `onFresh` only if the payload actually
 * changed — so a background refresh never causes a pointless re-render.
 *
 * @param {string} key
 * @param {() => Promise<any>} fetcher
 * @param {(data:any) => void} onFresh
 * @param {{revalidate?:boolean, onUnchanged?:() => void}} [opts] `revalidate`
 *   still returns a fresh cache immediately, then checks the server. Personal
 *   bests use it so a new swim shows up on the next visit instead of waiting
 *   out the 12-hour window. `onUnchanged` runs when that check matches the cache.
 * @returns {Promise<{data:any, fromCache:boolean, fetchedAt:number}>}
 */
export async function swr(key, fetcher, onFresh, opts = {}) {
  const cached = getEntry(key);

  if (cached && !cached.stale && !opts.revalidate) {
    return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
  }

  if (cached) {
    // Serve stale now, refresh behind the user's back.
    (async () => {
      try {
        const fresh = await fetcher();
        setEntry(key, fresh);
        const changed = JSON.stringify(fresh) !== JSON.stringify(cached.data);
        if (changed) onFresh?.(fresh);
        else opts.onUnchanged?.();
      } catch {
        // Offline or API hiccup: the stale copy on screen is still useful.
      }
    })();
    return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt };
  }

  const fresh = await fetcher();
  setEntry(key, fresh);
  return { data: fresh, fromCache: false, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Per-tab search results

export function getSession(key) {
  return read(sessionStorage, `${V}:${key}`);
}

export function setSession(key, data) {
  write(sessionStorage, `${V}:${key}`, data);
}

// ---------------------------------------------------------------------------
// Pinned swimmers — the whole point of a personal tool: open it and he's there.

export function pinned() {
  return read(localStorage, `${V}:pinned`) ?? [];
}

export function pin(swimmer) {
  const list = pinned().filter((s) => s.memberId !== swimmer.memberId);
  list.unshift(swimmer);
  write(localStorage, `${V}:pinned`, list.slice(0, 8));
}

export function unpin(memberId) {
  write(localStorage, `${V}:pinned`, pinned().filter((s) => s.memberId !== memberId));
}

export function isPinned(memberId) {
  return pinned().some((s) => s.memberId === memberId);
}

// ---------------------------------------------------------------------------
// UI preferences

export function pref(key, fallback) {
  const v = read(localStorage, `${V}:pref:${key}`);
  return v === null ? fallback : v;
}

export function setPref(key, value) {
  write(localStorage, `${V}:pref:${key}`, value);
}

/** Drop cached API payloads but keep pins and preferences. */
export function clearData() {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(`${V}:bestTimes:`) || k.startsWith(`${V}:swimmer:`)) {
      localStorage.removeItem(k);
    }
  }
  sessionStorage.clear();
}
