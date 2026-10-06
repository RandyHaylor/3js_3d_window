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

// Front-camera formats to choose from. Requested in landscape terms; Safari picks the
// matching sensor preset and rotates it to the phone's orientation. Formats differ in how
// much of the sensor they use, i.e. in field of view.
export const CAMERA_FORMATS = {
  '640x480': [640, 480],
  '1280x960': [1280, 960],
  '1920x1440': [1920, 1440],
  '1920x1080': [1920, 1080],
};

// Starts the front camera. Call synchronously from a user gesture handler.
export function openFrontCamera(video, format = '640x480') {
  const [width, height] = CAMERA_FORMATS[format] ?? CAMERA_FORMATS['640x480'];
  return navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: width }, height: { ideal: height } },
    })
    .then(async (stream) => {
      video.srcObject = stream;
      await video.play();
      return stream;
    });
}

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.lastVideoTime = -1;
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

  // Returns undefined when there is no new video frame, null when no face is found,
  // otherwise { box, a, b, irises, faceMatrix, videoW, videoH }: the face bounding box,
  // the two iris centers, each iris's 4 boundary landmarks, and the metric (cm) face
  // transform as a flat array.
  detect(nowMs) {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return undefined;
    this.lastVideoTime = v.currentTime;
    const res = this.landmarker.detectForVideo(v, nowMs);
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
      videoW: v.videoWidth,
      videoH: v.videoHeight,
    };
  }
}
