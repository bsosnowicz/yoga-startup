"use strict";

const fs = require("fs");
const path = require("path");
const { isBodyPart, bodyPartLabel } = require("./memory-schema");

// JEDNO ŹRÓDŁO PRAWDY o asanach: treść (nazwy, skrypty), warstwa metodyczna
// (poziom, czasy trzymania, obciążenia, przeciwwskazania) i progi detekcji
// postawy żyją w asany/<id>.json, nie w kodzie. Powód jest organizacyjny, nie
// techniczny: RFP rozdziela role — warstwę metodyczną dostarcza Zamawiający,
// implementację Wykonawca. Dopóki lista asan siedziała w prozie
// TRAINER_SYSTEM_PROMPT i w rejestrach w posture.js/posture-rules.js, metodyk
// nie miał czego dostarczyć. JSON, nie YAML — projekt świadomie nie ma żadnej
// zależności npm.
//
// Granica nazewnictwa (dokładnie ta sama zasada co w memory-schema.js:
// identyfikatory maszynowe w ASCII vs treść po polsku):
//   - pola geometryczne reguł (type, label, points, min, max, numerator,
//     denominator) zostają po angielsku 1:1 — to KONTRAKT z evaluateRule()
//     w public/pose-detector.js, który dostaje regułę bez żadnego tłumaczenia;
//   - reszta pól jest po polsku, bo edytuje je metodyk, nie programista.
//
// Partie ciała (obciaza, przeciwwskazania_*) używają enuma BODY_PARTS z
// memory-schema.js — tego samego, którym pamięć taguje kontuzje użytkownika.
// Dzięki temu przyszły filtr kontuzji porówna identyfikator z identyfikatorem
// (shoulder_right === shoulder_right), zamiast tłumaczyć jedną listę na drugą.
//
// Wadliwy plik jest POMIJANY z wypisaniem wszystkich błędów naraz, nigdy nie
// wywala procesu (ten sam kontrakt co loadAllCalibrations w calibration.js):
// jedna literówka metodyka nie może położyć serwera, a metodyk ma dostać pełną
// listę poprawek do zrobienia, nie pierwszy napotkany błąd.

const ASANY_DIR = path.join(__dirname, "asany");

const TYPY = ["rozciaganie", "wzmacniajaca", "rownowaga", "relaksacyjna", "oddechowa"];
const POZIOMY = ["niska", "srednia", "wysoka"];
const TYPY_REGUL = ["angle", "ratio"];
// MediaPipe Pose zwraca 33 landmarki, indeksy 0-32 (patrz IDX w public/pose-detector.js).
const MAX_LANDMARK_INDEX = 32;

function isText(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isLandmarkIndex(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_LANDMARK_INDEX;
}

function checkBodyParts(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`pole "${field}" musi być tablicą partii ciała`);
    return;
  }
  value.forEach((part) => {
    if (!isBodyPart(part)) {
      errors.push(`pole "${field}": "${part}" nie jest partią ciała z enuma BODY_PARTS (memory-schema.js)`);
    }
  });
}

// Indeksy w numerator/denominator wskazują pozycje W TABLICY points danej
// strony, nie surowe landmarki MediaPipe (patrz computeRatio w
// pose-detector.js) — stąd osobny zakres walidacji niż isLandmarkIndex.
function checkRatioPair(pair, field, pointsLength, where, errors) {
  if (!Array.isArray(pair) || pair.length !== 2) {
    errors.push(`${where}: "${field}" musi być parą indeksów [i, j]`);
    return;
  }
  pair.forEach((i) => {
    if (!Number.isInteger(i) || i < 0 || i >= pointsLength) {
      errors.push(`${where}: "${field}" wskazuje na indeks ${i} spoza tablicy points (0-${pointsLength - 1})`);
    }
  });
}

