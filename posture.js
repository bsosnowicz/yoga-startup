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
// Tylko 2 ćwiczenia — jedyne z pełnym pokryciem regułami geometrycznymi w
// pose-detector.js (patrz RULES tam). `keywords` służy do wykrycia z
// transkrypcji rozmowy (user.transcription / avatar.transcription w
// index.html), które ćwiczenie aktualnie trwa — zamiast ręcznego wyboru.
const EXERCISES = {
  child_pose: {
    label: "Pozycja dziecka",
    keywords: ["pozycja dziecka", "pozycji dziecka", "pozycję dziecka"],
    deviations: {
      hips_too_high: { label: "Biodra za wysoko", text: "Opuść biodra bliżej pięt... pozwól ciału opaść." },
      arms_not_extended: { label: "Ręce za mało wyciągnięte", text: "Wyciągnij ręce dalej przed siebie... poczuj rozciąganie w plecach." },
    },
  },
  downward_dog: {
    label: "Pies z głową w dół",
    keywords: ["pies z głową w dół", "psa z głową w dół", "pies głową w dół", "adho mukha"],
    deviations: {
      heels_lifted: { label: "Pięty uniesione", text: "Spróbuj opuścić pięty bliżej maty." },
      shoulders_shrugged: { label: "Barki podniesione do uszu", text: "Odciągnij barki od uszu... wydłuż kark." },
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

function listExerciseCues() {
  return Object.entries(EXERCISES).map(([key, exercise]) => ({
    key,
    label: exercise.label,
    keywords: exercise.keywords,
    deviations: Object.entries(exercise.deviations).map(([devKey, dev]) => ({ key: devKey, label: dev.label })),
  }));
}

module.exports = { buildPostureCue, buildPostureAffirmation, listExerciseCues };
