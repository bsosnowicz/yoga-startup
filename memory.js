"use strict";

const {
  isFactCategory,
  isAllowedKey,
  isBodyPart,
  isInjuryStatus,
  isInjurySeverity,
  bodyPartLabel,
  severityLabel,
  factKeyLabel,
  bodyPartsForPrompt,
  factKeysForPrompt,
} = require("./memory-schema");

const PROFILE_LIMIT = 7;
const PREFERENCE_LIMIT = 3;
const NOTE_MAX_LENGTH = 300;

function clampConfidence(value) {
  const number = Number(value);
  // Model nie ocenia tu prawdopodobieństwa medycznego, tylko to, czy fakt
  // był jawnie powiedziany. Nie zapisujemy bezużytecznych zerowych pewności.
  return Number.isFinite(number) ? Math.max(0.7, Math.min(1, number)) : 0.8;
}

function plainText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

// Klucze są enumem w ASCII (patrz memory-schema.js), więc normalizujemy tylko
// obudowę (białe znaki, wielkość liter, spacje/myślniki zamiast podkreśleń) i
// PORÓWNUJEMY z enumem. Poprzednia wersja robiła replace(/[^a-z0-9_]+/g, "_")
// na surowym kluczu od modelu — to po cichu okaleczało wszystko spoza ASCII
// ("ból_barku" -> "b_l_barku") i przepuszczało dowolny wymyślony klucz.
// Walidacja zamiast okaleczania: klucz albo jest w enumie, albo wpis leci.
function normalizeKey(value) {
  return plainText(value, 80).toLowerCase().replace(/[\s-]+/g, "_");
}

// Upsert po on_conflict wywala się Postgresem, gdy ten sam klucz konfliktu
// występuje dwa razy w JEDNYM payloadzie ("cannot affect row a second time").
// Model potrafi zgłosić tę samą partię ciała dwa razy w jednej sesji, więc
// wygrywa ostatnie wystąpienie (najświeższe w wypowiedzi).
function dedupeBy(items, keyOf) {
  return [...new Map(items.map((item) => [keyOf(item), item])).values()];
}

function parseFactItem(item, sourceSessionId, rejected) {
  const category = item.category;
  if (!isFactCategory(category)) {
    rejected.push(`nieznana kategoria "${category}"`);
    return null;
  }
  const key = normalizeKey(item.key);
  if (!isAllowedKey(category, key)) {
    rejected.push(`klucz "${key || item.key}" spoza słownika dla kategorii "${category}"`);
    return null;
  }
  const value = plainText(item.value);
  if (!value) {
    rejected.push(`pusta wartość dla "${category}.${key}"`);
    return null;
  }
  return { category, key, value, source_session_id: sourceSessionId, confidence: clampConfidence(item.confidence) };
}

// Kontuzje mają własny kształt (body_part/status/severity/note), nie
// klucz-wartość — po to, żeby dało się po nich filtrować asany. `note` to
// jedyne pole tekstowe i jedyne, które trafia do promptu dosłownie.
function parseInjuryItem(item, sourceSessionId, rejected) {
  const bodyPart = normalizeKey(item.body_part);
  if (!isBodyPart(bodyPart)) {
    rejected.push(`partia ciała "${bodyPart || item.body_part}" spoza słownika`);
    return null;
  }
  const status = isInjuryStatus(item.status) ? item.status : "active";
  const severity = isInjurySeverity(item.severity) ? item.severity : "medium";
  return {
    body_part: bodyPart,
    status,
    severity,
    note: plainText(item.note, NOTE_MAX_LENGTH),
    source_session_id: sourceSessionId,
    confidence: clampConfidence(item.confidence),
  };
}

