// Camera in world nanometres. Position and scale are kept in f64 on the CPU
// and never handed to the GPU directly - see renderer.js for the origin fix.

export class Camera {
  constructor() {
    this.x = 0;          // world nm, view centre
    this.y = 0;
    this.scale = 1;      // device px per nm
    this.dpr = 1;
    this.resW = 0;
    this.resH = 0;
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
  zoomAt(px, py, factor) {
    const wx = this.x + (px - this.resW / 2) / this.scale;
    const wy = this.y + (py - this.resH / 2) / this.scale;
    this.scale *= factor;
    this.x = wx - (px - this.resW / 2) / this.scale;
    this.y = wy - (py - this.resH / 2) / this.scale;
  }
}

// Wire mouse pan and wheel zoom onto a canvas. Returns nothing; mutates cam.
export function attachControls(canvas, cam, onChange = () => {}) {
  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('mousedown', e => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => {
    dragging = false; canvas.style.cursor = 'grab';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
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
