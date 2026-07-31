// server.js — serwer do testu awatarów (Anam + HeyGen LiveAvatar)
// Użycie:
//   node server.js
//   -> otwórz http://localhost:3000
//
// Zero zależności npm — czysty Node (18+).

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildCoachPrompt, extractionPrompt, parseExtraction } = require("./memory");
const { PROFILE_KEYS, PREFERENCE_KEYS, SESSION_KEYS } = require("./memory-schema");
const { buildPostureCue, buildPostureAffirmation, listExerciseCues, buildPostureMismatchCue } = require("./posture");
const { appendCalibrationRecording, loadAllCalibrations } = require("./calibration");

// Minimalna obsługa .env bez dokładania zależności do tego małego testowego
// serwera. Zmienne już ustawione w środowisku mają pierwszeństwo.
function loadEnvFile(filename = path.join(__dirname, ".env")) {
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}
loadEnvFile();

const GROQ_TRAINER_PROMPT = "Jesteś przyjaznym trenerem jogi. Rozmawiasz po polsku. Odpowiadaj krótko i naturalnie. Nie widzisz fizycznie użytkownika, więc nigdy nie zgaduj ani nie wymyślaj konkretnych, technicznych błędów postawy (np. \"masz źle ustawione kolano\") — to mogłoby wprowadzić w błąd. Jeśli user zapyta, czy dobrze robi pozycję, odpowiedz ciepło i zachęcająco, bez wymyślonych szczegółów (np. \"Skup się na oddechu, idzie Ci dobrze... daj znać, jeśli coś Cię boli\"). Nigdy nie wspominaj o żadnym oddzielnym systemie, mechanizmie czy narzędziu do korekty postawy — po prostu bądź wspierającym trenerem, jednym spójnym głosem.";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";

// Sandbox LiveAvatar (LIVEAVATAR_SANDBOX=true) wspiera WYŁĄCZNIE tego jednego
// awatara — inne avatar_id dają 400 "This avatar is not supported in sandbox
// mode". Zweryfikowane bezpośrednio: docs.liveavatar.com/docs/sandbox-mode
// ("Limited avatars — only the Wayne avatar is available") + GET
// /v1/avatars/dd73ea75-1218-4ef3-92ce-606d5f7fbc0a na koncie z .env.
const SANDBOX_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a"; // Wayne
const SANDBOX_VOICE_ID = "c2527536-6d1f-4412-a643-53a3497dada9"; // default_voice Wayne'a

// server.js jest uruchamiany jako jeden proces Node dla wszystkich
// adapterów. Adapter "LiveAvatar Lite + ElevenLabs" (patrz niżej) łączy się
// przez natywny klient WebSocket (do ws_url LiveAvatar i do streamingu
// ElevenLabs) — Node 18 (dotychczasowe minimum tego projektu) go nie ma;
// doszedł jako stabilny, globalny dopiero w Node 22. Pozostałe adaptery nie
// używają WebSocket po stronie serwera i działają identycznie na 18 i 22.
if (typeof WebSocket === "undefined") {
  console.warn(
    "UWAGA: ten proces Node nie ma natywnego WebSocket (wymagany Node 22+). " +
    "Adapter 'LiveAvatar Lite + ElevenLabs' nie zadziała, reszta aplikacji — tak."
  );
}

function requireEnv(name) {
  if (!process.env[name]) throw new Error(`Brak ${name}. Uzupełnij tę zmienną w lokalnym pliku .env.`);
  return process.env[name];
}

