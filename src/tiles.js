// Tile store: fetch, cache, account. The LRU eviction budget is wired up here
// so the HUD counters are real from the start; on-demand loading driven by the
// camera lands in a later step.

import { viewTile, key } from './format.js';

export class TileStore {
  constructor(baseUrl, budgetMB = 256) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.budgetBytes = budgetMB * 1024 * 1024;
    this.cache = new Map();     // key -> tile view; Map order is the LRU order
    this.pending = new Map();   // key -> Promise
    this.bytes = 0;
    this.stats = { loaded: 0, hits: 0, evicted: 0, failed: 0 };
  }

  get budgetMB() { return this.budgetBytes / (1024 * 1024); }
  set budgetMB(mb) { this.budgetBytes = mb * 1024 * 1024; this.evict(); }

  has(z, x, y) { return this.cache.has(key(z, x, y)); }

  // Cache hit without touching the network. Refreshes LRU position.
  get(z, x, y) {
    const k = key(z, x, y);
    const t = this.cache.get(k);
    if (t === undefined) return undefined;
    this.cache.delete(k);
    this.cache.set(k, t);
    this.stats.hits++;
    return t;
  }

  async load(z, x, y) {
    const k = key(z, x, y);
    const hit = this.get(z, x, y);
    if (hit) return hit;
    const inflight = this.pending.get(k);
    if (inflight) return inflight;

    const p = (async () => {
      const res = await fetch(`${this.baseUrl}/tiles/${z}/${x}/${y}.bin`);
      if (!res.ok) throw new Error(`tile ${k}: HTTP ${res.status}`);
      const tile = viewTile(await res.arrayBuffer());
      this.cache.set(k, tile);
      this.bytes += tile.bytes;
      this.stats.loaded++;
      this.evict();
      return tile;
    })();

    this.pending.set(k, p);
    try {
      return await p;
    } catch (e) {
      this.stats.failed++;
      throw e;
    } finally {
      this.pending.delete(k);
    }
  }

  // Drop least-recently-used tiles until back inside the byte budget. Tiles
  // marked pinned (currently on screen) are never evicted.
  evict(pinned = null) {
    if (this.bytes <= this.budgetBytes) return 0;
    let dropped = 0;
    for (const [k, t] of this.cache) {
      if (this.bytes <= this.budgetBytes) break;
      if (pinned && pinned.has(k)) continue;
      this.cache.delete(k);
      this.bytes -= t.bytes;
      this.stats.evicted++;
      dropped++;
    }
    return dropped;
  }
}
