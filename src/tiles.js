// Tile store: prioritised on-demand fetching with an LRU byte budget.
//
// Requests are queued, not fired all at once: the viewport centre is served
// first, a ring of neighbours is prefetched behind it, and requests the camera
// has moved past are dropped or aborted before they reach the network. Nothing
// here blocks the frame - the viewer draws whatever has arrived and picks up
// the rest as it lands.
//
// Eviction is LRU by last use, with the currently visible set pinned. A tile
// the renderer still holds slots for must never be evicted, so `pin` is the
// renderer's residency set, not a guess.

import { viewTile, key, overflowKey, decodeCoverage } from './format.js';

const PRIORITY = { VISIBLE: 0, PREFETCH: 1 };

export class TileStore {
  constructor(baseUrl, manifest, budgetMB = 256, concurrency = 8) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.budgetBytes = budgetMB * 1024 * 1024;
    this.concurrency = concurrency;

    this.cache = new Map();     // key -> tile view; Map order is the LRU order
    this.inflight = new Map();  // key -> { promise, controller, priority }
    this.queue = [];            // { key, url, priority, dist }
    this.queued = new Set();
    this.pinned = new Set();
    this.bytes = 0;
    this.active = 0;
    this.stats = { loaded: 0, hits: 0, evicted: 0, failed: 0, aborted: 0,
                   dropped: 0, fetchMs: 0, evictedBytes: 0 };

    this.coverage = new Map(manifest.levels.map(l => [l.z, decodeCoverage(l.coverage, l.tilesPerSide)]));
    this.levelByZ = new Map(manifest.levels.map(l => [l.z, l]));
  }

  get budgetMB() { return this.budgetBytes / (1024 * 1024); }
  set budgetMB(mb) { this.budgetBytes = Math.max(1, mb) * 1024 * 1024; this.evict(); }

  exists(z, x, y) {
    const c = this.coverage.get(z);
    return c ? c(x, y) : false;
  }

  has(k) { return this.cache.has(k); }

  // Cache hit; refreshes LRU position.
  get(k) {
    const t = this.cache.get(k);
    if (t === undefined) return undefined;
    this.cache.delete(k);
    this.cache.set(k, t);
    this.stats.hits++;
    return t;
  }

  // ------------------------------------------------------------ scheduling
  //
  // `want` is the whole set the camera currently justifies, in priority order.
  // Anything queued but no longer wanted is dropped; anything in flight but no
  // longer wanted is aborted. Returns the keys already resident.
  request(want) {
    const wanted = new Set(want.map(w => w.key));

    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (!wanted.has(this.queue[i].key)) {
        this.queued.delete(this.queue[i].key);
        this.queue.splice(i, 1);
        this.stats.dropped++;
      }
    }
    for (const [k, f] of this.inflight) {
      if (!wanted.has(k)) { f.controller.abort(); this.stats.aborted++; }
    }

    for (const w of want) {
      if (this.cache.has(w.key) || this.inflight.has(w.key) || this.queued.has(w.key)) continue;
      this.queue.push(w);
      this.queued.add(w.key);
    }
    this.queue.sort((a, b) => a.priority - b.priority || a.dist - b.dist);
    this._pump();
  }

  _pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.queued.delete(job.key);
      this._start(job);
    }
  }

  _start(job) {
    const controller = new AbortController();
    this.active++;
    const t0 = performance.now();
    const promise = fetch(job.url, { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error(`tile ${job.key}: HTTP ${res.status}`);
        return res.arrayBuffer();
      })
      .then(buf => {
        const tile = viewTile(buf);
        this.stats.fetchMs += performance.now() - t0;
        this.cache.set(job.key, tile);
        this.bytes += tile.bytes;
        this.stats.loaded++;
        this.evict();
        if (this.onTile) this.onTile(job.key, tile);
        return tile;
      })
      .catch(e => {
        if (e.name !== 'AbortError') { this.stats.failed++; console.warn(e.message); }
        return null;
      })
      .finally(() => {
        this.active--;
        this.inflight.delete(job.key);
        this._pump();
      });
    this.inflight.set(job.key, { promise, controller, priority: job.priority });
  }

  // Wait for everything currently scheduled to settle. Only used by scripted
  // runs; the viewer itself never waits.
  async settle(maxRounds = 5000) {
    let rounds = 0;
    while ((this.active || this.queue.length) && rounds++ < maxRounds) {
      if (this.inflight.size === 0) {
        // Queue non-empty but nothing in flight: pump, then yield a macrotask
        // so this cannot spin the microtask queue forever.
        this._pump();
        await new Promise(r => setTimeout(r, 0));
        continue;
      }
      await Promise.all([...this.inflight.values()].map(f => f.promise));
    }
  }

  // ------------------------------------------------------------ eviction
  setPinned(keys) { this.pinned = keys; }

  // Drop least-recently-used tiles until back inside the byte budget. Pinned
  // tiles - the ones the renderer holds slots for - are skipped, so the budget
  // can be exceeded if the visible set alone is larger than it. That is
  // reported rather than enforced; dropping a visible tile would just make the
  // viewer refetch it immediately.
  evict() {
    if (this.bytes <= this.budgetBytes) return 0;
    let dropped = 0;
    for (const [k, t] of this.cache) {
      if (this.bytes <= this.budgetBytes) break;
      if (this.pinned.has(k)) continue;
      this.cache.delete(k);
      this.bytes -= t.bytes;
      this.stats.evicted++;
      this.stats.evictedBytes += t.bytes;
      dropped++;
    }
    return dropped;
  }

  get pinnedBytes() {
    let b = 0;
    for (const k of this.pinned) {
      const t = this.cache.get(k);
      if (t) b += t.bytes;
    }
    return b;
  }

  urlFor(z, x, y) { return `${this.baseUrl}/tiles/${z}/${x}/${y}.bin`; }
  overflowUrl(z) { return `${this.baseUrl}/tiles/${z}/overflow.bin`; }
}

export { PRIORITY, key, overflowKey };