async function liveAvatarApi(apiKey, endpoint, options = {}) {
  const response = await fetch(`https://api.liveavatar.com/v1${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`LiveAvatar ${endpoint}:`, response.status, JSON.stringify(data));
    throw new Error(data.message || `LiveAvatar zwrócił status ${response.status} dla ${endpoint}`);
  }
  return data;
}

function responseItems(data) {
  const value = data?.data;
  // Endpointy LiveAvatar używają różnych formatów list: część zwraca tablicę,
  // a Contexts zwraca paginowane { count, results, next, previous }.
  return Array.isArray(value) ? value : (value?.results || value?.items || value?.data || []);
}

// ---- SESSION RECORDER (LiveAvatar FULL) ----
// Browser odbiera eventy LiveKit i wysyła do tego procesu wyłącznie
// transkrypcje / stan sesji. Po session.stopped (lub po Stop w UI) komplet
// jest zapisywany jednym upsertem do Supabase. Dzięki temu klucz Supabase
// pozostaje wyłącznie po stronie serwera.
const recordedSessions = new Map();
const completedSessionIds = new Set();
const LIVEAVATAR_PROVIDERS = new Set(["liveavatar", "liveavatarGroq", "liveavatarLiteEleven"]);
// Sesje Lite: sessionId -> { agentWs, sessionToken, systemPrompt, history,
// sseClients, turnInFlight, onSpeakEnded, turnStartedAt, keepAliveTimer }.
// Osobny rejestr od recordedSessions (który trzyma transkrypty do
// Supabase) — ten tu trzyma żywe uchwyty do WebSocketów i SSE, per sesja.
const liteSessions = new Map();
const RECORDABLE_LIVEAVATAR_EVENTS = new Set([
  "session.started",
  "user.transcription",
  "avatar.transcription",
  "session.stopped",
  "session.client_stopped",
]);

function recorderKey(provider, sessionId) {
  return `${provider}:${sessionId}`;
}

function supabaseServiceKey() {
  // Nazwa SUPABASE_SECRET_KEY jest aktualną nazwą klucza serwerowego w
  // Supabase. Druga nazwa ułatwia użycie starszego service_role key.
  return process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function memoryUserId() {
  // W Sprint 1 aplikacja nie ma jeszcze logowania. Stały ID pozwala
  // przetestować pamięć bez dodawania warstwy profili/użytkowników.
  return process.env.MEMORY_USER_ID || "local-demo-user";
}

async function supabaseRequest(resource, options = {}) {
  const key = supabaseServiceKey();
  if (!process.env.SUPABASE_URL || !key) throw new Error("Supabase is not configured");
  const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${resource}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`Supabase ${resource}: ${response.status} ${await response.text()}`);
  return response;
}

// Aktywne kontuzje jako STRUKTURA, nie zdanie: [{body_part, severity, note}],
// gdzie body_part i severity to enumy z memory-schema.js. To jest kontrakt dla
// przyszłego twardego filtra asan — filtr dopasowuje po identyfikatorze partii
// ciała, nie po tekście (dawne "problem with right shoulder" nie dało się
// dopasować do żadnego tagu asany).
async function getActiveInjuries(userId) {
  if (!process.env.SUPABASE_URL || !supabaseServiceKey()) return [];
  try {
    const response = await supabaseRequest(
      `user_injuries?user_id=eq.${encodeURIComponent(userId)}&status=eq.active&select=body_part,severity,note&order=reported_at.desc`
    );
    return await response.json();
  } catch (error) {
    // Tabela może jeszcze nie istnieć. Brak kontuzji nie może zablokować sesji.
    console.warn("Memory Cleanup: nie udało się odczytać kontuzji:", error.message);
    return [];
  }
}

// is_unfinished nigdy nie wracało na false, więc raz przerwana sesja doklejała
// się do KAŻDEGO kolejnego promptu w nieskończoność (w bazie wiszą takie
// rekordy z 20-21 lipca). Kasujemy flagę zaraz po odczycie: kontekst został
// właśnie wstrzyknięty do promptu startującej sesji, czyli jest obsłużony.
// Rekordy zostają w bazie — gaśnie tylko flaga "do wznowienia".
async function markUnfinishedSessionsHandled(userId) {
  try {
    await supabaseRequest(`session_memory?user_id=eq.${encodeURIComponent(userId)}&is_unfinished=eq.true`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ is_unfinished: false }),
    });
  } catch (error) {
    console.warn("Memory Cleanup: nie udało się wyczyścić flagi niedokończonej sesji:", error.message);
  }
}

async function loadMemoryContext(userId) {
  const empty = { profile: [], preferences: [], unfinishedSession: [], injuries: [] };
  if (!process.env.SUPABASE_URL || !supabaseServiceKey()) return empty;
  try {
    // Filtr po słowniku jest też po stronie ODCZYTU, nie tylko zapisu: w bazie
    // siedzą jeszcze stare rekordy z kluczami spoza enuma (np.
    // physical_limitation: "problem with right shoulder"). Bez tego filtra
    // wciekłyby do polskiego promptu mimo domkniętego zapisu — a kontuzje mają
    // teraz swoją tabelę, nie klucz w user_memory.
    const [profileResponse, preferenceResponse, sessionResponse, injuries] = await Promise.all([
      supabaseRequest(`user_memory?user_id=eq.${encodeURIComponent(userId)}&category=eq.profile&key=in.(${PROFILE_KEYS.join(",")})&select=key,value,confidence&order=updated_at.desc&limit=7`),
      supabaseRequest(`user_memory?user_id=eq.${encodeURIComponent(userId)}&category=eq.preference&key=in.(${PREFERENCE_KEYS.join(",")})&select=key,value,confidence&order=updated_at.desc&limit=3`),
      supabaseRequest(`session_memory?user_id=eq.${encodeURIComponent(userId)}&is_unfinished=eq.true&key=in.(${SESSION_KEYS.join(",")})&select=source_session_id,key,value,confidence&order=created_at.desc&limit=20`),
      getActiveInjuries(userId),
    ]);
    const unfinishedCandidates = await sessionResponse.json();
    const latestUnfinishedId = unfinishedCandidates[0]?.source_session_id;
    // Tylko najnowsza niedokończona sesja; jej kilka rekordów opisuje stan.
    const unfinishedSession = latestUnfinishedId
      ? unfinishedCandidates.filter((item) => item.source_session_id === latestUnfinishedId)
      : [];
    if (unfinishedCandidates.length) await markUnfinishedSessionsHandled(userId);
    return {
      profile: await profileResponse.json(),
      preferences: await preferenceResponse.json(),
      unfinishedSession,
      injuries,
    };
  } catch (error) {
    // Migracja może nie być jeszcze uruchomiona. Nie blokujemy LiveAvatar.
    console.warn("Memory Cleanup: nie udało się odczytać pamięci:", error.message);
    return empty;
  }
}

async function extractAndPersistMemory(record) {
  if (!record?.user_transcript?.length || !process.env.GROQ_API_KEY) return;
  try {
    const transcript = record.user_transcript.map((entry) => entry.text).join("\n");
    const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0,
        messages: [{ role: "system", content: "Wyciągasz wyłącznie jawnie powiedziane fakty o użytkowniku. Odpowiadasz samym JSON-em." }, { role: "user", content: extractionPrompt(transcript) }],
      }),
    });
    if (!groqResponse.ok) throw new Error(`Groq ${groqResponse.status}: ${await groqResponse.text()}`);
    const completion = await groqResponse.json();
    const { facts, injuries, rejected } = parseExtraction(completion?.choices?.[0]?.message?.content, record.session_id, transcript);
    // Klucz spoza słownika nie trafia do bazy — ale musi zostawić ślad, bo to
    // sygnał, że prompt ekstrakcji rozjechał się ze słownikiem (memory-schema.js).
    if (rejected.length) console.warn(`Memory Cleanup: odrzucono ${rejected.length} wpis(ów) spoza słownika: ${rejected.join("; ")}`);
    const userId = record.user_id || memoryUserId();
    const now = new Date().toISOString();
    const profileItems = facts.filter((item) => item.category === "profile" || item.category === "preference")
      .map((item) => ({ ...item, user_id: userId, updated_at: now }));
    const sessionItems = facts.filter((item) => item.category === "session");
    if (profileItems.length) await supabaseRequest("user_memory?on_conflict=user_id,category,key", {
      method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(profileItems),
    });
    if (sessionItems.length) {
      const isUnfinished = sessionItems.some((item) =>
        (item.key === "interrupted" && /^(true|yes|tak)$/i.test(item.value)) || item.key === "interruption_reason"
      );
      await supabaseRequest("session_memory?on_conflict=source_session_id,key", {
        method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(sessionItems.map((item) => ({ ...item, user_id: userId, is_unfinished: isUnfinished }))),
      });
    }
    // Upsert po UNIQUE(user_id, body_part): kolejne zgłoszenie TEJ SAMEJ partii
    // aktualizuje jeden rekord zamiast dokładać kolejny. Wcześniej każda sesja
    // dokładała osobny reported_discomfort i do promptu leciały naraz cztery
    // sprzeczne zdania o tym samym barku.
    if (injuries.length) {
      await supabaseRequest("user_injuries?on_conflict=user_id,body_part", {
        method: "POST", headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(injuries.map((item) => ({
          user_id: userId,
          body_part: item.body_part,
          status: item.status,
          severity: item.severity,
          note: item.note,
          source_session_id: item.source_session_id,
          reported_at: now,
          resolved_at: item.status === "resolved" ? now : null,
        }))),
      });
    }
    console.log(`Memory Cleanup: zapisano ${profileItems.length} faktów, ${sessionItems.length} faktów sesji i ${injuries.length} zgłoszeń kontuzji.`);
  } catch (error) {
    // Sesja została już bezpiecznie zapisana; błąd ekstrakcji nie może jej cofnąć.
    console.error("Memory Cleanup: ekstrakcja nieudana:", error.message);
  }
}

function getRecordedSession(provider, sessionId) {
  const key = recorderKey(provider, sessionId);
  if (completedSessionIds.has(key)) return null;
  const existing = recordedSessions.get(key);
  if (existing) return existing;
  const record = {
    session_id: sessionId,
    provider,
    user_id: memoryUserId(),
    started_at: new Date().toISOString(),
    ended_at: null,
    end_reason: null,
    user_transcript: [],
    avatar_transcript: [],
    events: [],
  };
  recordedSessions.set(key, record);
  return record;
}

function recordLiveAvatarEvent({ provider, sessionId, eventType, event }) {
  if (!LIVEAVATAR_PROVIDERS.has(provider) || !sessionId || !RECORDABLE_LIVEAVATAR_EVENTS.has(eventType)) return null;
  const record = getRecordedSession(provider, sessionId);
  if (!record) return null;
  const at = new Date().toISOString();
  const safeEvent = event && typeof event === "object" ? event : {};
  record.events.push({ event_type: eventType, at, payload: safeEvent });
  if (eventType === "user.transcription" && safeEvent.text) {
    record.user_transcript.push({ text: safeEvent.text, at });
  }
  if (eventType === "avatar.transcription" && safeEvent.text) {
    record.avatar_transcript.push({ text: safeEvent.text, at });
  }
  return record;
}

function recorderSnapshot(record) {
  // Tylko dane sesji już odebrane od LiveKit. Nie zawiera tokenów LiveKit,
  // klucza LiveAvatar ani klucza Supabase.
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

async function persistRecordedSession(record, endReason = null) {
  if (!record) return { saved: false, storageStatus: "already_finalized", reason: "no_record" };
  record.ended_at ||= new Date().toISOString();
  record.end_reason ||= endReason || "USER_CLOSED";

  // Recorder jest opcjonalny do czasu skonfigurowania Supabase; brak jego
  // konfiguracji nie może blokować zakończenia aktywnej sesji avatara.
  const serviceKey = supabaseServiceKey();
  if (!process.env.SUPABASE_URL || !serviceKey) {
    console.warn(`Session Recorder: Supabase nie jest skonfigurowany; sesja ${record.session_id} pozostaje tylko w pamięci.`);
    return { saved: false, storageStatus: "not_configured", reason: "supabase_not_configured" };
  }
  const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/avatar_sessions?on_conflict=session_id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(record),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error("Session Recorder: błąd Supabase:", response.status, detail);
    throw new Error(`Supabase zwrócił ${response.status}: ${detail}`);
  }
  const key = recorderKey(record.provider, record.session_id);
  recordedSessions.delete(key);
  completedSessionIds.add(key);
  console.log(`Session Recorder: zapisano kompletną sesję ${record.session_id}.`);
  await extractAndPersistMemory(record);
  return { saved: true, storageStatus: "persisted", databaseStatus: response.status };
}

// System prompt trenerki jogi — dla Anam trafia bezpośrednio jako
// personaConfig.systemPrompt, dla LiveAvatar trzeba go ręcznie wkleić jako
// treść Contextu w ich API/dashboardzie (patrz TODO przy providerze liveavatar).
const TRAINER_SYSTEM_PROMPT = `[STYLE] Odpowiadaj wyłącznie po polsku, naturalną mową bez formatowania,
krótkimi zdaniami. Dodawaj pauzy używając '...'. Mów spokojnie i ciepło.
[PERSONALITY] Jesteś Andrzej, doświadczonym trenerem jogi. Prowadzisz użytkownika przez
krótką sesję. Na początku zapytaj, ile ma dziś czasu i jak ocenia swoją kondycję.
Potem poprowadź go przez pozycję dziecka i psa z głową w dół (dokładnie tymi
nazwami): powiedz jak wejść w pozycję, przypominaj o oddechu, po kilku
oddechach powiedz jak wyjść. Reaguj na to, co mówi użytkownik -
jeśli mówi, że coś boli albo że musi kończyć, dostosuj się natychmiast.
[POSTAWA] Nie widzisz fizycznie użytkownika, więc nigdy nie zgaduj ani nie
wymyślaj konkretnych, technicznych błędów postawy (np. "masz źle ustawione
kolano") — to mogłoby wprowadzić w błąd. Jeśli user zapyta, czy dobrze robi
pozycję, odpowiedz ciepło i zachęcająco, bez wymyślonych szczegółów (np.
"Skup się na oddechu, idzie Ci dobrze... daj znać, jeśli coś Cię boli").
Nigdy nie wspominaj o żadnym oddzielnym systemie, mechanizmie czy narzędziu
do korekty postawy — po prostu bądź wspierającym trenerem, jednym spójnym
głosem.`;

// Styl-guide korekt postawy — startowy, do dopracowania przez prawdziwego
// trenera jogi. Karmi generateGroqCorrection() niżej: trener pisze te zasady
// RAZ (ton + bezpieczeństwo), zamiast osobnego zdania na każdą kombinację
// ćwiczenie×błąd w posture.js.
const POSTURE_COACH_STYLE_GUIDE = `Jesteś Andrzej, trenerem jogi, korygujesz na żywo postawę
użytkownika w trakcie ćwiczenia. Mów krótko, spokojnie i ciepło, jak w rozmowie — jedno zdanie,
bez wstępu typu "widzę że". Nigdy nie diagnozuj i nie nazywaj kontuzji. Nigdy nie każ przeć przez
ból. Jeśli nie masz pewności jak mocno skorygować, zasugeruj złagodzenie pozycji zamiast pogłębienia.`;

// Generuje tekst korekty postawy na podstawie etykiety błędu + styl-guide'u
// wyżej — ten sam wzorzec fetch co extractAndPersistMemory() powyżej (Groq,
// OpenAI-compatible /chat/completions). Rzuca wyjątek przy błędzie/braku
// klucza — wywołujący (patrz /api/posture-correction) łapie to i używa
// fallbacku z posture.js, tak jak loadMemoryContext() robi to dla pamięci.
async function generateGroqCorrection(exerciseLabel, deviationLabel) {
  if (!process.env.GROQ_API_KEY) throw new Error("Brak GROQ_API_KEY.");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.4,
      messages: [
        { role: "system", content: POSTURE_COACH_STYLE_GUIDE },
        {
          role: "user",
          content: `Ćwiczenie: ${exerciseLabel}\nWykryty błąd postawy: ${deviationLabel}\n\nPodaj JEDNO krótkie zdanie po polsku do powiedzenia na głos teraz. Tylko sama wypowiedź, bez cudzysłowów i bez wyjaśnień.`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Groq ${response.status}: ${await response.text()}`);
  const completion = await response.json();
  const text = completion?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq nie zwrócił tekstu korekty.");
  return text;
}

// Symetryczne do generateGroqCorrection — pochwała zamiast korekty, gdy
// wszystkie reguły ćwiczenia są spełnione (patrz affirmationDebouncer w
// index.html). Ten sam styl-guide, ten sam fallback-first kontrakt.
async function generateGroqAffirmation(exerciseLabel) {
  if (!process.env.GROQ_API_KEY) throw new Error("Brak GROQ_API_KEY.");
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.4,
      messages: [
        { role: "system", content: POSTURE_COACH_STYLE_GUIDE },
        {
          role: "user",
          content: `Ćwiczenie: ${exerciseLabel}\nUżytkownik trzyma tę pozycję poprawnie.\n\nPodaj JEDNO krótkie, ciepłe zdanie pochwały po polsku do powiedzenia na głos teraz. Tylko sama wypowiedź, bez cudzysłowów i bez wyjaśnień.`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Groq ${response.status}: ${await response.text()}`);
  const completion = await response.json();
  const text = completion?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq nie zwrócił tekstu pochwały.");
  return text;
}

// Komunikat "rozjazd pozycji" — k-NN (patrz public/knn.js) wykrył, że user
// stabilnie robi INNĄ nazwaną pozycję niż tę zadaną przez trenera (patrz
// public/posture-state-machine.js, stan MISMATCH). Dwa warianty promptu:
// zwykły (każe wrócić, podpowiada jak) i "odpoczynkowy" (gdy wykryta pozycja
// ma w posture.js flagę odpoczynkowa:true, np. child_pose) — wtedy NIE
// komenderujemy powrotem, tylko pytamy czy wszystko w porządku.
async function generateGroqMismatchCue({ targetLabel, detectedLabel, entryScript, restful }) {
  if (!process.env.GROQ_API_KEY) throw new Error("Brak GROQ_API_KEY.");
  const instruction = restful
    ? `Użytkownik zamiast zadanej pozycji "${targetLabel}" jest teraz w pozycji odpoczynkowej "${detectedLabel}". NIE każ mu wracać na siłę — zapytaj krótko i ciepło, czy wszystko w porządku, i że może wrócić do "${targetLabel}", gdy będzie gotowy.`
    : `Użytkownik zamiast zadanej pozycji "${targetLabel}" wykonuje teraz "${detectedLabel}". Powiedz, jaką pozycję widzisz, jaką zadałeś, i jak krótko przejść do właściwej (podpowiedź: "${entryScript}"). Wzorzec: "Widzę, że jesteś w X, a prosiłem o Y... żeby przejść: ...".`;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.4,
      messages: [
        { role: "system", content: POSTURE_COACH_STYLE_GUIDE },
        { role: "user", content: `${instruction}\n\nPodaj JEDNO-DWA krótkie zdania po polsku. Tylko sama wypowiedź, bez cudzysłowów i bez wyjaśnień.` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Groq ${response.status}: ${await response.text()}`);
  const completion = await response.json();
  const text = completion?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq nie zwrócił tekstu komunikatu rozjazdu.");
  return text;
}

// ---- DOSTAWCY AWATARÓW ----
// Każdy dostawca ma swoją funkcję getSessionToken() zwracającą co najmniej
// { sessionToken } (może dorzucić dodatkowe pola — trafiają one 1:1 do
// odpowiedzi JSON). Front-end (public/index.html) wybiera dostawcę w
// dropdownie i wysyła jego klucz w body POST /api/session-token. Dodanie
// kolejnego dostawcy = nowy wpis tutaj + odpowiadający mu adapter w
// ADAPTERS w index.html.
//
// Szkielet live-korekty postawy (patrz posture.js i /api/posture-correction
// niżej) działa TYLKO dla providerów z LIVEAVATAR_PROVIDERS — obaj (liveavatar,
// liveavatarGroq) to sesje FULL mode i współdzielą ten sam pokój LiveKit
// (liveavatarRoom w index.html). Zweryfikowane bezpośrednio w
// docs.liveavatar.com/docs/full-mode/events.md (stary URL z komentarza niżej,
// "docs.liveavatar.com/docs/command-events", już nie istnieje — strona się
// przeniosła):
// - Komendy klient→awatar idą przez LiveKit data channel na topicu "agent-control".
// - {"event_type":"avatar.speak_text","text":"..."} — awatar mówi DOKŁADNIE ten
//   tekst, bez rundy przez LLM (to chcemy do natychmiastowej korekty; NIE
//   "avatar.speak_response", który dokłada opóźnienie LLM-a).
// - {"event_type":"avatar.interrupt"} (bez payloadu) — przerywa bieżącą wypowiedź.
// Jeśli to, co jest na drugim komputerze, to faktycznie LiveAvatar LITE mode
// (BYO ASR/TTS/wideo), a nie FULL + Custom TTS — LITE wg
// docs.liveavatar.com/docs/lite-mode/events.md chodzi po OSOBNYM WebSocket,
// nie po tym samym kanale LiveKit. Wtedy zmieni się tylko ostatnia mila
// wysyłki (WebSocket zamiast publishData) — posture.js i endpoint niżej
// zostają bez zmian.
const PROVIDERS = {
  anam: {
    label: "Anam",
    async getSessionToken() {
      const API_KEY = requireEnv("ANAM_API_KEY");

      // avatarId / voiceId poniżej to domyślna "Cara" z docsów Anam.
      // W panelu Anam (sekcja z awatarami/głosami) znajdź POLSKI głos
      // i podmień voiceId. Możesz też podmienić avatarId na inną twarz.
      const PERSONA_CONFIG = {
        name: "Maja",
        avatarId: "4b11686c-6d3e-4736-9cdf-c49dcfe28251", // TODO: podmień w razie potrzeby
        voiceId: "7a37dcaf-b5c6-4f7c-a78a-806a43161de5",  // TODO: podmień na polski głos!
        llmId: "0934d97d-0c3a-4f33-91b0-5e136a0ef466",    // domyślny LLM Anam (z ich quickstartu)
        systemPrompt: TRAINER_SYSTEM_PROMPT,
        // languageCode steruje ASR (co system SŁYSZY od użytkownika) — to
        // OSOBNE ustawienie od systemPrompt (który steruje tylko tym, co
        // avatar MÓWI). Bez tego ASR domyślnie zakłada "en" i źle
        // transkrybuje polską mowę. voiceId wyżej nadal jest domyślnym
        // angielskim głosem — TODO nad nim wciąż aktualne.
        languageCode: "pl",
      };

      const anamRes = await fetch("https://api.anam.ai/v1/auth/session-token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({ personaConfig: PERSONA_CONFIG }),
      });
      const data = await anamRes.json();
      if (!anamRes.ok) {
        console.error("Błąd Anam:", anamRes.status, JSON.stringify(data));
        throw new Error(data.message || `Anam zwrócił status ${anamRes.status}`);
      }
      return { sessionToken: data.sessionToken };
    },
  },

  // ---- HEYGEN LIVEAVATAR (Full mode) ----
  // Historia dochodzenia (ważne, żeby nikt nie cofnął się do złej ścieżki):
  // 1. Stare "Streaming Avatar API" HeyGena (/v1/streaming.*, /v2/streaming.*)
  //    jest sunsetowane (HTTP 410 "endpoint_sunset", sprawdzone bezpośrednim
  //    zapytaniem) — HeyGen każe migrować na LiveAvatar.
  // 2. "Avatar Realtime" (/v3/avatar-realtime), którego używaliśmy wcześniej,
  //    to NIE jest to samo co LiveAvatar — to API generowania gotowych klipów
  //    wideo (start -> polling co 1s -> hls_url -> odtwarzanie VOD przez HLS).
  //    Fizycznie nie da się na nim zejść poniżej sekund opóźnienia (zmierzone:
  //    13.6s samo wygenerowanie klipu + zawieszenia bufora HLS) — "Lite" czy
  //    "Full" nie miało tu znaczenia, bo problemem jest architektura, nie
  //    dostawca LLM.
  // 3. LiveAvatar (api.liveavatar.com, docs.liveavatar.com) to OSOBNY produkt
  //    HeyGena — sesja oparta o LiveKit/WebRTC (dokładnie ten sam model co
  //    Anam), z deklarowanym sub-sekundowym opóźnieniem. Ma dwa tryby:
  //    - FULL: HeyGen ogarnia LLM+TTS+avatar end-to-end — to używamy tutaj.
  //    - LITE: BYO LLM/TTS (odpowiednik tego, co robiliśmy z Groq).
  // 4. Stary klucz HeyGen (sk_V2_hgu_...) NIE działa na api.liveavatar.com —
  //    to osobne konto, klucz trzeba wziąć z app.liveavatar.com/developers.
  //
  // Cały flow (token -> start) zweryfikowany bezpośrednimi zapytaniami:
  // - VOICE_ID musi pochodzić z katalogu GET /v1/voices tego konta — stary
  //   HeyGen voice_id (podany na początku) dawał "Voice not found" na
  //   /sessions/start (walidacja tam jest odłożona, nie dzieje się przy
  //   /sessions/token). Użyty niżej to default_voice avatara AVATAR_ID.
  // - AVATAR_ID to "Bryan Fitness Coach" z GET /v1/avatars/public.
  // - CONTEXT_ID to istniejący w koncie Context "Yoga trainer" (już
  //   skonfigurowany z treścią zgodną z TRAINER_SYSTEM_PROMPT wyżej) — bez
  //   context_id avatar odpowiada w trybie ograniczonym.
  // - /sessions/token wymaga DOKŁADNIE JEDNEGO z { avatar_persona, voice_agent }
  //   jako zagnieżdżonego obiektu — płaskie pola voice_id/context_id na
  //   najwyższym poziomie requestu zwracają błąd walidacji 422.
  // - /sessions/start autoryzuje się przez "Authorization: Bearer <session_token>"
  //   (nie X-API-KEY) — potwierdzone (bez tego nagłówka dostajemy 403).
  // - Konto ma limit JEDNEJ współbieżnej sesji (403 "Session concurrency limit
  //   reached" przy próbie startu drugiej) — trzeba zamknąć poprzednią sesję
  //   (POST /v1/sessions/stop, body {"session_id"}) zanim wystartuje nowa.
  // - max_session_duration w odpowiedzi /start to 120s (2 minuty) — sesja
  //   sama się zamknie po tym czasie, niezależnie od planu.
  // - UWAGA przy zmianie API_KEY na inne konto: avatar_id i voice_id są
  //   zasobami globalnymi/publicznymi (space_id: null — potwierdzone przez
  //   GET /v1/avatars/{id}), więc przenoszą się między kontami bez zmian.
  //   CONTEXT_ID nie — to zasób przypisany do konkretnego konta/space'u.
  //   Gorzej: /sessions/start NIE waliduje context_id (w przeciwieństwie do
  //   voice_id, które twardo błądzi na "Voice not found") — nieistniejący
  //   context_id po prostu cicho odpada bez błędu, sesja i tak wystartuje,
  //   tylko awatar wraca do trybu ograniczonego bez osobowości Andrzeja.
  //   Więc przy każdej zmianie API_KEY trzeba od nowa utworzyć Context (POST
  //   /v1/contexts, treść z TRAINER_SYSTEM_PROMPT) na NOWYM koncie i podać
  //   TU jego świeże id — stary context_id nie da żadnego widocznego błędu,
  //   tylko po cichu przestanie działać.
  liveavatar: {
    label: "HeyGen LiveAvatar (Full mode)",
    async getSessionToken() {
      const API_KEY = requireEnv("LIVEAVATAR_API_KEY");
      const isSandbox = process.env.LIVEAVATAR_SANDBOX === "true";
      // W sandboxie tylko Wayne działa (patrz SANDBOX_AVATAR_ID) — "Bryan
      // Fitness Coach" daje 400 "This avatar is not supported in sandbox mode".
      const AVATAR_ID = isSandbox ? SANDBOX_AVATAR_ID : "55eec60c-d665-4972-a529-bbdcaf665ab8"; // Bryan Fitness Coach (globalny) poza sandboxem
      const VOICE_ID = isSandbox ? SANDBOX_VOICE_ID : "9c8b542a-bf5c-4f4c-9011-75c79a274387";  // default_voice tego avatara (globalny) poza sandboxem
      const CONTEXT_ID = "ac9b0086-8348-4caa-bf50-414ef00d36f7"; // Context "Yoga trainer" na TYM koncie

      const tokenRes = await fetch("https://api.liveavatar.com/v1/sessions/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY },
        body: JSON.stringify({
          mode: "FULL",
          avatar_id: AVATAR_ID,
          is_sandbox: process.env.LIVEAVATAR_SANDBOX === "true",
          interactivity_type: "CONVERSATIONAL",
          avatar_persona: {
            voice_id: VOICE_ID,
            context_id: CONTEXT_ID,
            language: "pl",
          },
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData?.data?.session_token) {
        console.error("Błąd LiveAvatar (token):", tokenRes.status, JSON.stringify(tokenData));
        throw new Error(tokenData?.message || `LiveAvatar zwrócił status ${tokenRes.status} (brak session_token)`);
      }

      const startRes = await fetch("https://api.liveavatar.com/v1/sessions/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenData.data.session_token}`,
        },
      });
      const startData = await startRes.json();
      if (!startRes.ok || !startData?.data?.livekit_url) {
        console.error("Błąd LiveAvatar (start):", startRes.status, JSON.stringify(startData));
        throw new Error(startData?.message || `LiveAvatar zwrócił status ${startRes.status} (brak livekit_url)`);
      }

      return {
        sessionToken: tokenData.data.session_token,
        sessionId: startData.data.session_id,
        livekitUrl: startData.data.livekit_url,
        livekitToken: startData.data.livekit_client_token,
      };
    },
    // Wywoływane po kliknięciu Stop (patrz /api/session-end) — bez tego
    // sesja formalnie zostaje "aktywna" po stronie LiveAvatar aż do
    // max_session_duration (120s), co blokuje limit 1 współbieżnej sesji
    // na koncie (sam na to trafiłem podczas testów: 403 "Session
    // concurrency limit reached" przy próbie odpalenia kolejnej).
    async endSession(sessionId) {
      await fetch("https://api.liveavatar.com/v1/sessions/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": requireEnv("LIVEAVATAR_API_KEY") },
        body: JSON.stringify({ session_id: sessionId }),
      });
    },
  },

  // ---- LIVEAVATAR + GROQ (własny LLM) ----
  // LiveAvatar Lite wymaga własnego ASR i TTS oraz przesyłania do avatara
  // strumienia PCM. Groq jest wyłącznie LLM-em, dlatego działający test
  // rozmowy głosowej korzysta z oficjalnego mechanizmu Custom LLM w trybie
  // FULL: LiveAvatar obsługuje STT/TTS/WebRTC, a odpowiedzi generuje Groq.
  // Klucz Groq trafia do zaszyfrowanego Secretu LiveAvatar i nigdy do browsera.
  liveavatarGroq: {
    label: "LiveAvatar + Groq (własny LLM)",
    async getSessionToken() {
      const apiKey = requireEnv("LIVEAVATAR_API_KEY");
      const isSandbox = process.env.LIVEAVATAR_SANDBOX === "true";
      // Te same publiczne zasoby są już sprawdzone w istniejącym providerze
      // LiveAvatar Full. Można je opcjonalnie nadpisać w .env. W sandboxie
      // domyślnie przełącza się na Wayne'a (jedyny wspierany tam avatar) —
      // patrz SANDBOX_AVATAR_ID.
      const avatarId = process.env.LIVEAVATAR_AVATAR_ID || (isSandbox ? SANDBOX_AVATAR_ID : "55eec60c-d665-4972-a529-bbdcaf665ab8");
      const voiceId = process.env.LIVEAVATAR_VOICE_ID || (isSandbox ? SANDBOX_VOICE_ID : "9c8b542a-bf5c-4f4c-9011-75c79a274387");
      const groqApiKey = requireEnv("GROQ_API_KEY");

      // Poniższe zasoby są tworzone tylko, gdy nie istnieją w koncie. To
      // pozwala uruchamiać i restartować sesje bez ręcznego ustawiania ID.
      const contextName = "Gym startup — Groq yoga POC";
      const contexts = responseItems(await liveAvatarApi(apiKey, "/contexts"));
      let context = contexts.find((item) => item.name === contextName);
      const memory = await loadMemoryContext(memoryUserId());
      const contextualPrompt = buildCoachPrompt(GROQ_TRAINER_PROMPT, memory);
      if (!context) {
        const created = await liveAvatarApi(apiKey, "/contexts", {
          method: "POST",
          body: JSON.stringify({
            name: contextName,
            prompt: contextualPrompt,
            opening_text: "Cześć, jestem Twoim trenerem jogi. Jak mogę pomóc?",
            links: [],
          }),
        });
        context = created.data;
        console.log("LiveAvatar + Groq: utworzono Context.");
      } else {
        // FULL Custom LLM nadal używa tego samego Contextu i Groq. Zmieniamy
        // tylko jego zawartość przed kolejną sesją, aby przekazać mały,
        // ustrukturyzowany kontekst zamiast całej historii.
        const updated = await liveAvatarApi(apiKey, `/contexts/${context.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: context.name,
            prompt: contextualPrompt,
            opening_text: context.opening_text || "Cześć, jestem Twoim trenerem jogi. Jak mogę pomóc?",
            links: context.links || [],
          }),
        });
        context = updated.data || context;
      }
      if (!context?.id) throw new Error("LiveAvatar nie zwrócił context ID.");

      const secretName = "gym-startup-groq-api-key";
      const secrets = responseItems(await liveAvatarApi(apiKey, "/secrets"));
      let secret = secrets.find((item) => item.secret_name === secretName || item.name === secretName);
      if (!secret) {
        const created = await liveAvatarApi(apiKey, "/secrets", {
          method: "POST",
          body: JSON.stringify({
            // LiveAvatar waliduje enum po protokole integracji, nie po
            // konkretnym dostawcy. Groq implementuje OpenAI-compatible
            // /chat/completions, więc wymagany jest ten typ sekretu.
            secret_type: "OPENAI_API_KEY",
            secret_value: groqApiKey,
            secret_name: secretName,
          }),
        });
        secret = created.data;
        console.log("LiveAvatar + Groq: zapisano zaszyfrowany sekret Groq.");
      }
      if (!secret?.id) throw new Error("LiveAvatar nie zwrócił secret ID.");

      const configName = "gym-startup-groq-llama-3.3-70b";
      const configurations = responseItems(await liveAvatarApi(apiKey, "/llm-configurations"));
      let configuration = configurations.find((item) => item.display_name === configName);
      if (!configuration) {
        const created = await liveAvatarApi(apiKey, "/llm-configurations", {
          method: "POST",
          body: JSON.stringify({
            display_name: configName,
            model_name: "llama-3.3-70b-versatile",
            secret_id: secret.id,
            base_url: "https://api.groq.com/openai/v1",
          }),
        });
        configuration = created.data;
        console.log("LiveAvatar + Groq: utworzono konfigurację LLM.");
      }
      if (!configuration?.id) throw new Error("LiveAvatar nie zwrócił LLM configuration ID.");

      const tokenStartedAt = performance.now();
      const tokenData = await liveAvatarApi(apiKey, "/sessions/token", {
        method: "POST",
        body: JSON.stringify({
          mode: "FULL",
          avatar_id: avatarId,
          is_sandbox: process.env.LIVEAVATAR_SANDBOX === "true",
          interactivity_type: "CONVERSATIONAL",
          llm_configuration_id: configuration.id,
          avatar_persona: { voice_id: voiceId, context_id: context.id, language: "pl" },
        }),
      });
      const sessionToken = tokenData?.data?.session_token;
      if (!sessionToken) throw new Error("LiveAvatar nie zwrócił session_token.");
      console.log(`LiveAvatar + Groq: token utworzony w ${Math.round(performance.now() - tokenStartedAt)} ms.`);

      const startStartedAt = performance.now();
      const startData = await liveAvatarApi(apiKey, "/sessions/start", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const session = startData?.data;
      if (!session?.livekit_url || !session?.livekit_client_token || !session?.session_id) {
        throw new Error("LiveAvatar nie zwrócił danych połączenia LiveKit.");
      }
      console.log(`LiveAvatar + Groq: sesja ${session.session_id} wystartowała w ${Math.round(performance.now() - startStartedAt)} ms.`);
      return {
        sessionToken,
        sessionId: session.session_id,
        livekitUrl: session.livekit_url,
        livekitToken: session.livekit_client_token,
      };
    },
    async endSession(sessionId) {
      const apiKey = requireEnv("LIVEAVATAR_API_KEY");
      await liveAvatarApi(apiKey, "/sessions/stop", {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId }),
      });
      console.log(`LiveAvatar + Groq: sesja ${sessionId} zatrzymana.`);
    },
  },

  // ---- TAVUS ----
  // Trzeci dostawca, ten sam wzorzec sesji co LiveAvatar: konwersacja
  // to pokój Daily.co (sprawdzone bezpośrednim zapytaniem — conversation_url
  // zwrócony przez API to "https://tavus.daily.co/..."), więc front-end
  // łączy się przez @daily-co/daily-js "call object" (headless, bez
  // wbudowanego UI Daily) i sam podpina zdalne tracki pod <video>, tak samo
  // jak LiveKit dla LiveAvatar.
  tavus: {
    label: "Tavus",
    async getSessionToken() {
      const API_KEY = requireEnv("TAVUS_API_KEY");
      const PERSONA_ID = "pb8cf099560c";

      const res = await fetch("https://tavusapi.com/v2/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          persona_id: PERSONA_ID,
          // properties.language steruje ASR (co system SŁYSZY) — chce PEŁNĄ
          // nazwę języka, nie kod ISO ("Polish", nie "pl"; sprawdzone
          // bezpośrednim zapytaniem — "pl" dawałoby błąd walidacji). Bez
          // tego rozpoznawanie mowy potrafiło z czasem "zjechać" na
          // angielski, co ciągnęło za sobą angielskie odpowiedzi LLM-a.
          properties: { language: "Polish" },
          // system_prompt tej persony (GET /v2/personas/pb8cf099560c) jest
          // napisany po angielsku z jednym zdaniem "you speak Polish" —
          // za słaby sygnał w dłuższej rozmowie. conversational_context
          // dokleja się do system promptu dla TEJ konkretnej konwersacji,
          // bez ruszania konfiguracji persony w panelu Tavusa.
          conversational_context:
            "Odpowiadaj WYŁĄCZNIE po polsku przez całą rozmowę, niezależnie od tego w jakim języku odezwie się użytkownik. Nigdy nie przełączaj się na angielski.",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.conversation_url) {
        console.error("Błąd Tavus:", res.status, JSON.stringify(data));
        throw new Error(data.error || data.message || `Tavus zwrócił status ${res.status}`);
      }
      return { conversationId: data.conversation_id, conversationUrl: data.conversation_url };
    },
    async endSession(conversationId) {
      await fetch(`https://tavusapi.com/v2/conversations/${conversationId}/end`, {
        method: "POST",
        headers: { "x-api-key": requireEnv("TAVUS_API_KEY") },
      });
    },
  },

  // ---- LIVEAVATAR LITE + ELEVENLABS ----
  // Prawdziwy tryb Lite (dawniej "Custom Mode"): LiveAvatar TYLKO renderuje
  // twarz, cały pipeline (STT/LLM/TTS) jest po naszej stronie. To zupełnie
  // inny mechanizm niż FULL (liveavatar/liveavatarGroq wyżej): zamiast
  // LiveKit data channel jest osobny WebSocket (ws_url) do sterowania
  // awatarem komendami agent.speak/agent.speak_end. Zweryfikowane
  // bezpośrednio na koncie testowym (sandbox) przed napisaniem tego kodu:
  // - /sessions/token {mode:"LITE", avatar_id} -> /sessions/start zwraca
  //   { livekit_url, livekit_client_token, ws_url }. livekit_* idzie do
  //   przeglądarki WYŁĄCZNIE pod wideo (bez publikowania mikrofonu!),
  //   ws_url łączy się tu, na serwerze.
  // - Audio do agent.speak MUSI być PCM 16-bit, 24kHz, mono, base64 —
  //   zły format daje niemy/zniekształcony obraz awatara BEZ błędu.
  // - Zamykanie sesji Lite różni się od Full: dokumentacja HeyGena podaje
  //   "DELETE /v1/sessions", co w praktyce zwraca 405. Działający,
  //   zweryfikowany bezpośrednim wywołaniem sposób to stary
  //   POST /v1/sessions/stop, ale z Authorization: Bearer <session_token>
  //   (nie X-API-KEY jak w Full mode).
  // - ws_url wymaga natywnego klienta WebSocket (patrz ostrzeżenie o
  //   Node 22 na górze pliku) — ElevenLabs streaming też.
  liveavatarLiteEleven: {
    label: "LiveAvatar Lite + ElevenLabs",
    async getSessionToken() {
      const apiKey = requireEnv("LIVEAVATAR_API_KEY");
      requireEnv("ELEVENLABS_API_KEY");
      requireEnv("ELEVENLABS_VOICE_ID");
      requireEnv("GROQ_API_KEY");
      if (typeof WebSocket === "undefined") {
        throw new Error("Ten proces Node nie ma natywnego WebSocket — uruchom server.js pod Node 22+.");
      }
      const isSandbox = process.env.LIVEAVATAR_SANDBOX === "true";
      const avatarId = process.env.LIVEAVATAR_AVATAR_ID || (isSandbox ? SANDBOX_AVATAR_ID : "55eec60c-d665-4972-a529-bbdcaf665ab8");

      // System prompt trenerki (TRAINER_SYSTEM_PROMPT, ta sama treść co dla
      // Anam — scenariusze czasu/kondycji/kontuzji) + ograniczona pamięć z
      // Supabase, identycznie jak w istniejącym mechanizmie Memory Cleanup.
      const memory = await loadMemoryContext(memoryUserId());
      const systemPrompt = buildCoachPrompt(TRAINER_SYSTEM_PROMPT, memory);

      const tokenData = await liveAvatarApi(apiKey, "/sessions/token", {
        method: "POST",
        body: JSON.stringify({
          mode: "LITE",
          avatar_id: avatarId,
          is_sandbox: process.env.LIVEAVATAR_SANDBOX === "true",
          // Domyślnie "high" — obniżone do "medium", eksperymentalnie, w
          // nadziei na krótszy czas kodowania/dostarczenia klatki. Wartości
          // potwierdzone bezpośrednio ze schematu API LiveAvatar:
          // very_high/high/medium/low. Nadpisywalne w .env, gdyby jakość
          // spadła zauważalnie.
          video_settings: { quality: process.env.LIVEAVATAR_VIDEO_QUALITY || "medium" },
        }),
      });
      const sessionToken = tokenData?.data?.session_token;
      if (!sessionToken) throw new Error("LiveAvatar nie zwrócił session_token (Lite).");

      const startRes = await fetch("https://api.liveavatar.com/v1/sessions/start", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const startData = await startRes.json();
      const session_id = startData?.data?.session_id;
      const livekitUrl = startData?.data?.livekit_url;
      const livekitToken = startData?.data?.livekit_client_token;
      const wsUrl = startData?.data?.ws_url;
      if (!startRes.ok || !wsUrl) {
        console.error("Błąd LiveAvatar (Lite start):", startRes.status, JSON.stringify(startData));
        throw new Error(startData?.message || `LiveAvatar nie zwrócił ws_url (Lite, status ${startRes.status}).`);
      }

      const agentWs = new WebSocket(wsUrl);
      const session = {
        sessionId: session_id,
        sessionToken,
        systemPrompt,
        history: [],
        agentWs,
        ttsWs: null,
        sseClients: new Set(),
        turnInFlight: false,
        onSpeakEnded: null,
        activeTurnAbort: null,
        turnStartedAt: performance.now(),
        keepAliveTimer: null,
      };

      // Zanim oddamy sesję przeglądarce, czekamy na potwierdzenie
      // "connected" na WS — komendy wysłane wcześniej są po cichu gubione
      // (bez błędu), więc to nie jest kosmetyka. Otwieramy równolegle
      // (Promise.all) połączenie do ElevenLabs (multi-context, patrz
      // openElevenLabsSocket) — trzymane przez całą sesję i reużywane w
      // każdej turze, żeby nie płacić handshake'u (~130-150ms zmierzone na
      // żywo) za każdym razem od nowa.
      await Promise.all([
        new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("LiveAvatar Lite: WebSocket nie potwierdził połączenia w 10s.")), 10000);
          agentWs.onerror = (e) => { clearTimeout(timeout); reject(new Error(e.message || "LiveAvatar Lite: błąd WebSocket.")); };
          agentWs.onclose = () => { if (liteSessions.has(session_id)) console.warn(`LiveAvatar Lite: WS sesji ${session_id} zamknięty.`); };
          agentWs.onmessage = (ev) => {
            let parsed;
            try { parsed = JSON.parse(ev.data); } catch (_) { return; }
            if (parsed.type === "session.state_updated" && parsed.state === "connected") {
              clearTimeout(timeout);
              agentWs.send(liteCommand("agent.start_listening"));
              resolve();
              return;
            }
            if (parsed.type === "agent.speak_started") {
              sseSend(session, { stage: "avatar_speak_started", ms: Math.round(performance.now() - session.turnStartedAt) });
              return;
            }
            if (parsed.type === "agent.speak_ended") {
              sseSend(session, { stage: "avatar_speak_ended", ms: Math.round(performance.now() - session.turnStartedAt) });
              if (session.onSpeakEnded) { const cb = session.onSpeakEnded; session.onSpeakEnded = null; cb(); }
            }
            // agent.audio_buffer_appended/committed — potwierdzenia bufora,
            // widoczne w testach na żywo, ale nic z nimi tu nie robimy.
          };
        }),
        openElevenLabsSocket().then((ws) => {
          session.ttsWs = ws;
          // Po udanym połączeniu podmieniamy handlery na "trwa sesja" —
          // jeśli padnie później, runLiteTurn reconnectuje leniwie przy
          // następnej turze (patrz sprawdzenie readyState tam).
          ws.onclose = () => console.warn(`LiveAvatar Lite [${session_id}]: połączenie ElevenLabs zamknięte.`);
          ws.onerror = (e) => console.warn(`LiveAvatar Lite [${session_id}]: błąd połączenia ElevenLabs:`, e.message);
        }),
      ]);

      liteSessions.set(session_id, session);
      session.keepAliveTimer = setInterval(() => {
        try { agentWs.send(liteCommand("session.keep_alive")); } catch (_) {}
      }, 100000); // limit bezczynności to 5 min — odświeżamy co ~100s

      // Powitanie: opóźnione o 1.5s, żeby przeglądarka zdążyła dołączyć do
      // pokoju LiveKit (zaraz po odebraniu tej odpowiedzi) zanim popłynie
      // pierwsze audio — inaczej ryzykujemy urwany początek powitania.
      setTimeout(() => { runLiteTurn(session, null); }, 1500);

      return { sessionToken, sessionId: session_id, livekitUrl, livekitToken };
    },
    async endSession(sessionId) {
      const session = liteSessions.get(sessionId);
      if (!session) return;
      clearInterval(session.keepAliveTimer);
      liteSessions.delete(sessionId);
      for (const res of session.sseClients) { try { res.end(); } catch (_) {} }
      try { session.agentWs.close(); } catch (_) {}
      try { session.ttsWs && session.ttsWs.send(JSON.stringify({ close_socket: true })); } catch (_) {}
      try { session.ttsWs && session.ttsWs.close(); } catch (_) {}
      await fetch("https://api.liveavatar.com/v1/sessions/stop", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.sessionToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      console.log(`LiveAvatar Lite + ElevenLabs: sesja ${sessionId} zatrzymana.`);
    },
  },
};