function checkRule(rule, index, errors) {
  const where = `detekcja.reguly[${index}]`;
  if (!isText(rule.id)) errors.push(`${where}: brak "id" odchylenia`);
  if (!isText(rule.etykieta)) errors.push(`${where}: brak "etykieta" (nazwa błędu dla trenera)`);
  if (rule.korekta !== undefined && !isText(rule.korekta)) errors.push(`${where}: "korekta" musi być niepustym tekstem`);
  if (!isText(rule.label)) errors.push(`${where}: brak "label" (podpis odczytu na podglądzie kamery)`);
  if (!TYPY_REGUL.includes(rule.type)) errors.push(`${where}: "type" musi być jednym z: ${TYPY_REGUL.join(", ")}`);

  const points = rule.points;
  if (!points || !Array.isArray(points.left) || !Array.isArray(points.right)) {
    errors.push(`${where}: "points" musi mieć tablice "left" i "right"`);
    return;
  }
  if (points.left.length !== points.right.length) {
    errors.push(`${where}: "points.left" i "points.right" muszą mieć tyle samo punktów`);
  }
  [...points.left, ...points.right].forEach((i) => {
    if (!isLandmarkIndex(i)) errors.push(`${where}: indeks landmarku ${i} jest spoza zakresu 0-${MAX_LANDMARK_INDEX}`);
  });

  if (rule.type === "angle" && points.left.length !== 3) {
    errors.push(`${where}: reguła "angle" wymaga dokładnie 3 punktów na stronę [A, B, C]`);
  }
  if (rule.type === "ratio") {
    checkRatioPair(rule.numerator, "numerator", points.left.length, where, errors);
    checkRatioPair(rule.denominator, "denominator", points.left.length, where, errors);
  }

  ["min", "max"].forEach((bound) => {
    if (rule[bound] !== undefined && typeof rule[bound] !== "number") {
      errors.push(`${where}: "${bound}" musi być liczbą`);
    }
  });
  if (rule.min === undefined && rule.max === undefined) {
    errors.push(`${where}: reguła bez "min" i bez "max" nigdy nie wykryje błędu`);
  }
}

