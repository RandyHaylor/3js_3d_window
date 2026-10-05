import {
  FaceLandmarker,
  FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const IRIS_A = 468;
const IRIS_B = 473;

// Starts the front camera. Call synchronously from a user gesture handler.
export function openFrontCamera(video) {
  return navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
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
      outputFacialTransformationMatrixes: false,
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
  // otherwise { a, b, videoW, videoH } with the two iris-center landmarks.
  detect(nowMs) {
    const v = this.video;
    if (!this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return undefined;
    this.lastVideoTime = v.currentTime;
    const res = this.landmarker.detectForVideo(v, nowMs);
    const lm = res.faceLandmarks?.[0];
    if (!lm || lm.length <= IRIS_B) return null;
    return { a: lm[IRIS_A], b: lm[IRIS_B], videoW: v.videoWidth, videoH: v.videoHeight };
  }
}
