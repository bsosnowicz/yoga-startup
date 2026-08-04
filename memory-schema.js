"use strict";

// Granica między warstwą MASZYNOWĄ a TEKSTOWĄ pamięci — powód istnienia tego
// pliku. Wszystko, po czym KOD dopasowuje (klucze faktów, partie ciała,
// statusy, severity), jest zamkniętym enumem w ASCII. Wszystko, co trafia
// dosłownie do promptu trenera (value, note, etykiety), jest po polsku i nigdy
// nie jest porównywane w kodzie.
//
// Bez tej granicy model generował klucze swobodnie (walidowana była tylko
// kategoria), więc do bazy trafiały śmieci, a twardy filtr asan nie miał po
// czym dopasowywać: pamięć mówiła "right shoulder", a asany będą tagowane
// enumem partii ciała.

const PROFILE_KEYS = ["name", "age", "fitness_level", "flexibility_level"];

const PREFERENCE_KEYS = [
  "preferred_session_length",
  "preferred_intensity",
  "disliked_poses",
  "favorite_poses",
];

const SESSION_KEYS = [
  "available_time",
  "interrupted",
  "interruption_reason",
  "last_completed_activity",
  "next_activity",
];

// Strona ciała jest częścią identyfikatora (shoulder_left != shoulder_right) —
// filtr asan musi umieć odsiać ćwiczenie obciążające konkretnie lewy bark.
// "other" to celowy wentyl: model, który nie potrafi zmapować zgłoszenia,
// ma je oznaczyć jako other i wrzucić szczegół do `note` (po polsku), zamiast
// zgadywać partię albo pomijać zgłoszenie.
const BODY_PARTS = [
  "shoulder_left",
  "shoulder_right",
  "elbow_left",
  "elbow_right",
  "knee_left",
  "knee_right",
  "wrist_left",
  "wrist_right",
  "ankle_left",
  "ankle_right",
  "hip_left",
  "hip_right",
  "lower_back",
  "upper_back",
  "neck",
  "calf_left",
  "calf_right",
  "hamstring_left",
  "hamstring_right",
  "ribs",
  "other",
];

const INJURY_STATUSES = ["active", "resolved"];
const INJURY_SEVERITIES = ["low", "medium", "high"];

// Poziom sprawności użytkownika — pierwszy fakt, którego WARTOŚĆ jest enumem
// maszynowym, a nie zdaniem po polsku (patrz nagłówek pliku: dotąd granica
// biegła po kluczach, wartości były wyłącznie tekstem do promptu).
// Powód: `poziom_min` asany (asany/*.json) operuje dokładnie na tej skali, więc
// planner i filtr kontuzji muszą móc porównać jedno z drugim. Dopóki pamięć
// zapisywała "początkujący", a asana "niska", nie było czego z czym zestawić.
// Skala jest ASCII (bez ogonków), tak jak wszystkie identyfikatory tutaj —
// polskie brzmienie żyje w FACT_VALUE_META_PL niżej.
const FITNESS_LEVELS = ["niska", "srednia", "wysoka"];

// Rejestr kluczy o zamkniętym zbiorze wartości. Generyczny celowo: dopisanie
// tu `flexibility_level` (albo `preferred_intensity`) to jedna linia, bez
// dotykania walidacji w memory.js.
const FACT_VALUE_ENUMS = {
  fitness_level: FITNESS_LEVELS,
};

// Kategoria "injury" NIE ma kluczy — jest obsługiwana strukturalnie
// (body_part/status/severity/note), osobnym torem niż fakty klucz-wartość.
const FACT_KEYS_BY_CATEGORY = {
  profile: PROFILE_KEYS,
  preference: PREFERENCE_KEYS,
  session: SESSION_KEYS,
};

const FACT_KEY_SETS = Object.fromEntries(
  Object.entries(FACT_KEYS_BY_CATEGORY).map(([category, keys]) => [category, new Set(keys)])
);

const BODY_PART_SET = new Set(BODY_PARTS);
const INJURY_STATUS_SET = new Set(INJURY_STATUSES);
const INJURY_SEVERITY_SET = new Set(INJURY_SEVERITIES);

// Polskie etykiety — WYŁĄCZNIE do tekstu wstrzykiwanego w prompt trenera.
// Kod nigdy nie porównuje po tych stringach (od tego są enumy wyżej).
const BODY_PART_LABELS_PL = {
  shoulder_left: "lewy bark",
  shoulder_right: "prawy bark",
  elbow_left: "lewy łokieć",
  elbow_right: "prawy łokieć",
  knee_left: "lewe kolano",
  knee_right: "prawe kolano",
  wrist_left: "lewy nadgarstek",
  wrist_right: "prawy nadgarstek",
  ankle_left: "lewa kostka",
  ankle_right: "prawa kostka",
  hip_left: "lewe biodro",
  hip_right: "prawe biodro",
  lower_back: "dolny odcinek pleców",
  upper_back: "górny odcinek pleców",
  neck: "kark",
  calf_left: "lewa łydka",
  calf_right: "prawa łydka",
  hamstring_left: "lewa tylna część uda",
  hamstring_right: "prawa tylna część uda",
  ribs: "żebra",
  other: "inna partia",
};

const SEVERITY_LABELS_PL = {
  low: "lekka",
  medium: "umiarkowana",
  high: "silna",
};

