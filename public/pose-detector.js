// MediaPipe Pose (100% w przeglądarce, bez konta/klucza) + reguły geometryczne
// do wykrywania "grubych błędów" postawy — PoC, nie pełna biomechanika. API
// zweryfikowane na developers.google.com/edge/mediapipe. 4 z 6 odchyleń z
// posture.js mają tu regułę (patrz komentarz przy RULES niżej dla reszty).
//
// Landmarki (33 punkty, indeksy MediaPipe Pose):
const IDX = {
  leftEar: 7, rightEar: 8,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
};

const MIN_VISIBILITY = 0.5;

function visible(point) {
  return !!point && (point.visibility === undefined || point.visibility >= MIN_VISIBILITY);
}

// Wybiera stronę ciała (lewa/prawa) lepiej widoczną dla kamery — pomaga przy
// ustawieniu pod kątem, gdzie jedna strona bywa częściowo zasłonięta.
function pickVisibleSide(landmarks, leftSet, rightSet) {
  const sum = (set) => set.reduce((total, i) => total + (landmarks[i]?.visibility ?? 0), 0);
  return sum(rightSet) > sum(leftSet) ? rightSet : leftSet;
}

// Kąt w punkcie b, między odcinkami b-a i b-c, w stopniach.
export function angleAt(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const magAB = Math.hypot(abx, aby);
  const magCB = Math.hypot(cbx, cby);
  if (magAB === 0 || magCB === 0) return null;
  const cos = Math.min(1, Math.max(-1, (abx * cbx + aby * cby) / (magAB * magCB)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// Każda reguła zwraca { active, value, label } zamiast gołego boola — `value`
// i `label` służą tylko do podglądu na żywo (kalibracja progów), `active`
// zasila debouncer/sendPostureCue tak jak wcześniej.

// child_pose / arms_not_extended — kąt w łokciu (ramię-łokieć-nadgarstek).
// Wyprostowana ręka ~180°, wyraźnie ugięta/schowana < 140°.
function armsNotExtended(landmarks) {
  const label = "kąt łokcia";
  const [shoulderI, elbowI, wristI] = pickVisibleSide(
    landmarks,
    [IDX.leftShoulder, IDX.leftElbow, IDX.leftWrist],
    [IDX.rightShoulder, IDX.rightElbow, IDX.rightWrist]
  );
  const shoulder = landmarks[shoulderI], elbow = landmarks[elbowI], wrist = landmarks[wristI];
  if (!visible(shoulder) || !visible(elbow) || !visible(wrist)) return { active: false, value: null, label };
  const angle = angleAt(shoulder, elbow, wrist);
  if (angle === null) return { active: false, value: null, label };
  return { active: angle < 140, value: `${Math.round(angle)}°`, label };
}

// downward_dog / shoulders_shrugged — (ramię.y - ucho.y) / długość tułowia
// (biodro.y - ramię.y). Barki podciągnięte do uszu -> mały stosunek.
function shouldersShrugged(landmarks) {
  const label = "ucho/tułów";
  const [earI, shoulderI, hipI] = pickVisibleSide(
    landmarks,
    [IDX.leftEar, IDX.leftShoulder, IDX.leftHip],
    [IDX.rightEar, IDX.rightShoulder, IDX.rightHip]
  );
  const ear = landmarks[earI], shoulder = landmarks[shoulderI], hip = landmarks[hipI];
  if (!visible(ear) || !visible(shoulder) || !visible(hip)) return { active: false, value: null, label };
  const torsoLength = hip.y - shoulder.y;
  if (torsoLength <= 0) return { active: false, value: null, label };
  const ratio = (shoulder.y - ear.y) / torsoLength;
  return { active: ratio < 0.15, value: ratio.toFixed(2), label };
}

// child_pose / hips_too_high — biodro wyraźnie wyżej niż kolano (znormalizowane
// długością tułowia ramię-biodro). Najlepiej widoczne z boku — z przodu
// kolano i biodro mogą się nakładać na obrazie, więc to zgrubna reguła.
function hipsTooHigh(landmarks) {
  const label = "biodro nad kolanem";
  const [shoulderI, hipI, kneeI] = pickVisibleSide(
    landmarks,
    [IDX.leftShoulder, IDX.leftHip, IDX.leftKnee],
    [IDX.rightShoulder, IDX.rightHip, IDX.rightKnee]
  );
  const shoulder = landmarks[shoulderI], hip = landmarks[hipI], knee = landmarks[kneeI];
  if (!visible(shoulder) || !visible(hip) || !visible(knee)) return { active: false, value: null, label };
  const torsoLength = hip.y - shoulder.y;
  if (torsoLength <= 0) return { active: false, value: null, label };
  const ratio = (knee.y - hip.y) / torsoLength; // dodatnie = biodro wyżej niż kolano
  return { active: ratio > 0.2, value: ratio.toFixed(2), label };
}

// downward_dog / heels_lifted — pięta wyraźnie wyżej niż czubek stopy
// (znormalizowane długością podudzia kolano-kostka). To jedyna z pierwotnie
// "trudnych" reguł, którą jednak da się policzyć bez punktu odniesienia do
// podłogi — MediaPipe ma osobne landmarki na piętę I czubek stopy.
function heelsLifted(landmarks) {
  const label = "pięta nad czubkiem stopy";
  const [kneeI, ankleI, heelI, toeI] = pickVisibleSide(
    landmarks,
    [IDX.leftKnee, IDX.leftAnkle, IDX.leftHeel, IDX.leftFootIndex],
    [IDX.rightKnee, IDX.rightAnkle, IDX.rightHeel, IDX.rightFootIndex]
  );
  const knee = landmarks[kneeI], ankle = landmarks[ankleI], heel = landmarks[heelI], toe = landmarks[toeI];
  if (!visible(knee) || !visible(ankle) || !visible(heel) || !visible(toe)) return { active: false, value: null, label };
  const shinLength = ankle.y - knee.y;
  if (shinLength <= 0) return { active: false, value: null, label };
  const ratio = (toe.y - heel.y) / shinLength; // dodatnie = pięta wyżej niż czubek stopy
  return { active: ratio > 0.25, value: ratio.toFixed(2), label };
}

// Te same klucze co EXERCISES w posture.js — wynik podłącza się wprost pod
// sendPostureCue(exercise, deviation) w index.html. `cat_cow` nie ma tu wpisu
// świadomie: oba jego odchylenia (back_flat, neck_strain) opisują krzywiznę
// kręgosłupa/karku, a MediaPipe Pose nie daje żadnego landmarku na kręgosłup
// (tylko ramiona i biodra — 2 punkty nie pokażą krzywizny) — zostają ręczne
// z dropdowna, zamiast zgadywać niewiarygodną regułę.
export const RULES = {
  child_pose: { arms_not_extended: armsNotExtended, hips_too_high: hipsTooHigh },
  downward_dog: { shoulders_shrugged: shouldersShrugged, heels_lifted: heelsLifted },
};

// Landmarki obserwowane przez reguły danego ćwiczenia — do podświetlenia na
// podglądzie kamery, żeby było widać CO dokładnie jest mierzone.
export const HIGHLIGHT_INDICES = {
  child_pose: [
    IDX.leftShoulder, IDX.rightShoulder, IDX.leftElbow, IDX.rightElbow, IDX.leftWrist, IDX.rightWrist,
    IDX.leftHip, IDX.rightHip, IDX.leftKnee, IDX.rightKnee,
  ],
  downward_dog: [
    IDX.leftEar, IDX.rightEar, IDX.leftShoulder, IDX.rightShoulder, IDX.leftHip, IDX.rightHip,
    IDX.leftKnee, IDX.rightKnee, IDX.leftAnkle, IDX.rightAnkle, IDX.leftHeel, IDX.rightHeel,
    IDX.leftFootIndex, IDX.rightFootIndex,
  ],
};

// Minimalny szkielet do rysowania (pary indeksów) — tors/ręce/nogi/stopy/kark,
// wystarcza do rozpoznania sylwetki, bez pełnych 35 połączeń z demo MediaPipe.
const CONNECTIONS = [
  [IDX.leftShoulder, IDX.rightShoulder],
  [IDX.leftShoulder, IDX.leftElbow], [IDX.leftElbow, IDX.leftWrist],
  [IDX.rightShoulder, IDX.rightElbow], [IDX.rightElbow, IDX.rightWrist],
  [IDX.leftShoulder, IDX.leftHip], [IDX.rightShoulder, IDX.rightHip],
  [IDX.leftHip, IDX.rightHip],
  [IDX.leftHip, IDX.leftKnee], [IDX.leftKnee, IDX.leftAnkle],
  [IDX.rightHip, IDX.rightKnee], [IDX.rightKnee, IDX.rightAnkle],
  [IDX.leftAnkle, IDX.leftHeel], [IDX.leftHeel, IDX.leftFootIndex], [IDX.leftAnkle, IDX.leftFootIndex],
  [IDX.rightAnkle, IDX.rightHeel], [IDX.rightHeel, IDX.rightFootIndex], [IDX.rightAnkle, IDX.rightFootIndex],
  [IDX.leftEar, IDX.leftShoulder], [IDX.rightEar, IDX.rightShoulder],
];

// Rysuje szkielet + punkty landmarków na canvasie w rozmiarze wideo.
// highlightIndices (np. z HIGHLIGHT_INDICES[exercise]) są rysowane większe i
// w innym kolorze — pokazuje, które punkty faktycznie zasilają regułę.
export function drawLandmarks(ctx, landmarks, { width, height, highlightIndices = [] } = {}) {
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0, 220, 120, 0.85)";
  for (const [a, b] of CONNECTIONS) {
    const pa = landmarks[a], pb = landmarks[b];
    if (!visible(pa) || !visible(pb)) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x * width, pa.y * height);
    ctx.lineTo(pb.x * width, pb.y * height);
    ctx.stroke();
  }
  landmarks.forEach((point, i) => {
    if (!visible(point)) return;
    const highlighted = highlightIndices.includes(i);
    ctx.beginPath();
    ctx.fillStyle = highlighted ? "#ff9800" : "#00dc78";
    ctx.arc(point.x * width, point.y * height, highlighted ? 6 : 3.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

// Reguła musi trzymać się `sustainMs` zanim uzna się za potwierdzoną, potem
// `cooldownMs` ciszy dla tej samej pary exercise/deviation — bez tego awatar
// przerywałby się co klatkę przy najmniejszym drgnięciu.
export function createDeviationDebouncer({ sustainMs = 1000, cooldownMs = 15000 } = {}) {
  const state = new Map();
  return {
    check(key, isActive) {
      const now = performance.now();
      const entry = state.get(key) || { since: null, lastFiredAt: -Infinity };
      if (!isActive) {
        entry.since = null;
        state.set(key, entry);
        return false;
      }
      if (entry.since === null) entry.since = now;
      state.set(key, entry);
      const confirmed = now - entry.since >= sustainMs && now - entry.lastFiredAt >= cooldownMs;
      if (confirmed) entry.lastFiredAt = now;
      return confirmed;
    },
  };
}

// Ładuje MediaPipe Pose (lite model) dopiero na wywołanie — kamera i model
// (kilka MB + WASM) nie obciążają strony, dopóki user jawnie nie włączy
// auto-korekty. Wywołuje onFrame(landmarks) dla każdej nowej klatki wideo.
export async function createPoseDetector(videoEl, onFrame) {
  const { FilesetResolver, PoseLandmarker } = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs"
  );
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
  );
  const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    },
    runningMode: "VIDEO",
  });

  let lastVideoTime = -1;
  let stopped = false;
  function renderLoop() {
    if (stopped) return;
    if (videoEl.currentTime !== lastVideoTime) {
      lastVideoTime = videoEl.currentTime;
      const result = poseLandmarker.detectForVideo(videoEl, performance.now());
      if (result.landmarks?.[0]) onFrame(result.landmarks[0]);
    }
    requestAnimationFrame(renderLoop);
  }
  renderLoop();

  return {
    stop() {
      stopped = true;
      poseLandmarker.close();
    },
  };
}