// ---- LIVEAVATAR LITE + ELEVENLABS: pipeline pojedynczej tury rozmowy ----
// Wywoływane z /api/lite-turn po tym, jak przeglądarka (Web Speech API)
// dostarczy finalny transkrypt użytkownika. Groq (streaming) -> ElevenLabs
// (streaming, PCM 24kHz) -> agent.speak na ws_url, chunk po chunku, żeby
// pierwsze audio poleciało do awatara zanim LLM skończy całą odpowiedź.
const LITE_BYTES_PER_SEC = 48000; // PCM16 mono @ 24kHz = 2 bajty * 24000/s
// Skrócone z zalecanych przez LiveAvatar 600ms do 250ms — eksperymentalne,
// szybszy start mówienia awatara kosztem ryzyka mikroprzycięcia. Strojone
// pod niższą latencję; jeśli słychać cięcie na starcie, podnieś z powrotem
// bliżej 0.6.
const LITE_FIRST_CHUNK_BYTES = Math.floor(LITE_BYTES_PER_SEC * 0.25);
const LITE_NEXT_CHUNK_BYTES = LITE_BYTES_PER_SEC;

function liteCommand(type, extra = {}) {
  return JSON.stringify({ type, event_id: extra.event_id || crypto.randomUUID(), ...extra });
}

