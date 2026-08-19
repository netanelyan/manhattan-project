// A persistent GPU buffer of fixed-size slots with a free list.
//
// Tiles claim a contiguous run of slots when they enter the visible set and
// release it when they leave. Nothing else is touched, so a visible-set change
// costs only the tiles that actually changed. Released runs are coalesced with
// their neighbours so the buffer does not shred over a long pan.
//
// Draws cover [0, highWater) in one call. Released slots are overwritten with a
// sentinel the vertex shader recognises, so they cost a discarded vertex rather
// than a wrong pixel. When too much of the range is dead the caller compacts.

export class SlotPool {
  constructor(gl, bytesPerSlot, initialSlots = 65536) {
    this.gl = gl;
    this.bytesPerSlot = bytesPerSlot;
    this.capacity = initialSlots;
    this.highWater = 0;
    this.used = 0;
    this.free = [];          // {off, n}, sorted by off, coalesced
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * bytesPerSlot, gl.DYNAMIC_DRAW);
  }

  get waste() { return this.highWater === 0 ? 0 : 1 - this.used / this.highWater; }

  // First fit, then bump the high water mark, then grow.
  alloc(n) {
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i];
      if (f.n < n) continue;
      const off = f.off;
      if (f.n === n) this.free.splice(i, 1);
      else { f.off += n; f.n -= n; }
      this.used += n;
      return off;
    }
    if (this.highWater + n > this.capacity) this._grow(this.highWater + n);
    const off = this.highWater;
    this.highWater += n;
    this.used += n;
    return off;
  }

  release(off, n) {
    this.used -= n;
    if (off + n === this.highWater) {          // trim instead of fragmenting
      this.highWater = off;
      this._trim();
      return;
    }
    let i = 0;
    while (i < this.free.length && this.free[i].off < off) i++;
    this.free.splice(i, 0, { off, n });
    this._coalesce(i);
  }

  _coalesce(i) {
    const f = this.free;
    if (i + 1 < f.length && f[i].off + f[i].n === f[i + 1].off) {
      f[i].n += f[i + 1].n;
      f.splice(i + 1, 1);
    }
    if (i > 0 && f[i - 1].off + f[i - 1].n === f[i].off) {
      f[i - 1].n += f[i].n;
      f.splice(i, 1);
    }
  }

  // After trimming the high water mark, any free run now sitting at the end is
  // no longer a hole - fold it into the trim.
  _trim() {
    const f = this.free;
    while (f.length && f[f.length - 1].off + f[f.length - 1].n >= this.highWater) {
      const last = f.pop();
      if (last.off < this.highWater) this.highWater = last.off;
    }
  }

  write(off, data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, off * this.bytesPerSlot, data);
  }

  _grow(need) {
    const gl = this.gl;
    let cap = this.capacity;
    while (cap < need) cap *= 2;
    const next = gl.createBuffer();
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, next);
    gl.bufferData(gl.COPY_WRITE_BUFFER, cap * this.bytesPerSlot, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.COPY_READ_BUFFER, this.buf);
    gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0,
                         this.highWater * this.bytesPerSlot);
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    gl.deleteBuffer(this.buf);
    this.buf = next;
    this.capacity = cap;
    this.generation = (this.generation || 0) + 1;   // VAOs must re-point
  }

  reset() {
    this.highWater = 0;
    this.used = 0;
    this.free.length = 0;
  }

  get bytes() { return this.capacity * this.bytesPerSlot; }
}
