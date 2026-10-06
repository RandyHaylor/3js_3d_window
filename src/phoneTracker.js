// Experimental: track the phone's own motion through the room with AlvaAR (visual SLAM,
// GPLv3, https://github.com/alanross/AlvaAR), run on the FRONT camera frames we already
// have. The viewer's face is blanked out so only the room behind them is tracked.
// AlvaAR's translation has an arbitrary scale (a single camera can't measure distance).

const ALVA_URL =
  'https://cdn.jsdelivr.net/gh/alanross/AlvaAR@7796af500ee92001ac2a9888363ff64d7a3bee75/dist/alva_ar.js';
const FACE_PAD = 0.25; // grow the face box by this fraction on each side before masking
const TORSO_PAD = 1.1; // shoulders: extend the mask this many face-widths to each side

export class PhoneTracker {
  // frames: the FrameSource shared with face tracking. AlvaAR runs on that same downscaled
  // frame (after face tracking has used it), and the frame doubles as the preview.
  constructor(frames) {
    this.frames = frames;
    this.canvas = frames.canvas;
    this.alva = null;
    this.status = 'loading';
    this.points = 0;
    this.position = null; // [x, y, z] in AlvaAR units
    this.pose = null; // latest raw 4×4 pose while tracking
    this.resets = 0; // AlvaAR map resets; a new map has a new origin and scale
    this.ms = 0;
  }

  // fovLongDeg: camera field of view across the long side of the video.
  async init(fovLongDeg) {
    while (!this.frames.ready) await new Promise((r) => setTimeout(r, 50)); // first frame sizes it
    const w = this.frames.width;
    const h = this.frames.height;

    // AlvaAR applies its fov to the short side of the image.
    const shortFov =
      (2 * Math.atan(Math.tan((fovLongDeg * Math.PI) / 360) * (Math.min(w, h) / Math.max(w, h))) * 180) / Math.PI;
    const { AlvaAR } = await import(ALVA_URL);
    this.alva = await AlvaAR.Initialize(w, h, shortFov);
    this.alvaW = w;
    this.alvaH = h;
    this.status = 'initializing';
  }

  // Process the frame just grabbed (face tracking must already have run on it, since the
  // viewer is masked out in place). faceBox: normalized {x0, y0, x1, y1} or null.
  update(faceBox) {
    if (!this.alva) return;
    const t0 = performance.now();
    const { canvas, alva } = this;
    const ctx = this.frames.ctx;
    const w = canvas.width;
    const h = canvas.height;
    if (w !== this.alvaW || h !== this.alvaH) return; // frame size changed since AlvaAR started

    if (faceBox) {
      // Blank the viewer: head plus shoulders/torso down to the bottom of the frame, so
      // only the room is tracked (points on the viewer move with them, not the room).
      const bw = faceBox.x1 - faceBox.x0;
      const bh = faceBox.y1 - faceBox.y0;
      ctx.fillStyle = '#808080';
      const headX0 = faceBox.x0 - bw * FACE_PAD;
      const headY0 = faceBox.y0 - bh * FACE_PAD;
      ctx.fillRect(headX0 * w, headY0 * h, bw * (1 + 2 * FACE_PAD) * w, h);
      const torsoY0 = faceBox.y1;
      ctx.fillRect((faceBox.x0 - bw * TORSO_PAD) * w, torsoY0 * h, bw * (1 + 2 * TORSO_PAD) * w, h);
    }
    const frame = ctx.getImageData(0, 0, w, h);

    // Same calls as AlvaAR.findCameraPose, keeping the status code it discards.
    alva.memImg.write(frame.data);
    const code = alva.system.findCameraPose(alva.memImg.heap.byteOffset, alva.memCam.ptr);
    if (code === 1) {
      // Copy out of the WASM heap; layout documented in AlvaAR's findCameraPose.
      this.pose = Array.from(alva.memCam.read(16));
      // Same axis convention as AlvaAR's Three.js connector.
      this.position = [this.pose[12], -this.pose[13], -this.pose[14]];
      this.status = 'tracking';
    } else {
      this.pose = null;
      this.status = code === 2 ? 'reset' : 'initializing';
      if (code === 2) this.resets++;
    }

    this.ms = performance.now() - t0;

    // Visual feedback on the preview (drawn after the frame was handed to AlvaAR).
    const pts = alva.getFramePoints();
    this.points = pts.length;
    const tracking = this.status === 'tracking';
    const dot = Math.max(4, Math.round(w / 60));
    ctx.fillStyle = tracking ? '#3fd6a0' : '#ff4d6d';
    for (const p of pts) ctx.fillRect(p.x - dot / 2, p.y - dot / 2, dot, dot);
    const font = Math.round(w / 12);
    ctx.font = `bold ${font}px sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, font * 3.7);
    ctx.fillStyle = tracking ? '#3fd6a0' : '#ffb35c';
    ctx.fillText(this.status.toUpperCase(), font * 0.4, font * 1.1);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`${this.points} pts  ${Math.round(this.ms)} ms`, font * 0.4, font * 2.2);
    const pos = this.position ? this.position.map((v) => v.toFixed(2)).join(' ') : '–';
    ctx.fillText(`pos ${pos}`, font * 0.4, font * 3.3);
  }

  reset() {
    if (this.alva) this.alva.reset();
    this.position = null;
    this.pose = null;
    this.resets++;
  }
}
