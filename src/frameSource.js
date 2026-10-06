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
    // When the grabbed frame was captured (seconds, performance.now() timeline) and where
    // that came from: 'capture' (the camera's own capture time), 'presented' (when the
    // browser presented the frame) or 'grabbed' (when we copied it; no frame callback).
    this.frameT = 0;
    this.timeSource = 'grabbed';
    this.meta = null; // latest per-frame metadata from requestVideoFrameCallback
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = (now, meta) => {
        this.meta = meta;
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
    }
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
    const m = this.meta;
    if (m && typeof m.captureTime === 'number' && m.captureTime > 0) {
      this.frameT = m.captureTime / 1000;
      this.timeSource = 'capture';
    } else if (m && typeof m.presentationTime === 'number' && m.presentationTime > 0) {
      this.frameT = m.presentationTime / 1000;
      this.timeSource = 'presented';
    } else {
      this.frameT = performance.now() / 1000;
      this.timeSource = 'grabbed';
    }
    const now = performance.now() / 1000;
    if (!(this.frameT <= now && now - this.frameT < 1)) {
      this.frameT = now; // a time off this clock: use the grab time
      this.timeSource = 'grabbed';
    }

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