function parseExtraction(raw, sourceSessionId, transcript = "") {
  const text = String(raw || "").replace(/^```json\s*|^```|```$/gm, "").trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return { facts: [], injuries: [], rejected: ["odpowiedź modelu nie jest poprawnym JSON-em"] }; }

  const rejected = [];
  const facts = dedupeBy(
    (Array.isArray(parsed?.items) ? parsed.items : [])
      .filter(Boolean)
      .map((item) => parseFactItem(item, sourceSessionId, rejected))
      .filter(Boolean),
    (item) => `${item.category}:${item.key}`
  );
  const injuries = dedupeBy(
    (Array.isArray(parsed?.injuries) ? parsed.injuries : [])
      .filter(Boolean)
      .map((item) => parseInjuryItem(item, sourceSessionId, rejected))
      .filter(Boolean),
    (item) => item.body_part
  );

  // Transkrypt jest sklejany z pojedynczych wypowiedzi znakiem nowej linii
  // (patrz extractAndPersistMemory w server.js), a Web Speech API nie stawia
  // kropek — bez "\n" w tym podziale całe kilkuzdaniowe wejście stawało się
  // JEDNYM "zdaniem" i lądowało w bazie w całości (mamy tam taki rekord).
  const sentences = String(transcript).split(/[.!?\n]+\s*/).map((sentence) => plainText(sentence, NOTE_MAX_LENGTH)).filter(Boolean);

  // ŚWIADOMIE BEZ regexowej siatki na ból. Poprzednia wersja dorzucała
  // kontuzję, gdy w transkrypcie padło "boli" — i to ona wyprodukowała rekord
  // z wulgarnym monologiem. Regex nie odróżnia zaprzeczenia ("nic mnie nie
  // boli") ani przenośni ("boli mnie twoja głupota") od zgłoszenia, a odpalał
  // się DOKŁADNIE wtedy, gdy model poprawnie nie zwrócił żadnej kontuzji —
  // czyli nadpisywał trafną decyzję modelu błędną. Nie potrafił też zmapować
  // partii ciała (zawsze "other"), więc nawet przy prawdziwym bólu dawał
  // rekord gorszy od modelowego. Wykrywanie bólu należy w całości do modelu:
  // ma osobną tablicę "injuries", enum partii ciała i jawne reguły w prompcie.

  // Jeśli model zapisał jawny powód przerwania, przerwanie jest faktem
  // logicznie pewnym nawet gdy nie wygenerował osobnej flagi.
  const hasInterrupted = facts.some((item) => item.category === "session" && item.key === "interrupted");
  const hasReason = facts.some((item) => item.category === "session" && item.key === "interruption_reason");
  const stopping = sentences.find((sentence) => /\b(muszę kończyć|musimy przerwać|muszę przerwać|kończę|mam telefon)/i.test(sentence));
  if ((hasReason || stopping) && !hasInterrupted) {
    facts.push({ category: "session", key: "interrupted", value: "tak", source_session_id: sourceSessionId, confidence: 0.99 });
  }

  return { facts, injuries, rejected };
}

function extractionPrompt(userTranscript) {
  return `Wyciągnij trwałe, jawnie powiedziane fakty WYŁĄCZNIE z wypowiedzi użytkownika poniżej.
Odpowiedz samym poprawnym JSON-em, bez komentarza:
{"items":[{"category":"profile|preference|session","key":"<klucz ze słownika>","value":"krótkie zdanie po polsku","confidence":0.0}],
 "injuries":[{"body_part":"<partia ze słownika>","status":"active|resolved","severity":"low|medium|high","note":"krótki opis po polsku","confidence":0.0}]}

JĘZYK: pola "value" i "note" zapisuj ZAWSZE po polsku, nawet jeśli użytkownik wtrąci obce słowo.
Pola "category", "key", "body_part", "status", "severity" to identyfikatory techniczne — zawsze dokładnie takie, jak w słownikach niżej.

DOZWOLONE KLUCZE (nic spoza tej listy nie zostanie zapisane):
  ${factKeysForPrompt()}

DOZWOLONE PARTIE CIAŁA:
  ${bodyPartsForPrompt()}

ZASADY:
- Nigdy nie wnioskuj, nie diagnozuj i nie upiększaj. Tylko to, co jawnie powiedziano.
- Wyciągaj wyłącznie fakty O UŻYTKOWNIKU, nigdy o trenerze. Trener ma na imię Andrzej i sam się przedstawia — jeśli w tekście pada przedstawienie się trenera (np. "jestem Andrzej, twój trener"), to NIE jest imię użytkownika. W razie wątpliwości pomiń "name".
- profile: trwałe fakty (imię, wiek, poziom sprawności, poziom gibkości).
- preference: powtarzalne preferencje (długość sesji, intensywność, lubiane/nielubiane pozycje).
- session: fakty o TEJ jednej sesji (dostępny czas, przerwanie i jego powód, ostatnia wykonana pozycja, następna pozycja).
- injuries: każde zgłoszenie bólu, kontuzji lub ograniczenia. Zmapuj na partię ze słownika; gdy nie da się jednoznacznie zmapować, użyj "other" i wpisz szczegół w "note".
- Ból zgłoszony teraz to status "active". Wyraźna informacja, że coś już nie boli albo przeszło ("bark już jest w porządku"), to status "resolved" dla tej partii.
- severity: "low" przy lekkim dyskomforcie, "medium" domyślnie, "high" przy silnym bólu.
- Jeśli nie ma żadnego jawnego faktu, zwróć puste tablice.
- "note" i "value" mają być neutralne i przypisane użytkownikowi, np. "Użytkownik zgłosił ból prawego barku po wczorajszym treningu" — nigdy diagnoza.

TRANSKRYPT UŻYTKOWNIKA:
${plainText(userTranscript, 12000)}`;
}

// Wszystkie etykiety poniżej trafiają dosłownie do polskiego promptu trenera —
// dlatego są po polsku. Wcześniej były angielskie ("Profile:", "Returning
// user…"), co wstawiało angielskie zdania w środek polskiego systemowego
// promptu.
function buildMemoryContext({ profile = [], preferences = [], unfinishedSession = [], injuries = [] }) {
  const selectedProfile = profile.slice(0, PROFILE_LIMIT);
  const selectedPreferences = preferences.slice(0, PREFERENCE_LIMIT);
  const lines = [];
  if (selectedProfile.length) lines.push("Profil: " + selectedProfile.map((item) => `${factKeyLabel(item.key)}: ${item.value}`).join("; "));
  if (selectedPreferences.length) lines.push("Preferencje: " + selectedPreferences.map((item) => `${factKeyLabel(item.key)}: ${item.value}`).join("; "));
  if (injuries.length) {
    lines.push("Zgłoszone dolegliwości (aktywne): " + injuries
      .map((item) => `${bodyPartLabel(item.body_part)} — ${severityLabel(item.severity)}${item.note ? `, ${item.note}` : ""}`)
      .join("; "));
  }
  if (unfinishedSession.length) lines.push("Poprzednia niedokończona sesja: " + unfinishedSession.map((item) => `${factKeyLabel(item.key)}: ${item.value}`).join("; "));
  return lines;
}

function buildCoachPrompt(basePrompt, memory) {
  const lines = buildMemoryContext(memory);
  if (!lines.length) return `${basePrompt}\n\nTo nowy użytkownik. Nie udawaj, że pamiętasz wcześniejsze sesje.`;
  const name = memory.profile.find((item) => item.key === "name")?.value;
  return `${basePrompt}\n\n${name ? `Powracający użytkownik: ${name}.` : "Powracający użytkownik."}
Zapamiętane informacje (używaj wyłącznie w takiej postaci, w jakiej są podane; niczego nie wymyślaj i nie diagnozuj):
- ${lines.join("\n- ")}

Traktuj te fakty jako aktualny kontekst rozmowy. Nie pytaj ponownie o rzeczy, które są już wypisane. Jeśli użytkownik prosi o kontynuację, a wypisana jest niedokończona sesja, kontynuuj od następnej albo ostatniej wykonanej pozycji — nie pytaj, gdzie sesja się urwała. O zapamiętanej tożsamości albo dolegliwościach wspominaj tylko wtedy, gdy użytkownik o to pyta albo gdy ma to znaczenie dla bezpieczeństwa. Nigdy nie każ ćwiczyć przez ból zgłoszonej partii ciała.`;
}

module.exports = { buildCoachPrompt, buildMemoryContext, extractionPrompt, parseExtraction };