function validateAsana(data, expectedId) {
  const errors = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["plik nie zawiera obiektu JSON"];

  if (!isText(data.id)) errors.push('brak pola "id"');
  // id musi zgadzać się z nazwą pliku: po tym samym identyfikatorze nazywane są
  // nagrania kalibracyjne k-NN (calibration/<poseId>.<wariant>.json), więc
  // rozjazd nazwy pliku z id po cichu rozspójniłby oba rejestry.
  else if (data.id !== expectedId) errors.push(`pole "id" ("${data.id}") musi być równe nazwie pliku ("${expectedId}")`);

  if (!isText(data.nazwa)) errors.push('brak pola "nazwa"');
  if (data.sanskryt !== undefined && typeof data.sanskryt !== "string") errors.push('pole "sanskryt" musi być tekstem');
  if (!TYPY.includes(data.typ)) errors.push(`pole "typ" musi być jednym z: ${TYPY.join(", ")}`);
  if (!POZIOMY.includes(data.poziom_min)) errors.push(`pole "poziom_min" musi być jednym z: ${POZIOMY.join(", ")}`);
  if (typeof data.odpoczynkowa !== "boolean") errors.push('pole "odpoczynkowa" musi być true/false');

  if (!Array.isArray(data.slowa_kluczowe) || data.slowa_kluczowe.length === 0) {
    errors.push('pole "slowa_kluczowe" musi być niepustą tablicą (bez nich auto-detekcja nigdy nie wykryje pozycji)');
  } else if (!data.slowa_kluczowe.every(isText)) {
    errors.push('pole "slowa_kluczowe": wszystkie wpisy muszą być niepustymi tekstami');
  }

  checkBodyParts(data.obciaza, "obciaza", errors);
  checkBodyParts(data.przeciwwskazania_twarde, "przeciwwskazania_twarde", errors);
  checkBodyParts(data.przeciwwskazania_miekkie, "przeciwwskazania_miekkie", errors);

  const czasy = data.czasy_trzymania_oddechy;
  if (!czasy || typeof czasy !== "object") {
    errors.push('brak pola "czasy_trzymania_oddechy"');
  } else {
    POZIOMY.forEach((poziom) => {
      if (!Number.isInteger(czasy[poziom]) || czasy[poziom] <= 0) {
        errors.push(`pole "czasy_trzymania_oddechy.${poziom}" musi być dodatnią liczbą całkowitą (oddechy)`);
      }
    });
  }

  const skrypty = data.skrypty;
  if (!skrypty || typeof skrypty !== "object") {
    errors.push('brak pola "skrypty"');
  } else {
    // wejscie jest wymagane: używa go komunikat "rozjazd pozycji"
    // (buildPostureMismatchCue w posture.js) i sekcja [ASANY] w prompcie.
    if (!isText(skrypty.wejscie)) errors.push('brak pola "skrypty.wejscie"');
    ["trzymanie", "wyjscie", "modyfikacja_lagodna"].forEach((klucz) => {
      if (skrypty[klucz] !== undefined && !isText(skrypty[klucz])) {
        errors.push(`pole "skrypty.${klucz}" musi być niepustym tekstem albo zostać pominięte`);
      }
    });
  }

  const detekcja = data.detekcja;
  if (detekcja !== undefined) {
    if (typeof detekcja !== "object" || detekcja === null) {
      errors.push('pole "detekcja" musi być obiektem');
    } else {
      if (typeof detekcja.aktywna !== "boolean") errors.push('pole "detekcja.aktywna" musi być true/false');
      if (!Array.isArray(detekcja.reguly)) {
        errors.push('pole "detekcja.reguly" musi być tablicą');
      } else {
        detekcja.reguly.forEach((rule, i) => checkRule(rule, i, errors));
        const ids = detekcja.reguly.map((r) => r.id);
        ids.forEach((id, i) => {
          if (ids.indexOf(id) !== i) errors.push(`detekcja.reguly: zduplikowane id odchylenia "${id}"`);
        });
      }
    }
  }

  return errors;
}

function loadAsany() {
  if (!fs.existsSync(ASANY_DIR)) {
    console.warn(`Asany: brak katalogu ${ASANY_DIR} — rejestr pozycji jest pusty.`);
    return new Map();
  }
  const byId = new Map();
  const files = fs.readdirSync(ASANY_DIR).filter((f) => f.endsWith(".json")).sort();
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(ASANY_DIR, file), "utf8"));
    } catch (e) {
      console.error(`Asany: pomijam ${file} — nieprawidłowy JSON: ${e.message}`);
      continue;
    }
    const errors = validateAsana(data, path.basename(file, ".json"));
    if (byId.has(data?.id)) errors.push(`id "${data.id}" jest już zajęte przez wcześniej wczytany plik`);
    if (errors.length) {
      console.error(`Asany: pomijam ${file} — ${errors.length} błąd(ów) walidacji:`);
      errors.forEach((message) => console.error(`  - ${message}`));
      continue;
    }
    byId.set(data.id, data);
  }
  console.log(`Asany: wczytano ${byId.size} z ${files.length} plików (${[...byId.keys()].join(", ") || "brak"}).`);
  return byId;
}

// Wczytanie RAZ przy starcie procesu (require cache sprawia, że server.js i
// posture.js widzą ten sam rejestr). Zmiana pliku JSON wymaga restartu
// serwera — świadomie, żeby nie wprowadzać watchera i stanu, który mógłby się
// rozjechać w trakcie trwającej sesji treningowej.
const ASANY = loadAsany();

function listAsany() {
  return [...ASANY.values()];
}

function getAsana(id) {
  return ASANY.get(id) || null;
}

// Tylko pozycje, dla których reguły geometryczne mają sens i są włączone —
// karmi endpoint GET /api/asany/detekcja, czyli klienta MediaPipe.
function getAsanyDoDetekcji() {
  return listAsany().filter((asana) => asana.detekcja?.aktywna && asana.detekcja.reguly?.length > 0);
}

