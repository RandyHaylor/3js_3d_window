// One cheap downscale per camera frame, shared by face tracking and phone tracking.
// The camera stream keeps its full field of view; each new frame is copied into a small
// canvas with the same aspect ratio and about 640×480's pixel count, using nearest-pixel
// sampling (no smoothing), so every consumer works on ~0.3 MP instead of the full sensor.

const TARGET_PIXELS = 640 * 480;

export class FrameSource {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.ctx = null;
    this.lastTime = -1;
    this.ready = false; // true once the first frame has sized the canvas
  }

  get width() {
    return this.canvas.width;
  }

  get height() {
    return this.canvas.height;
  }

  // Copy the newest video frame into the small canvas. Returns false if there is no new frame.
  grab() {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth || v.currentTime === this.lastTime) return false;
    this.lastTime = v.currentTime;

    const k = Math.min(1, Math.sqrt(TARGET_PIXELS / (v.videoWidth * v.videoHeight)));
    const w = Math.round(v.videoWidth * k);
    const h = Math.round(v.videoHeight * k);
    if (this.canvas.width !== w || this.canvas.height !== h || !this.ctx) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    this.ctx.imageSmoothingEnabled = false; // nearest pixel: cheapest scaling
    this.ctx.drawImage(v, 0, 0, w, h);
    this.ready = true;
    return true;
  }
}
