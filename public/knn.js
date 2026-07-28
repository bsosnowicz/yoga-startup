// Klasyfikator k-NN pozycji jogi na podstawie landmarków bieżącej klatki
// względem próbek zebranych w trybie kalibracyjnym (?calibrate=1, patrz
// index.html + calibration.js). Niezależny tor od reguł kątowych/ratio w
// pose-detector.js/posture-rules.js — te oceniają ODCHYLENIA w ramach
// zadanej pozycji co klatkę; ten tor rozpoznaje SAMĄ pozycję (niezależnie od
// tego, co powiedział trener), throttlowany w index.html (co
// KNN_CLASSIFY_EVERY_N_FRAMES klatek), żeby nie liczyć dystansu do setek
// próbek 30x/s.
//
// Warianty "pelna"/"zlagodzona" tej samej pozycji trafiają do JEDNEJ klasy
// (poseId) — wariant to tylko organizacja plików/progów kątowych, nie osobna
// tożsamość pozycji (maszyna stanów porównuje zadana_pozycja z wykrytą na
// poziomie poseId).
import { normalizeLandmarksXY } from "./pose-detector.js";

export const K = 5;
export const CONFIDENCE_THRESHOLD = 0.6;
const POINTS = 33;
const FLOATS = POINTS * 2;

// Tworzy klasyfikator z buforami wielokrotnego użytku (queryXY/queryVis/
// bestDist/bestLabelIdx/voteCounts) alokowanymi raz — classify() woła się
// throttlowanie, ale wciąż w gorącej ścieżce onFrame, więc zero alokacji tam.
export function createKnnClassifier() {
  let trainXY = null;
  let trainVis = null;
  let trainLabels = null;
  let labelNames = [];
  let sampleCount = 0;

  const queryXY = new Float32Array(FLOATS);
  const queryVis = new Float32Array(POINTS);
  const bestDist = new Float32Array(K);
  const bestLabelIdx = new Int32Array(K);
  let voteCounts = new Int32Array(0);

  // calibrations to tablica obiektów z GET /api/calibration ({poseId,
  // variant, poseLabel, recordings:[{samples:[{landmarks}]}]}). Alokacje tu
  // są OK — dzieje się raz przy starcie/po nowej kalibracji, nie per klatkę.
  function loadTrainingData(calibrations) {
    const rows = [];
    const labelSet = [];
    for (const file of calibrations) {
      let li = labelSet.indexOf(file.poseId);
      if (li === -1) {
        labelSet.push(file.poseId);
        li = labelSet.length - 1;
      }
      for (const rec of file.recordings || []) {
        for (const sample of rec.samples || []) {
          rows.push({ landmarks: sample.landmarks, labelIdx: li });
        }
      }
    }
    labelNames = labelSet;
    voteCounts = new Int32Array(labelNames.length);
    trainXY = new Float32Array(rows.length * FLOATS);
    trainVis = new Float32Array(rows.length * POINTS);
    trainLabels = new Int32Array(rows.length);
    const tmpXY = new Float32Array(FLOATS);
    const tmpVis = new Float32Array(POINTS);
    let w = 0;
    for (const row of rows) {
      if (!normalizeLandmarksXY(row.landmarks, tmpXY, tmpVis)) continue; // pomiń nienormalizowalną klatkę kalibracji
      trainXY.set(tmpXY, w * FLOATS);
      trainVis.set(tmpVis, w * POINTS);
      trainLabels[w] = row.labelIdx;
      w++;
    }
    sampleCount = w;
    return { sampleCount, labelNames: [...labelNames] };
  }

  function isReady() {
    return sampleCount > 0;
  }

  // Zwraca { label: string|null, confidence } gdy klasyfikator ma dane
  // (label=null => "nieznana pozycja", user w przejściu — normalny stan).
  // Zwraca null WYŁĄCZNIE gdy brak danych treningowych — wołający musi
  // sprawdzić isReady() PRZED wywołaniem w gorącej pętli (patrz index.html).
  function classify(landmarks) {
    if (sampleCount === 0) return null;
    if (!normalizeLandmarksXY(landmarks, queryXY, queryVis)) return { label: null, confidence: 0 };

    for (let k = 0; k < K; k++) {
      bestDist[k] = Infinity;
      bestLabelIdx[k] = -1;
    }

    // Dystans = średni kwadrat błędu liczony TYLKO po punktach widocznych
    // jednocześnie w zapytaniu i próbce — próbki z różną liczbą widocznych
    // punktów są dzięki temu porównywalne (suma zamiast średniej faworyzowałaby
    // próbki z mniejszą liczbą porównanych punktów).
    for (let s = 0; s < sampleCount; s++) {
      const base = s * FLOATS, visBase = s * POINTS;
      let sumSq = 0, compared = 0;
      for (let p = 0; p < POINTS; p++) {
        if (queryVis[p] === 0 || trainVis[visBase + p] === 0) continue;
        const dx = queryXY[p * 2] - trainXY[base + p * 2];
        const dy = queryXY[p * 2 + 1] - trainXY[base + p * 2 + 1];
        sumSq += dx * dx + dy * dy;
        compared++;
      }
      if (compared === 0) continue;
      const dist = sumSq / compared;
      if (dist < bestDist[K - 1]) {
        let i = K - 1;
        while (i > 0 && bestDist[i - 1] > dist) {
          bestDist[i] = bestDist[i - 1];
          bestLabelIdx[i] = bestLabelIdx[i - 1];
          i--;
        }
        bestDist[i] = dist;
        bestLabelIdx[i] = trainLabels[s];
      }
    }

    voteCounts.fill(0);
    let validVotes = 0;
    for (let k = 0; k < K; k++) {
      if (bestLabelIdx[k] === -1) continue;
      voteCounts[bestLabelIdx[k]]++;
      validVotes++;
    }
    if (validVotes === 0) return { label: null, confidence: 0 };
    let winner = -1, winnerVotes = 0;
    for (let i = 0; i < voteCounts.length; i++) {
      if (voteCounts[i] > winnerVotes) {
        winnerVotes = voteCounts[i];
        winner = i;
      }
    }
    const confidence = winnerVotes / validVotes;
    return confidence < CONFIDENCE_THRESHOLD
      ? { label: null, confidence }
      : { label: labelNames[winner], confidence };
  }

  return { loadTrainingData, isReady, classify };
}
