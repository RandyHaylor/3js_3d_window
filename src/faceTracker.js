import {
  FaceLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Iris centers, each followed by its 4 boundary landmarks (469–472, 474–477).
const IRIS_A = 468;
const IRIS_B = 473;

// Standard camera sizes offered in Settings (landscape terms; the browser rotates them to
// the device's orientation). Some webcams crop at small sizes; larger ones may keep the
// full field of view. 640×480 (0.3 MP) is the smallest offered.
export const CAMERA_SIZES = [
  [640, 480],
  [960, 720],
  [1280, 720],
  [1280, 960],
  [1920, 1080],
  [1920, 1440],
  [2560, 1440],
  [3840, 2160],
  [4032, 3024],
];

// Sizes the camera can deliver, from its reported capabilities (all sizes if unknown),
// largest first. caps: MediaStreamTrack.getCapabilities() result or null.
export function availableCameraSizes(caps) {
  const maxW = caps?.width?.max;
  const maxH = caps?.height?.max;
  const long = maxW && maxH ? Math.max(maxW, maxH) : Infinity;
  const short = maxW && maxH ? Math.min(maxW, maxH) : Infinity;
  return CAMERA_SIZES.filter(([w, h]) => w <= long && h <= short).reverse();
}

// Starts the front camera at the requested size ('WxH'), or the nearest the camera offers.
// Call synchronously from a user gesture handler. Resolves to { stream, caps }.
export function openFrontCamera(video, size = '640x480') {
  const [width, height] = size.split('x').map(Number);
  return navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: width }, height: { ideal: height } },
    })
    .then(async (stream) => {
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      const caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
      return { stream, caps };
    });
}

export class FaceTracker {
  // frames: a FrameSource (the downscaled camera frame shared with phone tracking).
  constructor(frames) {
    this.frames = frames;
    this.landmarker = null;
    this.delegate = null;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
      this.delegate = 'GPU';
    } catch (err) {
      console.warn('GPU delegate failed, falling back to CPU', err);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
      this.delegate = 'CPU';
    }
  }

  // Run on the frame just grabbed by the FrameSource. Returns undefined before the model is
  // ready, null when no face is found, otherwise { box, a, b, irises, faceMatrix, videoW,
  // videoH }: the face bounding box, the two iris centers, each iris's 4 boundary landmarks,
  // and the metric (cm) face transform as a flat array. videoW/H are the frame's size.
  detect(nowMs) {
    if (!this.landmarker) return undefined;
    const f = this.frames;
    const res = this.landmarker.detectForVideo(f.canvas, nowMs);
    const lm = res.faceLandmarks?.[0];
    if (!lm || lm.length <= IRIS_B + 4) return null;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of lm) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    return {
      box: { x0, y0, x1, y1 }, // normalized face bounding box
      a: lm[IRIS_A],
      b: lm[IRIS_B],
      irises: [lm.slice(IRIS_A + 1, IRIS_A + 5), lm.slice(IRIS_B + 1, IRIS_B + 5)],
      faceMatrix: res.facialTransformationMatrixes?.[0]?.data ?? null,
      videoW: f.width,
      videoH: f.height,
    };
  }
}
