// Experimental: track the phone's own motion through the room with AlvaAR (visual SLAM,
// GPLv3, https://github.com/alanross/AlvaAR), run on the FRONT camera frames we already
// have. The viewer's face is blanked out so only the room behind them is tracked.
// AlvaAR's translation has an arbitrary scale (a single camera can't measure distance).

const ALVA_URL =
  'https://cdn.jsdelivr.net/gh/alanross/AlvaAR@7796af500ee92001ac2a9888363ff64d7a3bee75/dist/alva_ar.js';
const FACE_PAD = 0.25; // grow the face box by this fraction on each side before masking

export class PhoneTracker {
  // maxSide: processing resolution (long side, px).
  constructor(video, maxSide = 640) {
    this.video = video;
    this.maxSide = maxSide;
    this.canvas = document.createElement('canvas');
    this.ctx = null;
    this.alva = null;
    this.status = 'loading';
    this.points = 0;
    this.position = null; // [x, y, z] in AlvaAR units
    this.ms = 0;
  }

  // fovLongDeg: camera field of view across the long side of the video.
  async init(fovLongDeg) {
    const v = this.video;
    const k = Math.min(1, this.maxSide / Math.max(v.videoWidth, v.videoHeight));
    const w = (this.canvas.width = Math.round(v.videoWidth * k));
    const h = (this.canvas.height = Math.round(v.videoHeight * k));
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    // AlvaAR applies its fov to the short side of the image.
    const shortFov =
      (2 * Math.atan(Math.tan((fovLongDeg * Math.PI) / 360) * (Math.min(w, h) / Math.max(w, h))) * 180) / Math.PI;
    const { AlvaAR } = await import(ALVA_URL);
    this.alva = await AlvaAR.Initialize(w, h, shortFov);
    this.status = 'initializing';
  }

  // Process the current video frame. faceBox: normalized {x0, y0, x1, y1} or null.
  update(faceBox) {
    if (!this.alva) return;
    const t0 = performance.now();
    const { canvas, ctx, alva } = this;
    const w = canvas.width;
    const h = canvas.height;

    ctx.drawImage(this.video, 0, 0, w, h);
    if (faceBox) {
      const bw = faceBox.x1 - faceBox.x0;
      const bh = faceBox.y1 - faceBox.y0;
      ctx.fillStyle = '#808080';
      ctx.fillRect(
        (faceBox.x0 - bw * FACE_PAD) * w,
        (faceBox.y0 - bh * FACE_PAD) * h,
        bw * (1 + 2 * FACE_PAD) * w,
        bh * (1 + 2 * FACE_PAD) * h
      );
    }
    const frame = ctx.getImageData(0, 0, w, h);

    // Same calls as AlvaAR.findCameraPose, keeping the status code it discards.
    alva.memImg.write(frame.data);
    const code = alva.system.findCameraPose(alva.memImg.heap.byteOffset, alva.memCam.ptr);
    if (code === 1) {
      const pose = alva.memCam.read(16);
      // Same axis convention as AlvaAR's Three.js connector.
      this.position = [pose[12], -pose[13], -pose[14]];
      this.status = 'tracking';
    } else {
      this.status = code === 2 ? 'reset' : 'initializing';
    }

    const pts = alva.getFramePoints();
    this.points = pts.length;
    ctx.fillStyle = this.status === 'tracking' ? '#3fd6a0' : '#ffffff';
    for (const p of pts) ctx.fillRect(p.x - 1, p.y - 1, 3, 3);

    this.ms = performance.now() - t0;
  }

  reset() {
    if (this.alva) this.alva.reset();
    this.position = null;
  }
}