function sseSend(session, payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of session.sseClients) {
    try { res.write(line); } catch (_) { session.sseClients.delete(res); }
  }
}

// Jedno połączenie WebSocket do ElevenLabs na całą sesję (multi-context —
// wiele kolejnych "tur" bez ponownego handshake'u), zamiast nowego
// połączenia za każdą wypowiedzią. Zmierzone na żywo: handshake ~130-150ms,
// płacony teraz raz na sesję zamiast raz na turę. context_id per turę
// pozwala routować audio do właściwej wypowiedzi na współdzielonym
// połączeniu (limit: max 5 równoległych kontekstów, nieużywany tu — mamy
// zawsze jeden aktywny na raz dzięki turnInFlight).
function openElevenLabsSocket() {
  return new Promise((resolve, reject) => {
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/multi-stream-input?model_id=${ELEVENLABS_MODEL_ID}&output_format=pcm_24000`;
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error("ElevenLabs: WebSocket nie otworzył się w 10s.")), 10000);
    ws.onopen = () => { clearTimeout(timeout); resolve(ws); };
    ws.onerror = (e) => { clearTimeout(timeout); reject(new Error(e.message || "ElevenLabs: błąd WebSocket.")); };
  });
}

// userText === null oznacza turę otwierającą (patrz wywołanie w
// getSessionToken poniżej) — TRAINER_SYSTEM_PROMPT zakłada, że to AWATAR
// zaczyna rozmowę pytaniem o czas/kondycję. W Full mode robi to za nas
// LiveAvatar (opening_text na Contexcie); w Lite nic tego nie wywołuje samo
// z siebie, więc odpalamy jedną turę "na sucho" — sam system prompt, bez
// wiadomości użytkownika — żeby model wygenerował powitanie.
async function runLiteTurn(session, userText) {
  // Jedna wypowiedź na raz, ale z obsługą barge-in: /api/lite-interrupt
  // (patrz niżej) woła session.activeTurnAbort(), co przerywa Groq
  // (AbortController) i pozwala tej turze zakończyć się od razu zamiast
  // czekać na jej naturalny koniec.
  if (session.turnInFlight) {
    console.warn(`LiveAvatar Lite [${session.sessionId}]: tura zignorowana — poprzednia jeszcze trwa.`);
    return;
  }
  session.turnInFlight = true;
  session.turnStartedAt = performance.now();
  const controller = new AbortController();
  session.activeTurnAbort = () => controller.abort();
  const mark = (stage) => {
    console.log(`LiveAvatar Lite [${session.sessionId}] ${stage}`);
    sseSend(session, { stage, ms: Math.round(performance.now() - session.turnStartedAt) });
  };
  // Awaryjny wyłącznik: przy realnym teście na żywo ElevenLabs czasem nie
  // wysłał "isFinal" w rozsądnym czasie mimo że audio już dotarło, co bez
  // tego zabezpieczenia trwale blokowało turnInFlight (żadna kolejna
  // wypowiedź użytkownika nigdy by się nie przetworzyła — dokładnie to, co
  // zaobserwowano). Niezależnie od tego, GDZIEKOLWIEK coś innego by się
  // zawiesiło, ta tura i tak zwolni blokadę zamiast wisieć w nieskończoność.
  let settled = false;
  let contextId = null;
  const watchdog = setTimeout(() => {
    if (settled) return;
    console.error(`LiveAvatar Lite [${session.sessionId}]: tura nie zakończyła się w 30s — wymuszam zwolnienie blokady.`);
    session.turnInFlight = false;
    sseSend(session, { stage: "error", message: "Tura przekroczyła limit czasu (30s) — spróbuj ponownie." });
  }, 30000);

  try {
    if (userText) {
      recordLiveAvatarEvent({
        provider: "liveavatarLiteEleven",
        sessionId: session.sessionId,
        eventType: "user.transcription",
        event: { text: userText },
      });
    }
    mark("stt_ready"); // STT już gotowe (zrobione w przeglądarce, stąd ~0ms)
    session.agentWs.send(liteCommand("agent.stop_listening"));

    if (userText) session.history.push({ role: "user", content: userText });
    if (session.history.length > 4) session.history.splice(0, session.history.length - 4);

    // Reconnect, gdyby trwałe połączenie ElevenLabs padło między turami
    // (rzadkie, ale WebSocket może zostać zerwany przez sieć/serwer).
    if (!session.ttsWs || session.ttsWs.readyState !== WebSocket.OPEN) {
      session.ttsWs = await openElevenLabsSocket();
    }
    const ttsWs = session.ttsWs;
    contextId = `ctx-${Date.now()}`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      signal: controller.signal,
      body: JSON.stringify({
        // llama-3.1-8b-instant było ~100-150ms szybsze do pierwszego tokena,
        // ale w realnym teście robiło błędy gramatyczne i konfabulowało
        // (np. zmyśloną treść niezwiązaną z tym, co powiedział user) —
        // niewart tego kompromis dla asystenta prowadzącego trening.
        // Nadpisywalne przez GROQ_MODEL w .env, gdyby chcieć poeksperymentować.
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        temperature: 0.35,
        max_tokens: 250,
        stream: true,
        messages: [{ role: "system", content: session.systemPrompt }, ...session.history],
      }),
    });
    if (!groqRes.ok || !groqRes.body) throw new Error(`Groq ${groqRes.status}: ${await groqRes.text()}`);

    const eventId = `speak-${Date.now()}`;
    let pcmBuffer = Buffer.alloc(0);
    let chunkTarget = LITE_FIRST_CHUNK_BYTES;
    let firstAudioLogged = false;
    let firstSentToAvatarLogged = false;

    function flushPcm() {
      while (pcmBuffer.length >= chunkTarget) {
        const chunk = pcmBuffer.subarray(0, chunkTarget);
        pcmBuffer = pcmBuffer.subarray(chunkTarget);
        session.agentWs.send(liteCommand("agent.speak", { event_id: eventId, audio: chunk.toString("base64") }));
        // Rozbija "TTS pierwszy chunk" (pierwszy bajt od ElevenLabs) od
        // momentu faktycznego wysłania do LiveAvatar — czekamy na bufor
        // LITE_FIRST_CHUNK_BYTES zanim cokolwiek wyślemy, więc to osobny,
        // realny składnik opóźnienia.
        if (!firstSentToAvatarLogged) { firstSentToAvatarLogged = true; mark("audio_sent_to_avatar"); }
        chunkTarget = LITE_NEXT_CHUNK_BYTES;
      }
    }

    let ttsEnded = false;
    let allTextSent = false;
    let quietTimer = null;
    const ttsFinished = new Promise((resolve) => { ttsWs.onTextToSpeechFinished = resolve; });
    // Zweryfikowane na żywo: ElevenLabs czasem nie wysyła "isFinal" mimo że
    // całe audio już dotarło i LiveAvatar samo, niezależnie, uznaje
    // wypowiedź za skończoną (wykrywa brak nowego audio) i wysyła
    // agent.speak_ended — zanim nasz kod zdąży wysłać agent.speak_end. Bez
    // tego runLiteTurn czekał na isFinal, które nie nadchodzi, więc nigdy
    // nie zdążał podpiąć się pod realny agent.speak_ended (przechodził
    // "obok"), turnInFlight zostawał zablokowany na dziesiątki sekund, a
    // każda kolejna wypowiedź użytkownika była po cichu ignorowana. Zamiast
    // czekać ślepo, kończymy turę TTS po ~2s ciszy (braku nowego audio) od
    // wysłania całego tekstu — adaptacyjnie, niezależnie od isFinal.
    function finishTts() {
      if (ttsEnded) return;
      ttsEnded = true;
      clearTimeout(quietTimer);
      if (pcmBuffer.length) {
        session.agentWs.send(liteCommand("agent.speak", { event_id: eventId, audio: pcmBuffer.toString("base64") }));
        pcmBuffer = Buffer.alloc(0);
      }
      session.agentWs.send(liteCommand("agent.speak_end", { event_id: eventId }));
      // Zamykamy TYLKO ten kontekst, nie całe połączenie — reużywamy go w
      // kolejnej turze (patrz komentarz przy openElevenLabsSocket).
      try { ttsWs.send(JSON.stringify({ context_id: contextId, close_context: true })); } catch (_) {}
      ttsWs.onTextToSpeechFinished && ttsWs.onTextToSpeechFinished();
    }
    function scheduleQuietCheck() {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => { if (allTextSent) finishTts(); }, 2000);
    }
    ttsWs.onmessage = (ev) => {
      if (controller.signal.aborted) return; // przerwane przez barge-in — nie wysyłaj więcej audio
      let parsed;
      try { parsed = JSON.parse(ev.data); } catch (_) { return; }
      const msgContextId = parsed.contextId || parsed.context_id;
      if (msgContextId && msgContextId !== contextId) return; // wiadomość spoza tej tury (np. spóźniona z poprzedniej)
      if (parsed.audio) {
        if (!firstAudioLogged) { firstAudioLogged = true; mark("tts_first_chunk"); }
        pcmBuffer = Buffer.concat([pcmBuffer, Buffer.from(parsed.audio, "base64")]);
        flushPcm();
        scheduleQuietCheck(); // nowe audio = jeszcze nie cisza, przesuwamy licznik
      }
      // isFinal to najszybsza, ale niegwarantowana ścieżka — jeśli przyjdzie,
      // kończymy od razu zamiast czekać na ciszę.
      if (parsed.isFinal) finishTts();
    };
    // Pierwsza wiadomość nowego kontekstu — chunk_length_schedule niżej niż
    // domyślny, żeby ElevenLabs zaczynał generować audio po krótszym
    // fragmencie tekstu (szybszy pierwszy dźwięk, kosztem gorszej
    // płynności/intonacji na granicach fragmentów — eksperymentalne,
    // strojone pod niższą latencję).
    ttsWs.send(JSON.stringify({
      text: " ",
      context_id: contextId,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      generation_config: { chunk_length_schedule: [50, 90, 120, 150] },
      xi_api_key: process.env.ELEVENLABS_API_KEY,
    }));

    // Strumieniujemy odpowiedź Groq zdanie po zdaniu do ElevenLabs, żeby
    // TTS mógł zacząć generować zanim LLM dokończy całą wypowiedź.
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let ttsSentenceBuffer = "";
    let fullReplyText = "";
    let firstTokenLogged = false;
    for await (const chunk of groqRes.body) {
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop(); // ostatnia (niedokończona) linia zostaje w buforze
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") continue;
        let json;
        try { json = JSON.parse(data); } catch (_) { continue; }
        const delta = json?.choices?.[0]?.delta?.content;
        if (!delta) continue;
        if (!firstTokenLogged) { firstTokenLogged = true; mark("llm_first_token"); }
        fullReplyText += delta;
        ttsSentenceBuffer += delta;
        // Próg obniżony z 140 do 60 znaków — ElevenLabs dostaje tekst do
        // syntezy szybciej (eksperymentalne, patrz komentarz wyżej).
        if (/[.!?\n]\s*$/.test(ttsSentenceBuffer) || ttsSentenceBuffer.length > 60) {
          ttsWs.send(JSON.stringify({ text: ttsSentenceBuffer, context_id: contextId }));
          ttsSentenceBuffer = "";
        }
      }
    }
    if (ttsSentenceBuffer) ttsWs.send(JSON.stringify({ text: ttsSentenceBuffer, context_id: contextId }));
    ttsWs.send(JSON.stringify({ text: "", context_id: contextId, flush: true }));
    allTextSent = true;
    scheduleQuietCheck(); // cały tekst wysłany — odpal odliczanie ciszy, nawet jeśli audio jeszcze nie napłynęło

    session.history.push({ role: "assistant", content: fullReplyText });
    recordLiveAvatarEvent({
      provider: "liveavatarLiteEleven",
      sessionId: session.sessionId,
      eventType: "avatar.transcription",
      event: { text: fullReplyText },
    });
    // Jedyny sposób, żeby przeglądarka poznała treść odpowiedzi awatara w
    // Lite mode (w przeciwieństwie do FULL, gdzie leci to przez LiveKit data
    // channel) — potrzebne dla detectActiveExercise() w index.html, żeby
    // auto-detekcja ćwiczenia z rozmowy działała tak samo jak w FULL mode.
    sseSend(session, { stage: "avatar_transcription", text: fullReplyText });

    if (!controller.signal.aborted) {
      await ttsFinished;
      // Czekamy na agent.speak_ended (nasłuch podpięty przy tworzeniu sesji
      // w getSessionToken) zanim wrócimy do stanu nasłuchu — z
      // zabezpieczeniem czasowym, gdyby event z jakiegoś powodu nie dotarł.
      await new Promise((resolve) => {
        session.onSpeakEnded = resolve;
        setTimeout(resolve, 20000);
      });
      session.agentWs.send(liteCommand("agent.start_listening"));
    }
  } catch (error) {
    if (error.name === "AbortError") {
      console.log(`LiveAvatar Lite [${session.sessionId}] tura przerwana (barge-in).`);
      sseSend(session, { stage: "interrupted" });
    } else {
      console.error(`LiveAvatar Lite [${session.sessionId}]: błąd tury:`, error.message);
      sseSend(session, { stage: "error", message: error.message });
    }
  } finally {
    settled = true;
    clearTimeout(watchdog);
    session.activeTurnAbort = null;
    // Połączenie ElevenLabs zostaje otwarte na kolejną turę (patrz
    // openElevenLabsSocket) — zamykamy tu tylko kontekst tej tury, na
    // wypadek gdyby finishTts() nie zdążył tego zrobić (błąd/przerwanie).
    if (contextId && session.ttsWs) {
      try { session.ttsWs.send(JSON.stringify({ context_id: contextId, close_context: true })); } catch (_) {}
    }
    session.turnInFlight = false;
    console.log(`LiveAvatar Lite [${session.sessionId}] tura zakończona, blokada zwolniona.`);
  }
}

// Wygłasza gotowy tekst (korekta/pochwała postawy z posture.js + Groq, patrz
// /api/posture-correction i /api/posture-affirmation niżej) w aktywnej sesji
// LiveAvatar Lite. Odrębna od runLiteTurn: tam tekst odpowiedzi strumieniuje
// się zdanie po zdaniu WPROST z Groq (dla niskiej latencji pierwszej głoski);
// tu tekst jest już kompletny, nie ma czego strumieniować, więc to prostszy,
// jednorazowy przebieg tego samego ostatniego odcinka (ElevenLabs -> PCM ->
// agent.speak). Celowo NIE dopisane do runLiteTurn — ta funkcja ma kilka
// nietrywialnych fixów wystrojonych pod żywą rozmowę (watchdog na brakujące
// isFinal, AbortController po Groq); mieszanie dwóch przypadków użycia w
// jednej funkcji groziłoby regresją tamtej ścieżki.
async function speakLiteCue(session, text, { interrupt = false } = {}) {
  if (interrupt) {
    // Ta sama sekwencja co /api/lite-interrupt — korekta ma prawo przerwać
    // awatara w trakcie mówienia, tak jak avatar.interrupt w FULL mode.
    if (session.activeTurnAbort) session.activeTurnAbort();
    if (session.onSpeakEnded) { const cb = session.onSpeakEnded; session.onSpeakEnded = null; cb(); }
    try { session.agentWs.send(liteCommand("agent.interrupt")); } catch (_) {}
    session.turnInFlight = false;
  }
  if (session.turnInFlight) {
    // Pochwała nie przerywa (interrupt=false) — jeśli awatar akurat mówi,
    // wolimy pominąć tę turę niż walczyć o tę samą blokację co runLiteTurn.
    console.warn(`LiveAvatar Lite [${session.sessionId}]: korekta/pochwała postawy zignorowana — tura w toku.`);
    return false;
  }
  session.turnInFlight = true;
  let aborted = false;
  let resolveTurn = null;
  // Barge-in w trakcie korekty (patrz /api/lite-interrupt) musi móc przerwać
  // TĘ turę natychmiast, tak samo jak przerywa Groq w runLiteTurn.
  session.activeTurnAbort = () => { aborted = true; if (resolveTurn) resolveTurn(); };
  try {
    if (!session.ttsWs || session.ttsWs.readyState !== WebSocket.OPEN) {
      session.ttsWs = await openElevenLabsSocket();
    }
    const ttsWs = session.ttsWs;
    const contextId = `posture-${Date.now()}`;
    const eventId = `speak-${Date.now()}`;
    let pcmBuffer = Buffer.alloc(0);
    let chunkTarget = LITE_FIRST_CHUNK_BYTES;
    function flushPcm() {
      while (pcmBuffer.length >= chunkTarget) {
        const chunk = pcmBuffer.subarray(0, chunkTarget);
        pcmBuffer = pcmBuffer.subarray(chunkTarget);
        session.agentWs.send(liteCommand("agent.speak", { event_id: eventId, audio: chunk.toString("base64") }));
        chunkTarget = LITE_NEXT_CHUNK_BYTES;
      }
    }
    await new Promise((resolve) => {
      resolveTurn = resolve;
      let done = false;
      let quietTimer = null;
      const watchdog = setTimeout(() => { if (!done) { done = true; resolve(); } }, 20000);
      function finish() {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        clearTimeout(quietTimer);
        if (!aborted) {
          if (pcmBuffer.length) {
            session.agentWs.send(liteCommand("agent.speak", { event_id: eventId, audio: pcmBuffer.toString("base64") }));
            pcmBuffer = Buffer.alloc(0);
          }
          session.agentWs.send(liteCommand("agent.speak_end", { event_id: eventId }));
        }
        try { ttsWs.send(JSON.stringify({ context_id: contextId, close_context: true })); } catch (_) {}
        resolve();
      }
      ttsWs.onmessage = (ev) => {
        if (aborted) return;
        let parsed;
        try { parsed = JSON.parse(ev.data); } catch (_) { return; }
        const msgContextId = parsed.contextId || parsed.context_id;
        if (msgContextId && msgContextId !== contextId) return; // spóźniona wiadomość z innej tury
        if (parsed.audio) {
          pcmBuffer = Buffer.concat([pcmBuffer, Buffer.from(parsed.audio, "base64")]);
          flushPcm();
          clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, 2000); // ten sam adaptacyjny fallback co finishTts() w runLiteTurn
        }
        if (parsed.isFinal) finish();
      };
      ttsWs.send(JSON.stringify({
        text,
        context_id: contextId,
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
        generation_config: { chunk_length_schedule: [50, 90, 120, 150] },
        xi_api_key: process.env.ELEVENLABS_API_KEY,
      }));
      ttsWs.send(JSON.stringify({ text: "", context_id: contextId, flush: true }));
    });
    if (aborted) return false;
    // Sesja Lite zna dokładny wygłoszony tekst (w przeciwieństwie do FULL,
    // gdzie serwer nie widzi z powrotem transkrypcji korekty) — zapisujemy go
    // do Session Recorder / pamięci tak samo jak zwykłe repliki avatara.
    recordLiveAvatarEvent({
      provider: "liveavatarLiteEleven",
      sessionId: session.sessionId,
      eventType: "avatar.transcription",
      event: { text },
    });
    await new Promise((resolve) => {
      session.onSpeakEnded = resolve;
      setTimeout(resolve, 20000);
    });
    session.agentWs.send(liteCommand("agent.start_listening"));
    return true;
  } finally {
    session.activeTurnAbort = null;
    session.turnInFlight = false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Nieprawidłowy JSON w body żądania"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Lista dostępnych dostawców — front-end buduje z tego dropdown
  if (req.method === "GET" && req.url === "/api/providers") {
    const providers = Object.entries(PROVIDERS).map(([key, p]) => ({ key, label: p.label }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ providers }));
    return;
  }

  // Endpoint wymiany klucza na session token — dostawca wybierany w body
  if (req.method === "POST" && req.url === "/api/session-token") {
    try {
      const body = await readJsonBody(req);
      const providerKey = body.provider || "anam";
      const provider = PROVIDERS[providerKey];
      if (!provider || typeof provider.getSessionToken !== "function") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Dostawca "${providerKey}" nie obsługuje /api/session-token` }));
        return;
      }
      const result = await provider.getSessionToken();
      // Rozpoczynamy rekord po stronie serwera, zanim browser dostanie token.
      // Dzięki temu nawet nieudane połączenie WebRTC pozostawia ślad sesji i
      // może zostać domknięte przez /api/session-end.
      let recorder = null;
      if (LIVEAVATAR_PROVIDERS.has(providerKey) && result.sessionId) {
        const record = recordLiveAvatarEvent({
          provider: providerKey,
          sessionId: result.sessionId,
          eventType: "session.started",
          event: { source: "server" },
        });
        recorder = { state: "recording", eventCount: record?.events.length || 0 };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ provider: providerKey, ...result, recorder }));
    } catch (e) {
      console.error("Błąd serwera:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Eventy LiveKit są odbierane w browserze, a następnie przekazywane do
  // recordera. Przyjmuje tylko providerów LiveAvatar i nie zapisuje tokenów.
  if (req.method === "POST" && req.url === "/api/session-record/event") {
    try {
      const body = await readJsonBody(req);
      if (!LIVEAVATAR_PROVIDERS.has(body.provider) || !body.sessionId || !RECORDABLE_LIVEAVATAR_EVENTS.has(body.eventType)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Nieprawidłowy event Session Recorder." }));
        return;
      }
      const record = recordLiveAvatarEvent({
        provider: body.provider,
        sessionId: body.sessionId,
        eventType: body.eventType,
        event: body.event,
      });
      // Finalny upsert następuje dopiero przy session.stopped. Wcześniejsze
      // eventy są świadomie buforowane, aby baza dostała kompletną sesję.
      let result = { saved: false, storageStatus: "buffered_in_memory" };
      if (body.eventType === "session.stopped") {
        result = await persistRecordedSession(record, body.event?.end_reason);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        eventCount: record?.events.length || 0,
        record: recorderSnapshot(record),
        ...result,
      }));
    } catch (e) {
      console.error("Błąd Session Recorder:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Rejestr ćwiczeń/odchyleń do zbudowania panelu debug w UI (patrz posture.js).
  if (req.method === "GET" && req.url === "/api/posture-cues") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ exercises: listExerciseCues() }));
    return;
  }

  // Serwuje wszystkie nagrane kalibracje (calibration/*.json) — klient ładuje
  // to raz przy starcie do zbudowania danych treningowych k-NN. Pusty/brak
  // katalogu -> [] (nigdy błąd), żeby front-end mógł się cicho wyłączyć
  // (graceful degradation, patrz public/knn.js).
  if (req.method === "GET" && req.url === "/api/calibration") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ calibrations: loadAllCalibrations() }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Dopisuje jedno nagranie kalibracyjne do calibration/<poseId>.<variant>.json
  // (append, nie nadpisanie — patrz calibration.js). samples to surowe
  // landmarki zebrane w przeglądarce podczas 10s nagrywania (tryb ?calibrate=1).
  if (req.method === "POST" && req.url === "/api/calibration") {
    try {
      const body = await readJsonBody(req);
      if (
        !body.poseId ||
        !["pelna", "zlagodzona"].includes(body.variant) ||
        !Array.isArray(body.samples) ||
        body.samples.length === 0
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Wymagane: poseId, variant (pelna|zlagodzona), niepusty samples[]." }));
        return;
      }
      const result = appendCalibrationRecording(body.poseId, body.variant, body.poseLabel, {
        recordedAt: body.recordedAt || new Date().toISOString(),
        durationMs: body.durationMs,
        samples: body.samples,
        angleAggregates: body.angleAggregates || {},
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, poseId: body.poseId, variant: body.variant, ...result }));
    } catch (e) {
      console.error("Błąd zapisu kalibracji:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Zwraca tekst korekty dla danego ćwiczenia/odchylenia. exercise/deviation
  // przychodzą z pose-detector.js (reguły geometryczne + debouncer w
  // index.html), które ćwiczenie jest aktualne wykrywa detectActiveExercise()
  // z transkrypcji rozmowy. Tekst generuje Groq (generateGroqCorrection,
  // patrz wyżej); jeśli to zawiedzie (brak klucza, błąd sieci, timeout), leci
  // fallback z posture.js — korekta nigdy nie milczy, tylko brzmi sztywniej.
  // sessionId (opcjonalny) pozwala dodatkowo wygłosić korektę na żywo w
  // sesji LiveAvatar Lite — patrz speakLiteCue() niżej (FULL mode dostaje
  // tekst z tej odpowiedzi i mówi go sam przez LiveKit, patrz index.html).
  if (req.method === "POST" && req.url === "/api/posture-correction") {
    try {
      const body = await readJsonBody(req);
      const cue = buildPostureCue(body.exercise, body.deviation);
      if (!cue) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Nieznana kombinacja exercise/deviation: ${body.exercise}/${body.deviation}` }));
        return;
      }
      let source = "fallback";
      try {
        cue.text = await generateGroqCorrection(cue.exerciseLabel, cue.deviationLabel);
        source = "groq";
      } catch (groqError) {
        console.warn("Posture Correction: Groq nie odpowiedział, używam fallbacku:", groqError.message);
      }
      const liteSession = liteSessions.get(body.sessionId);
      if (liteSession) {
        // Fire-and-forget, jak /api/lite-turn niżej — postęp/błędy tylko w
        // logu serwera, odpowiedź HTTP nie czeka na wygłoszenie korekty.
        speakLiteCue(liteSession, cue.text, { interrupt: true }).catch((e) =>
          console.error("LiveAvatar Lite: błąd wygłoszenia korekty postawy:", e.message)
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...cue, source }));
    } catch (e) {
      console.error("Błąd Posture Correction:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Strumień statusu pipeline'u LiveAvatar Lite + ElevenLabs (Server-Sent
  // Events — natywne po obu stronach, bez dodatkowej biblioteki). Front-end
  // otwiera to raz po starcie sesji i na tej podstawie loguje identyczny
  // format "LATENCJA ODPOWIEDZI" co pozostałe adaptery, plus czasy pośrednie
  // per ogniwo (STT/LLM/TTS/avatar).
  if (req.method === "GET" && req.url.startsWith("/api/lite-events")) {
    const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId");
    const session = liteSessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Nieznana sesja Lite." }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    session.sseClients.add(res);
    req.on("close", () => session.sseClients.delete(res));
    return;
  }

  // Finalny transkrypt użytkownika (z Web Speech API w przeglądarce) ->
  // uruchamia jedną turę pipeline'u Groq -> ElevenLabs -> ws_url. Odpowiada
  // od razu (202) — postęp leci przez /api/lite-events, nie przez ten request.
  if (req.method === "POST" && req.url === "/api/lite-turn") {
    try {
      const body = await readJsonBody(req);
      const session = liteSessions.get(body.sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Nieznana sesja Lite." }));
        return;
      }
      if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Brak tekstu w treści żądania." }));
        return;
      }
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      runLiteTurn(session, body.text.trim());
    } catch (e) {
      console.error("LiveAvatar Lite: błąd /api/lite-turn:", e.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // Symetryczne do /api/posture-correction — pochwała zamiast korekty, gdy
  // affirmationDebouncer w index.html potwierdzi, że wszystkie reguły danego
  // ćwiczenia są spełnione przez dłuższą chwilę. Ten sam fallback-first wzorzec.
  if (req.method === "POST" && req.url === "/api/posture-affirmation") {
    try {
      const body = await readJsonBody(req);
      const affirmation = buildPostureAffirmation(body.exercise);
      if (!affirmation) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Nieznane exercise: ${body.exercise}` }));
        return;
      }
      let source = "fallback";
      try {
        affirmation.text = await generateGroqAffirmation(affirmation.exerciseLabel);
        source = "groq";
      } catch (groqError) {
        console.warn("Posture Affirmation: Groq nie odpowiedział, używam fallbacku:", groqError.message);
      }
      const liteSession = liteSessions.get(body.sessionId);
      if (liteSession) {
        // interrupt: false — pochwała nie jest pilna; jeśli awatar akurat
        // mówi (turnInFlight), speakLiteCue po prostu rezygnuje (patrz niżej).
        speakLiteCue(liteSession, affirmation.text, { interrupt: false }).catch((e) =>
          console.error("LiveAvatar Lite: błąd wygłoszenia pochwały postawy:", e.message)
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...affirmation, source }));
    } catch (e) {
      console.error("Błąd Posture Affirmation:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Komunikat "rozjazd pozycji" — public/posture-state-machine.js (stan
  // MISMATCH) wywołuje to, gdy k-NN stabilnie widzi INNĄ nazwaną pozycję niż
  // zadana. Wzorzec identyczny do /api/posture-correction: fallback-first,
  // interrupt:true (najwyższy priorytet — patrz speakLiteCue niżej).
  if (req.method === "POST" && req.url === "/api/posture-mismatch") {
    try {
      const body = await readJsonBody(req);
      const cue = buildPostureMismatchCue(body.target, body.detected);
      if (!cue) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Nieznana kombinacja target/detected: ${body.target}/${body.detected}` }));
        return;
      }
      let source = "fallback";
      try {
        cue.text = await generateGroqMismatchCue(cue);
        source = "groq";
      } catch (groqError) {
        console.warn("Posture Mismatch: Groq nie odpowiedział, używam fallbacku:", groqError.message);
      }
      const liteSession = liteSessions.get(body.sessionId);
      if (liteSession) {
        speakLiteCue(liteSession, cue.text, { interrupt: true }).catch((e) =>
          console.error("LiveAvatar Lite: błąd wygłoszenia komunikatu rozjazdu:", e.message)
        );
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...cue, source }));
    } catch (e) {
      console.error("Błąd Posture Mismatch:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Barge-in: przeglądarka wywołuje to, gdy użytkownik zaczyna mówić W
  // TRAKCIE gdy awatar jeszcze gada. Przerywa bieżącą turę (Groq przez
  // AbortController, LiveAvatar przez agent.interrupt) i od razu zwalnia
  // blokadę, żeby nowa wypowiedź użytkownika mogła ruszyć jako świeża tura.
  if (req.method === "POST" && req.url === "/api/lite-interrupt") {
    try {
      const body = await readJsonBody(req);
      const session = liteSessions.get(body.sessionId);
      if (session) {
        if (session.activeTurnAbort) session.activeTurnAbort();
        if (session.onSpeakEnded) { const cb = session.onSpeakEnded; session.onSpeakEnded = null; cb(); }
        try {
          session.agentWs.send(liteCommand("agent.interrupt"));
          session.agentWs.send(liteCommand("agent.start_listening"));
        } catch (_) {}
        // Pas i szelki: gdyby powyższe z jakiegoś powodu nie odblokowało w
        // porę (np. przerwanie trafiło między turami), i tak zwalniamy.
        session.turnInFlight = false;
        console.log(`LiveAvatar Lite [${session.sessionId}]: barge-in.`);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error("LiveAvatar Lite: błąd /api/lite-interrupt:", e.message);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // Sprzątanie po stronie dostawcy (Stop w UI) — nie wszyscy dostawcy tego
  // potrzebują (Anam kończy się w pełni po stronie klienta), więc brak
  // endSession() u danego providera po prostu nic nie robi.
  if (req.method === "POST" && req.url === "/api/session-end") {
    try {
      const body = await readJsonBody(req);
      const provider = PROVIDERS[body.provider];
      let providerEndError = null;
      if (provider && typeof provider.endSession === "function" && body.id) {
        try {
          await provider.endSession(body.id);
        } catch (e) {
          // Nawet gdy dostawca jest chwilowo niedostępny, lokalnie zebrana
          // rozmowa musi trafić do storage.
          providerEndError = e;
          console.error("Błąd zatrzymania sesji u dostawcy:", e.message);
        }
      }
      let recorder = { saved: false };
      if (LIVEAVATAR_PROVIDERS.has(body.provider) && body.id) {
        const record = recordLiveAvatarEvent({
          provider: body.provider,
          sessionId: body.id,
          eventType: "session.client_stopped",
          event: { end_reason: "USER_CLOSED" },
        });
        recorder = {
          ...await persistRecordedSession(record, "USER_CLOSED"),
          record: recorderSnapshot(record),
        };
      }
      // Zwracamy również wynik recordera, jeśli zatrzymanie u LiveAvatar
      // nie powiedzie się. Monitor w UI może wtedy pokazać, że dane zostały
      // zapisane mimo błędu po stronie dostawcy.
      res.writeHead(providerEndError ? 502 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: !providerEndError,
        providerStopError: providerEndError?.message || null,
        recorder,
      }));
    } catch (e) {
      console.error("Błąd kończenia sesji:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Statyczne pliki z /public. Odcinamy query string (np. ?calibrate=1) przez
  // pathname — surowe req.url porównane z "/" nie łapało "/?calibrate=1",
  // co dawało 404 zamiast index.html z parametrem.
  const { pathname } = new URL(req.url, "http://localhost");
  const filePath = path.join(
    __dirname,
    "public",
    pathname === "/" ? "index.html" : pathname
  );
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
    res.end(content);
  });
});

server.listen(3000, () => {
  console.log("Test awatarów: http://localhost:3000");
  console.log("Dostępni dostawcy:", Object.keys(PROVIDERS).join(", "));
});