// Dwa różne odbiorcy tej samej wartości enuma, stąd dwa pola:
//   etykieta — polskie brzmienie z ogonkami, wstrzykiwane w prompt TRENERA
//     (buildMemoryContext), żeby nie było widać ASCII-owego "srednia";
//   opis — znaczenie dla modelu EKSTRAKCJI, żeby potrafił zmapować swobodną
//     wypowiedź ("jestem początkujący") na właściwą wartość enuma. Mapowanie
//     synonimów należy do modelu, nie do regexpa w kodzie — dokładnie z tego
//     samego powodu, co wykrywanie bólu (patrz komentarz w parseExtraction).
const FITNESS_LEVEL_META_PL = {
  niska: { etykieta: "niska", opis: "początkujący, mało ruchu na co dzień, dawno nie ćwiczył" },
  srednia: { etykieta: "średnia", opis: "ćwiczy od czasu do czasu, przeciętna sprawność" },
  wysoka: { etykieta: "wysoka", opis: "ćwiczy regularnie, dobra sprawność" },
};

const FACT_VALUE_META_PL = {
  fitness_level: FITNESS_LEVEL_META_PL,
};

// Klucze też są identyfikatorami ASCII, a trafiają do promptu dosłownie —
// więc mają swoje polskie etykiety, dokładnie jak partie ciała. W bazie
// zostaje enum (po nim dopasowuje kod), w prompcie widać polski.
const FACT_KEY_LABELS_PL = {
  name: "imię",
  age: "wiek",
  fitness_level: "poziom sprawności",
  flexibility_level: "poziom gibkości",
  preferred_session_length: "preferowana długość sesji",
  preferred_intensity: "preferowana intensywność",
  disliked_poses: "nielubiane pozycje",
  favorite_poses: "ulubione pozycje",
  available_time: "dostępny czas",
  interrupted: "sesja przerwana",
  interruption_reason: "powód przerwania",
  last_completed_activity: "ostatnia wykonana pozycja",
  next_activity: "następna pozycja",
};

function isFactCategory(category) {
  return Object.prototype.hasOwnProperty.call(FACT_KEY_SETS, category);
}

function isAllowedKey(category, key) {
  return isFactCategory(category) && FACT_KEY_SETS[category].has(key);
}

function isBodyPart(value) {
  return BODY_PART_SET.has(value);
}

// Zwraca listę dozwolonych wartości dla klucza albo null, gdy wartość tego
// klucza jest dowolnym tekstem (domyślny przypadek — patrz FACT_VALUE_ENUMS).
function factValueEnum(key) {
  return FACT_VALUE_ENUMS[key] || null;
}

function isFitnessLevel(value) {
  return FITNESS_LEVELS.includes(value);
}

function factValueLabel(key, value) {
  return FACT_VALUE_META_PL[key]?.[value]?.etykieta || value;
}

function isInjuryStatus(value) {
  return INJURY_STATUS_SET.has(value);
}

function isInjurySeverity(value) {
  return INJURY_SEVERITY_SET.has(value);
}

function bodyPartLabel(bodyPart) {
  return BODY_PART_LABELS_PL[bodyPart] || bodyPart;
}

function factKeyLabel(key) {
  return FACT_KEY_LABELS_PL[key] || key;
}

function severityLabel(severity) {
  return SEVERITY_LABELS_PL[severity] || severity;
}

// Listy wklejane do promptu ekstrakcji jako JEDYNE dozwolone wartości. Partie
// ciała idą z polską etykietą w nawiasie — model dostaje enum ASCII do
// zwrócenia i polskie znaczenie, żeby trafnie zmapować polską wypowiedź.
function bodyPartsForPrompt() {
  return BODY_PARTS.map((part) => `${part} (${bodyPartLabel(part)})`).join(", ");
}

function factKeysForPrompt() {
  return Object.entries(FACT_KEYS_BY_CATEGORY)
    .map(([category, keys]) => `${category}: ${keys.join(", ")}`)
    .join("\n  ");
}

// Klucze o zamkniętym zbiorze wartości — model dostaje enum do zwrócenia i
// polski opis znaczenia, tak samo jak przy partiach ciała wyżej.
function factValuesForPrompt() {
  return Object.entries(FACT_VALUE_ENUMS)
    .map(([key, values]) => {
      const opisy = values.map((value) => `"${value}" (${FACT_VALUE_META_PL[key]?.[value]?.opis || value})`);
      return `${key}: ${opisy.join(", ")}`;
    })
    .join("\n  ");
}

module.exports = {
  PROFILE_KEYS,
  PREFERENCE_KEYS,
  SESSION_KEYS,
  BODY_PARTS,
  INJURY_STATUSES,
  INJURY_SEVERITIES,
  FITNESS_LEVELS,
  FACT_VALUE_ENUMS,
  FACT_KEYS_BY_CATEGORY,
  BODY_PART_LABELS_PL,
  SEVERITY_LABELS_PL,
  FACT_KEY_LABELS_PL,
  factKeyLabel,
  isFactCategory,
  isAllowedKey,
  isBodyPart,
  isInjuryStatus,
  isInjurySeverity,
  isFitnessLevel,
  factValueEnum,
  factValueLabel,
  bodyPartLabel,
  severityLabel,
  bodyPartsForPrompt,
  factKeysForPrompt,
  factValuesForPrompt,
};
