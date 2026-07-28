// MediaPipe Pose (100% w przeglądarce, bez konta/klucza) — silnik oceny
// reguł geometrycznych do wykrywania "grubych błędów" postawy, PoC, nie
// pełna biomechanika. API zweryfikowane na developers.google.com/edge/mediapipe.
// Same reguły (CO mierzymy, jakie progi) żyją deklaratywnie w
// posture-rules.js — 6 z 8 odchyleń z posture.js ma tu regułę (patrz
// komentarz przy RULES w posture-rules.js dla reszty).
//
// Landmarki (33 punkty, indeksy MediaPipe Pose):
export const IDX = {
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

const MIN_VISIBILITY = 0.6;

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
function computeAngle(a, b, c) {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const magAB = Math.hypot(abx, aby);
  const magCB = Math.hypot(cbx, cby);
  if (magAB === 0 || magCB === 0) return null;
  const cos = Math.min(1, Math.max(-1, (abx * cbx + aby * cby) / (magAB * magCB)));
  return (Math.acos(cos) * 180) / Math.PI;
}

// Znormalizowany stosunek odległości dwóch par punktów, np. (bark.y-ucho.y) /
// (biodro.y-bark.y). `points` to landmarki JUŻ wybrane po stronie ciała
// (patrz evaluateRule); numerator/denominator to indeksy W TEJ tablicy, nie
// surowe indeksy MediaPipe.
function computeRatio(points, rule) {
  const [nA, nB] = rule.numerator;
  const [dA, dB] = rule.denominator;
  const denom = points[dB].y - points[dA].y;
  if (denom <= 0) return null;
  return (points[nB].y - points[nA].y) / denom;
}

function formatValue(value, type) {
  return type === "angle" ? `${Math.round(value)}°` : value.toFixed(2);
}

// Wygładza N ostatnich surowych wartości (kąt/ratio) PRZED porównaniem z
// progiem min/max — łagodzi drganie klatka-do-klatki z samego MediaPipe. To
// INNY mechanizm niż createDeviationDebouncer niżej: tamten wygładza w czasie
// WYNIK bool (active), ten wygładza samą liczbę, wcześniej w potoku. Brak
// wywołania smooth() dla klucza w danej klatce (punkt niewidoczny) nie czyści
// bufora — pojedyncza migawka niskiej pewności nie zeruje całego okna.
// Wołający musi jawnie wyczyścić bufor przy zmianie ćwiczenia (reset()), żeby
// nie mieszać wygładzonych wartości z innej pozycji wykonywanej wcześniej.
export function createValueSmoother(windowSize = 5) {
  const buffers = new Map(); // `${exercise}:${deviation}` -> number[]
  return {
    smooth(key, rawValue) {
      const buf = buffers.get(key) ?? [];
      buf.push(rawValue);
      if (buf.length > windowSize) buf.shift();
      buffers.set(key, buf);
      return buf.reduce((sum, v) => sum + v, 0) / buf.length;
    },
    reset() {
      buffers.clear();
    },
  };
}

// Silnik generyczny nad deklaratywną regułą (kształt reguły patrz
// posture-rules.js) — te same 3 kroki, które dawniej robiła każda reguła
// osobno "z ręki": wybierz widoczną stronę, policz surową wartość (kąt albo
// ratio), porównaj z min/max. Zwraca { active, value, label } — ten sam
// kontrakt co dawne funkcje reguł, więc wołający (index.html) zmienia się
// minimalnie. `smoother`/`key` opcjonalne — bez nich ocena leci na surowej
// wartości.
export function evaluateRule(rule, landmarks, smoother, key) {
  const sideIndices = pickVisibleSide(landmarks, rule.points.left, rule.points.right);
  const points = sideIndices.map((i) => landmarks[i]);
  if (points.some((p) => !visible(p))) return { active: false, value: null, label: rule.label };
  const raw = rule.type === "angle"
    ? computeAngle(points[0], points[1], points[2])
    : computeRatio(points, rule);
  if (raw === null) return { active: false, value: null, label: rule.label };
  const smoothed = smoother ? smoother.smooth(key, raw) : raw;
  const active = (rule.min !== undefined && smoothed < rule.min) ||
                 (rule.max !== undefined && smoothed > rule.max);
  return { active, value: formatValue(smoothed, rule.type), label: rule.label };
}

// Unia punktów wszystkich reguł danego ćwiczenia — do podświetlenia na
// podglądzie kamery, żeby było widać CO dokładnie jest mierzone. Wyprowadzone
// z RULES (posture-rules.js) zamiast ręcznie utrzymywane osobno, żeby nowa
// reguła nie mogła po cichu rozjechać się z tym, co faktycznie się
// podświetla.
export function deriveHighlightIndices(rules) {
  return Object.fromEntries(
    Object.entries(rules).map(([exercise, deviations]) => [
      exercise,
      [...new Set(Object.values(deviations).flatMap((r) => [...r.points.left, ...r.points.right]))],
    ])
  );
}

// Przesuwa landmarki tak, by środek bioder był w (0,0), i przeskalowuje przez
// odległość środek-bioder<->środek-barków — dopiero po tym odległości między
// punktami są porównywalne niezależnie od odległości usera od kamery i jego
// proporcji ciała. Współdzielona przez zapis kalibracji (knn.js, budowa
// danych treningowych) i klasyfikację na żywo (knn.js, classify()) — jedna
// implementacja, żeby obie strony liczyły dokładnie to samo. Pisze do
// buforów podanych przez wołającego (outXY: Float32Array długości 66, x,y na
// zmianę; outVisMask: Float32Array długości 33) zamiast alokować — pozwala
// wołać to bez alokacji w gorącej pętli klasyfikacji. Zwraca false (bufory
// niezmienione), gdy klatka jest nienormalizowalna (brak obu bioder LUB
// brak obu barków LUB odległość między nimi ~0) — wołający traktuje to jak
// "nieznana pozycja".
export function normalizeLandmarksXY(landmarks, outXY, outVisMask) {
  const lh = landmarks[IDX.leftHip], rh = landmarks[IDX.rightHip];
  const ls = landmarks[IDX.leftShoulder], rs = landmarks[IDX.rightShoulder];
  const lhOk = visible(lh), rhOk = visible(rh);
  const lsOk = visible(ls), rsOk = visible(rs);
  if (!lhOk && !rhOk) return false;
  if (!lsOk && !rsOk) return false;
  const hipN = (lhOk ? 1 : 0) + (rhOk ? 1 : 0);
  const hipCX = ((lhOk ? lh.x : 0) + (rhOk ? rh.x : 0)) / hipN;
  const hipCY = ((lhOk ? lh.y : 0) + (rhOk ? rh.y : 0)) / hipN;
  const shN = (lsOk ? 1 : 0) + (rsOk ? 1 : 0);
  const shCX = ((lsOk ? ls.x : 0) + (rsOk ? rs.x : 0)) / shN;
  const shCY = ((lsOk ? ls.y : 0) + (rsOk ? rs.y : 0)) / shN;
  const scale = Math.hypot(shCX - hipCX, shCY - hipCY);
  if (!(scale > 1e-4)) return false;
  for (let i = 0; i < 33; i++) {
    const p = landmarks[i];
    outXY[i * 2] = (p.x - hipCX) / scale;
    outXY[i * 2 + 1] = (p.y - hipCY) / scale;
    outVisMask[i] = visible(p) ? 1 : 0;
  }
  return true;
}

// Predefiniowana lista stawów do trybu kalibracyjnego (?calibrate=1) —
// każdy jako trójka indeksów [A,B,C] dla computeAngle (kąt w B). "Biodra" i
// "tułów-udo" to przy dostępnych landmarkach TEN SAM kąt (bark-biodro-kolano)
// — bez dodatkowego punktu odniesienia nie da się ich rozróżnić geometrycznie,
// stąd jedna seria left_hip/right_hip zamiast dwóch.
const CALIBRATION_JOINTS = {
  left_elbow: [IDX.leftShoulder, IDX.leftElbow, IDX.leftWrist],
  right_elbow: [IDX.rightShoulder, IDX.rightElbow, IDX.rightWrist],
  left_shoulder: [IDX.leftElbow, IDX.leftShoulder, IDX.leftHip],
  right_shoulder: [IDX.rightElbow, IDX.rightShoulder, IDX.rightHip],
  left_hip: [IDX.leftShoulder, IDX.leftHip, IDX.leftKnee],
  right_hip: [IDX.rightShoulder, IDX.rightHip, IDX.rightKnee],
  left_knee: [IDX.leftHip, IDX.leftKnee, IDX.leftAnkle],
  right_knee: [IDX.rightHip, IDX.rightKnee, IDX.rightAnkle],
};

// Podsumowanie po nagraniu kalibracyjnym (tryb ?calibrate=1): dla każdego
// stawu z CALIBRATION_JOINTS, po klatkach o widoczności WSZYSTKICH 3 punktów
// >= 0.6 (ta sama reguła co evaluateRule/visible wyżej) — min/max/średnia/
// odchylenie standardowe kąta. Staw pomijany w wyniku, gdy żadna klatka nie
// miała kompletu widocznych punktów (np. user odwrócony bokiem).
export function summarizeCalibrationAngles(samples) {
  const aggregates = {};
  for (const [jointName, [a, b, c]] of Object.entries(CALIBRATION_JOINTS)) {
    const values = [];
    for (const sample of samples) {
      const pa = sample.landmarks[a], pb = sample.landmarks[b], pc = sample.landmarks[c];
      if (!visible(pa) || !visible(pb) || !visible(pc)) continue;
      const angle = computeAngle(pa, pb, pc);
      if (angle !== null) values.push(angle);
    }
    if (values.length === 0) continue;
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    aggregates[jointName] = {
      min: Math.min(...values),
      max: Math.max(...values),
      mean,
      stddev: Math.sqrt(variance),
      sampleCount: values.length,
    };
  }
  return aggregates;
}

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
