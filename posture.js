"use strict";

const { getAsana, listAsany } = require("./asany");

// Buduje teksty korekt/pochwał/rozjazdu pozycji z rejestru asan
// (asany/*.json, patrz asany.js) — sam nie zna ŻADNEJ pozycji. Dawniej
// trzymał tu własny rejestr EXERCISES, przez co ta sama pozycja była
// zdefiniowana w trzech miejscach naraz (tu, w public/posture-rules.js i w
// prozie TRAINER_SYSTEM_PROMPT), a metodyk nie miał gdzie tego dostarczyć.
//
// UWAGA: `korekta` w regule to FALLBACK, nie główne źródło wypowiedzi.
// Docelowo tekst korekty generuje Groq (patrz generateGroqCorrection w
// server.js) na podstawie `etykieta` + styl-guide'u trenera — `korekta` ląduje
// w odpowiedzi tylko gdy Groq zawiedzie (brak klucza, błąd sieci, timeout).
// Dlatego jest opcjonalna: bez niej fallback składa zdanie z samej etykiety.

const DEFAULT_AFFIRMATION_TEXT = "Świetnie, dokładnie tak... utrzymaj tę pozycję.";

// Odchylenia postawy = reguły detekcji danej asany. Jedna reguła opisuje i CO
// mierzymy (progi), i JAK to nazwać użytkownikowi (etykieta/korekta) — to ten
// sam byt, więc nie rozbijamy go na dwa rejestry.
function deviationsOf(asana) {
  return asana?.detekcja?.reguly ?? [];
}

function findDeviation(asana, deviationKey) {
  return deviationsOf(asana).find((rule) => rule.id === deviationKey) || null;
}

function buildPostureCue(exerciseKey, deviationKey) {
  const asana = getAsana(exerciseKey);
  const deviation = findDeviation(asana, deviationKey);
  if (!deviation) return null;
  return {
    exercise: exerciseKey,
    exerciseLabel: asana.nazwa,
    deviation: deviationKey,
    deviationLabel: deviation.etykieta,
    text: deviation.korekta || `Zwróć uwagę: ${deviation.etykieta.toLowerCase()}.`,
  };
}

// Pochwała, gdy WSZYSTKIE reguły danego ćwiczenia są spełnione (patrz
// affirmationDebouncer w index.html) — symetryczne do buildPostureCue, ten
// sam fallback-first kontrakt.
function buildPostureAffirmation(exerciseKey) {
  const asana = getAsana(exerciseKey);
  if (!asana) return null;
  return { exercise: exerciseKey, exerciseLabel: asana.nazwa, text: DEFAULT_AFFIRMATION_TEXT };
}

// Komunikat "rozjazd pozycji" — k-NN (public/knn.js) stabilnie widzi
// detectedKey zamiast zadanego targetKey (public/posture-state-machine.js,
// stan MISMATCH). `text` to fallback (jak w buildPostureCue) — Groq
// (generateGroqMismatchCue w server.js) go nadpisuje, gdy się powiedzie.
// Dwa warianty tekstu zależnie od pola `odpoczynkowa` wykrytej asany: gdy jest
// odpoczynkowa (child_pose), pytamy o samopoczucie zamiast komenderować powrotem.
function buildPostureMismatchCue(targetKey, detectedKey) {
  const target = getAsana(targetKey);
  const detected = getAsana(detectedKey);
  if (!target || !detected) return null;
  const restful = !!detected.odpoczynkowa;
  const entryScript = target.skrypty?.wejscie || "";
  const text = restful
    ? `Widzę, że przeszedłeś do pozycji ${detected.nazwa.toLowerCase()}... czy wszystko w porządku? Kiedy będziesz gotowy, wróćmy do ${target.nazwa.toLowerCase()}.`
    : `Widzę, że jesteś w pozycji ${detected.nazwa.toLowerCase()}, a prosiłem o ${target.nazwa.toLowerCase()}... żeby przejść: ${entryScript}`;
  return {
    target: targetKey,
    targetLabel: target.nazwa,
    detected: detectedKey,
    detectedLabel: detected.nazwa,
    restful,
    entryScript,
    text,
  };
}

// Kontrakt tego kształtu (key/label/keywords/deviations) konsumuje przeglądarka
// przez GET /api/posture-cues: auto-detekcja ćwiczenia z transkrypcji i
// dropdown w trybie kalibracji.
function listExerciseCues() {
  return listAsany().map((asana) => ({
    key: asana.id,
    label: asana.nazwa,
    keywords: asana.slowa_kluczowe,
    deviations: deviationsOf(asana).map((rule) => ({ key: rule.id, label: rule.etykieta })),
  }));
}

module.exports = { buildPostureCue, buildPostureAffirmation, listExerciseCues, buildPostureMismatchCue };
