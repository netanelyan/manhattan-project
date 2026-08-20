// Camera in world nanometres. Position and scale are kept in f64 on the CPU
// and never handed to the GPU directly - see renderer.js for the origin fix.

// How much of the viewport the whole world must still fill at maximum zoom-out.
// Below 1.0 there is a little slack past fit-to-die, so `f` does not sit exactly
// on the stop and a wheel notch outwards still moves; far below it the die is a
// thumbnail in the corner and every level is being drawn at a scale nothing was
// built for. 0.85 is fit-to-die plus about one notch.
export const MIN_ZOOM_FILL = 0.85;

export class Camera {
  constructor() {
    this.x = 0;          // world nm, view centre
    this.y = 0;
    this._scale = 1;     // device px per nm
    this.minScale = 0;   // zoom floor; 0 until the world size is known
    this.dpr = 1;
    this.resW = 0;
    this.resH = 0;
  }

  // Every path that sets the zoom - the wheel, `f`, a restored URL, a scripted
  // run - goes through here, so the floor cannot be walked around by assigning
  // to cam.scale. Panning past the die is harmless and sometimes wanted; zooming
  // out past it is not, because there is nothing out there to navigate to.
  get scale() { return this._scale; }
  set scale(v) { this._scale = this.minScale > 0 ? Math.max(this.minScale, v) : v; }

  // The zoom floor for a world of w x h at the current viewport. Re-derived on
  // resize, because a narrower window fits the die at a lower scale.
  setWorld(w, h) {
    this.worldW = w; this.worldH = h;
    this.minScale = Math.min(this.resW / Math.max(1, w), this.resH / Math.max(1, h)) * MIN_ZOOM_FILL;
    this.scale = this._scale;      // re-clamp: a resize can raise the floor
  }

  fit(minX, minY, maxX, maxY, margin = 0.94) {
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    this.scale = Math.min(this.resW / w, this.resH / h) * margin;
    this.x = (minX + maxX) / 2;
    this.y = (minY + maxY) / 2;
  }

  // Visible world rect, in nm.
  bounds() {
    const hw = this.resW / 2 / this.scale, hh = this.resH / 2 / this.scale;
    return { minX: this.x - hw, minY: this.y - hh, maxX: this.x + hw, maxY: this.y + hh };
  }

  panPixels(dxPx, dyPx) {
    this.x -= dxPx / this.scale;
    this.y -= dyPx / this.scale;
  }

  // Zoom about a device-pixel point, keeping the world point under it fixed.
  // At the floor the scale stops changing, so the world point stays put and the
  // view simply refuses to go further out - it does not drift sideways.
  zoomAt(px, py, factor) {
    const wx = this.x + (px - this.resW / 2) / this.scale;
    const wy = this.y + (py - this.resH / 2) / this.scale;
    this.scale = this._scale * factor;
    this.x = wx - (px - this.resW / 2) / this.scale;
    this.y = wy - (py - this.resH / 2) / this.scale;
  }

  // True when the camera is sitting on the zoom floor, for the HUD to say so.
  get atZoomFloor() { return this.minScale > 0 && this._scale <= this.minScale * 1.001; }
}

// Wire mouse pan and wheel zoom onto a canvas. Returns nothing; mutates cam.
// A click is a mouseup that did not travel: panning and picking share a button,
// so the only thing separating them is how far the pointer moved. Four device
// pixels is enough to survive a shaky hand and small enough that a deliberate
// drag is never mistaken for a click.
const CLICK_SLOP = 4;

export function attachControls(canvas, cam, onChange = () => {}, onClick = () => {}) {
  let dragging = false, lastX = 0, lastY = 0, downX = 0, downY = 0, travel = 0;
  canvas.addEventListener('mousedown', e => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    downX = e.clientX; downY = e.clientY; travel = 0;
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', e => {
    if (dragging && travel <= CLICK_SLOP) onClick(downX * cam.dpr, downY * cam.dpr, e);
    dragging = false; canvas.style.cursor = 'grab';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    travel += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
    cam.panPixels((e.clientX - lastX) * cam.dpr, (e.clientY - lastY) * cam.dpr);
    lastX = e.clientX; lastY = e.clientY;
    onChange();
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    cam.zoomAt(e.clientX * cam.dpr, e.clientY * cam.dpr, Math.exp(-e.deltaY * 0.0015));
    onChange();
  }, { passive: false });
}
