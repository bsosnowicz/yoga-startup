"use strict";

// Przykładowy, celowo mały rejestr — punkt startowy do rozbudowy, gdy
// dojdzie prawdziwa detekcja pozy (kamera + landmarki). Frazy trzymają styl
// TRAINER_SYSTEM_PROMPT w server.js: krótkie zdania, pauzy "...".
//
// UWAGA: `text` poniżej to FALLBACK, nie główne źródło wypowiedzi. Docelowo
// tekst korekty generuje Groq (patrz generateGroqCorrection w server.js) na
// podstawie `label` + styl-guide'u trenera — `text` tutaj ląduje w
// odpowiedzi tylko gdy Groq zawiedzie (brak klucza, błąd sieci, timeout).
// Dzięki temu dodanie nowego odchylenia wymaga tylko `label`; `text` jest
// opcjonalny (jeśli pominięty, fallback używa wygenerowanego zdania z labelu).
//
// 3 ćwiczenia — jedyne z pełnym pokryciem regułami geometrycznymi, patrz
// RULES w public/posture-rules.js. `keywords` służy do wykrycia z
// transkrypcji rozmowy (user.transcription / avatar.transcription w
// index.html), które ćwiczenie aktualnie trwa — zamiast ręcznego wyboru.
const EXERCISES = {
  child_pose: {
    label: "Pozycja dziecka",
    keywords: ["pozycja dziecka", "pozycji dziecka", "pozycję dziecka"],
    // odpoczynkowa: gdy k-NN wykryje TĘ pozycję zamiast zadanej, maszyna
    // stanów (public/posture-state-machine.js) i prompt Groqa (patrz
    // generateGroqMismatchCue w server.js) NIE każą wracać na siłę, tylko
    // pytają, czy wszystko w porządku. entryScript to krótka instrukcja
    // wejścia w TĘ pozycję, użyta gdy jest ona zadana, a user jest gdzie
    // indziej (patrz buildPostureMismatchCue niżej).
    odpoczynkowa: true,
    entryScript: "Usiądź na piętach, pochyl tułów do przodu, czoło na macie, ręce swobodnie przed sobą albo wzdłuż ciała.",
    deviations: {
      hips_too_high: { label: "Biodra za wysoko", text: "Opuść biodra bliżej pięt... pozwól ciału opaść." },
      arms_not_extended: { label: "Ręce za mało wyciągnięte", text: "Wyciągnij ręce dalej przed siebie... poczuj rozciąganie w plecach." },
    },
  },
  downward_dog: {
    label: "Pies z głową w dół",
    keywords: ["pies z głową w dół", "psa z głową w dół", "pies głową w dół", "adho mukha"],
    odpoczynkowa: false,
    entryScript: "Z czworaka unieś biodra do góry, wyprostuj nogi i ręce na tyle, na ile możesz, głowa swobodnie między ramionami.",
    deviations: {
      heels_lifted: { label: "Pięty uniesione", text: "Spróbuj opuścić pięty bliżej maty." },
      shoulders_shrugged: { label: "Barki podniesione do uszu", text: "Odciągnij barki od uszu... wydłuż kark." },
    },
  },
  warrior_2: {
    label: "Wojownik II",
    keywords: ["wojownik ii", "wojownika ii", "wojowniku ii", "wojownik 2", "wojownika 2", "virabhadrasana"],
    odpoczynkowa: false,
    entryScript: "Stań szeroko, przednie kolano ugnij do kąta prostego, tylną nogę wyprostuj, ręce rozłóż na wysokości barków.",
    deviations: {
      front_knee_not_bent: { label: "Przednie kolano za mało ugięte", text: "Ugnij mocniej przednie kolano, aż udo zbliży się do równoległego z podłogą." },
      arms_not_level: { label: "Ręce nie na wysokości barków", text: "Wyrównaj ręce do linii barków... wyciągnij je mocno w przeciwne strony." },
    },
  },
};

const DEFAULT_AFFIRMATION_TEXT = "Świetnie, dokładnie tak... utrzymaj tę pozycję.";

function buildPostureCue(exerciseKey, deviationKey) {
  const exercise = EXERCISES[exerciseKey];
  const deviation = exercise?.deviations[deviationKey];
  if (!deviation) return null;
  return {
    exercise: exerciseKey,
    exerciseLabel: exercise.label,
    deviation: deviationKey,
    deviationLabel: deviation.label,
    text: deviation.text || `Zwróć uwagę: ${deviation.label.toLowerCase()}.`,
  };
}

// Pochwała, gdy WSZYSTKIE reguły danego ćwiczenia są spełnione (patrz
// affirmationDebouncer w index.html) — symetryczne do buildPostureCue, ten
// sam fallback-first kontrakt.
function buildPostureAffirmation(exerciseKey) {
  const exercise = EXERCISES[exerciseKey];
  if (!exercise) return null;
  return { exercise: exerciseKey, exerciseLabel: exercise.label, text: DEFAULT_AFFIRMATION_TEXT };
}

// Komunikat "rozjazd pozycji" — k-NN (public/knn.js) stabilnie widzi
// detectedKey zamiast zadanego targetKey (public/posture-state-machine.js,
// stan MISMATCH). `text` to fallback (jak w buildPostureCue) — Groq
// (generateGroqMismatchCue w server.js) go nadpisuje, gdy się powiedzie.
// Dwa warianty tekstu zależnie od EXERCISES[detectedKey].odpoczynkowa: gdy
// wykryta pozycja jest odpoczynkowa (child_pose), pytamy o samopoczucie
// zamiast komenderować powrotem.
function buildPostureMismatchCue(targetKey, detectedKey) {
  const target = EXERCISES[targetKey];
  const detected = EXERCISES[detectedKey];
  if (!target || !detected) return null;
  const restful = !!detected.odpoczynkowa;
  const text = restful
    ? `Widzę, że przeszedłeś do pozycji ${detected.label.toLowerCase()}... czy wszystko w porządku? Kiedy będziesz gotowy, wróćmy do ${target.label.toLowerCase()}.`
    : `Widzę, że jesteś w pozycji ${detected.label.toLowerCase()}, a prosiłem o ${target.label.toLowerCase()}... żeby przejść: ${target.entryScript}`;
  return {
    target: targetKey,
    targetLabel: target.label,
    detected: detectedKey,
    detectedLabel: detected.label,
    restful,
    entryScript: target.entryScript || "",
    text,
  };
}

function listExerciseCues() {
  return Object.entries(EXERCISES).map(([key, exercise]) => ({
    key,
    label: exercise.label,
    keywords: exercise.keywords,
    deviations: Object.entries(exercise.deviations).map(([devKey, dev]) => ({ key: devKey, label: dev.label })),
  }));
}

module.exports = { buildPostureCue, buildPostureAffirmation, listExerciseCues, buildPostureMismatchCue };