// ---- TWARDY FILTR WYKLUCZEŃ ZDROWOTNYCH ----
// Decyzja "czy ta pozycja może dziś paść" zapada TUTAJ, w kodzie, a nie w
// modelu. Sam wpis o kontuzji w prompcie nie wystarcza: w sesji testowej
// trener, mając w kontekście zgłoszony ból prawego barku, i tak zapowiedział
// psa z głową w dół ("ostrożnie"). Model traktuje takie zdanie jako sugestię,
// filtr traktuje je jako regułę.
//
// Całość jest przecięciem dwóch zbiorów opisanych TYM SAMYM enumem BODY_PARTS:
// aktywne kontuzje z user_injuries (getActiveInjuries w server.js) kontra
// przeciwwskazania_twarde / przeciwwskazania_miekkie z asany/*.json. Żadnego
// dopasowywania tekstu, żadnego zgadywania — porównanie identyfikatorów.

// Kontuzje przychodzą z zapytania, które już filtruje status=eq.active i nie
// SELECT-uje kolumny status. Brak pola traktujemy więc jako "active", ale
// jawne "resolved" i tak odsiewamy — filtr ma być poprawny niezależnie od
// tego, kto go woła.
function activeInjuries(injuries) {
  return (Array.isArray(injuries) ? injuries : []).filter(
    (injury) => injury && isBodyPart(injury.body_part) && (injury.status || "active") === "active"
  );
}

function bodyPartLabels(parts) {
  return parts.map(bodyPartLabel).join(", ");
}

// severity celowo NIE wpływa na decyzję: twarde przeciwwskazanie jest twarde
// niezależnie od nasilenia. Hook zostaje, bo różnicowanie (np. "low" degraduje
// do wersji łagodnej zamiast wykluczać) to decyzja metodyczna Zamawiającego,
// nie programisty — ma być podjęta świadomie, a nie wpisana tu domyślnie.
function severityExcludes(_severity) {
  return true;
}

function filterAsanas(injuries = []) {
  const active = activeInjuries(injuries);
  // "other" z definicji nie mapuje się na żadną partię, więc nie może niczego
  // wykluczyć. Jego note idzie do promptu jako tekst, żeby trener mógł dopytać
  // — zgadywanie partii na podstawie opisu byłoby diagnozowaniem.
  const affected = new Set(
    active.filter((injury) => injury.body_part !== "other" && severityExcludes(injury.severity)).map((injury) => injury.body_part)
  );
  const unmapped = active
    .filter((injury) => injury.body_part === "other" && injury.note)
    .map((injury) => injury.note);

  const available = [];
  const excluded = [];

  for (const asana of listAsany()) {
    const hard = (asana.przeciwwskazania_twarde || []).filter((part) => affected.has(part));
    if (hard.length) {
      excluded.push({ asana, reason: bodyPartLabels(hard) });
      continue;
    }
    const soft = (asana.przeciwwskazania_miekkie || []).filter((part) => affected.has(part));
    if (!soft.length) {
      available.push({ asana, gentleOnly: false, reason: null });
      continue;
    }
    // Miękkie przeciwwskazanie degraduje pozycję do wariantu łagodnego. Gdy
    // metodyk nie opisał takiego wariantu (pole jest opcjonalne), nie ma czym
    // degradować — wtedy wykluczamy, zamiast podać pełną wersję pozycji, na
    // którą użytkownik ma przeciwwskazanie.
    if (!asana.skrypty.modyfikacja_lagodna) {
      excluded.push({ asana, reason: `${bodyPartLabels(soft)} (brak wariantu łagodnego w pliku asany)` });
      continue;
    }
    available.push({ asana, gentleOnly: true, reason: bodyPartLabels(soft) });
  }

  // Pusta lista jest gorsza niż lista niedoskonała: trener bez repertuaru
  // zaczyna improwizować pozycje spoza rejestru, czyli dokładnie te, których
  // nikt nie sprawdził pod kątem przeciwwskazań. Dlatego przy wykluczeniu
  // wszystkiego wracamy do pozycji odpoczynkowych — zawsze w wariancie
  // łagodnym i z jawnym ostrzeżeniem w prompcie.
  const restOnlyFallback = available.length === 0 && excluded.length > 0;
  if (restOnlyFallback) {
    for (const entry of excluded.filter((item) => item.asana.odpoczynkowa)) {
      available.push({ asana: entry.asana, gentleOnly: true, reason: entry.reason });
    }
  }

  return {
    available,
    excluded,
    unmapped,
    restOnlyFallback,
    noSafeAsanas: available.length === 0,
    activeInjuries: active,
  };
}

// Renderuje listę asan do wklejenia w system prompt trenera — ten sam wzorzec
// co bodyPartsForPrompt()/factKeysForPrompt() w memory-schema.js: moduł
// będący źródłem danych sam wie, jak je pokazać modelowi, więc prompt nie
// duplikuje wiedzy o kształcie tych danych.
//
// Bez argumentu renderuje pełny rejestr (zachowanie sprzed filtra) — z tego
// korzysta prompt budowany raz przy starcie, dla providerów bez pamięci.
function renderAsana({ asana, gentleOnly, reason }) {
  const header = asana.sanskryt ? `${asana.nazwa} (${asana.sanskryt})` : asana.nazwa;
  const breaths = POZIOMY.map((poziom) => `${poziom} ${asana.czasy_trzymania_oddechy[poziom]}`).join(" / ");
  const lines = [
    `- ${header} — typ: ${asana.typ}, minimalna kondycja: ${asana.poziom_min}, oddechy w trzymaniu: ${breaths}`,
  ];
  // Wariant łagodny ZASTĘPUJE pełny opis, nie dopełnia go. Gdyby oba trafiły
  // do promptu, model miałby do wyboru wersję pełną i złagodzoną — a wybór
  // między nimi jest właśnie tym, czego mu tutaj nie oddajemy.
  if (gentleOnly) {
    lines.push(`  WYŁĄCZNIE w wersji złagodzonej (użytkownik zgłasza dolegliwość: ${reason}): ${asana.skrypty.modyfikacja_lagodna}`);
    return lines.join("\n");
  }
  lines.push(`  wejście: ${asana.skrypty.wejscie}`);
  if (asana.skrypty.trzymanie) lines.push(`  w trzymaniu: ${asana.skrypty.trzymanie}`);
  if (asana.skrypty.wyjscie) lines.push(`  wyjście: ${asana.skrypty.wyjscie}`);
  if (asana.skrypty.modyfikacja_lagodna) lines.push(`  łagodniej: ${asana.skrypty.modyfikacja_lagodna}`);
  return lines.join("\n");
}

function asanyDoPromptu(filterResult = null) {
  const entries = filterResult
    ? filterResult.available
    : listAsany().map((asana) => ({ asana, gentleOnly: false, reason: null }));
  return entries.map(renderAsana).join("\n");
}

// Lista wykluczonych trafia do promptu razem z powodem — model NIE MOŻE
// udawać, że taka pozycja nie istnieje. Gdy użytkownik sam o nią poprosi,
// milczenie albo "nie znam takiej" brzmi jak awaria aplikacji; łagodna odmowa
// z podaniem powodu brzmi jak trener.
function excludedAsanasToPrompt(filterResult) {
  return (filterResult?.excluded || [])
    .map(({ asana, reason }) => `- ${asana.nazwa} — zgłoszona dolegliwość: ${reason}`)
    .join("\n");
}

module.exports = {
  listAsany,
  getAsana,
  getAsanyDoDetekcji,
  asanyDoPromptu,
  filterAsanas,
  excludedAsanasToPrompt,
  TYPY,
  POZIOMY,
};
