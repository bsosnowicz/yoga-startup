// server.js — serwer do testu awatarów (Anam + HeyGen LiveAvatar)
// Użycie:
//   node server.js
//   -> otwórz http://localhost:3000
//
// Zero zależności npm — czysty Node (18+).

const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildCoachPrompt, extractionPrompt, parseExtraction } = require("./memory");

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

const GROQ_TRAINER_PROMPT = "Jesteś przyjaznym trenerem jogi. Rozmawiasz po polsku. Odpowiadaj krótko i naturalnie.";

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
const LIVEAVATAR_PROVIDERS = new Set(["liveavatar", "liveavatarGroq"]);
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

async function loadMemoryContext(userId) {
  if (!process.env.SUPABASE_URL || !supabaseServiceKey()) return { profile: [], preferences: [], unfinishedSession: [] };
  try {
    const [profileResponse, preferenceResponse, sessionResponse] = await Promise.all([
      supabaseRequest(`user_memory?user_id=eq.${encodeURIComponent(userId)}&category=eq.profile&select=key,value,confidence&order=updated_at.desc&limit=7`),
      supabaseRequest(`user_memory?user_id=eq.${encodeURIComponent(userId)}&category=eq.preference&select=key,value,confidence&order=updated_at.desc&limit=3`),
      supabaseRequest(`session_memory?user_id=eq.${encodeURIComponent(userId)}&is_unfinished=eq.true&select=source_session_id,key,value,confidence&order=created_at.desc&limit=20`),
    ]);
    const unfinishedCandidates = await sessionResponse.json();
    const latestUnfinishedId = unfinishedCandidates[0]?.source_session_id;
    return {
      profile: await profileResponse.json(),
      preferences: await preferenceResponse.json(),
      // Tylko najnowsza niedokończona sesja; jej kilka rekordów opisuje stan.
      unfinishedSession: latestUnfinishedId ? unfinishedCandidates.filter((item) => item.source_session_id === latestUnfinishedId) : [],
    };
  } catch (error) {
    // Migracja może nie być jeszcze uruchomiona. Nie blokujemy LiveAvatar.
    console.warn("Memory Cleanup: nie udało się odczytać pamięci:", error.message);
    return { profile: [], preferences: [], unfinishedSession: [] };
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
        messages: [{ role: "system", content: "You extract only explicit user facts. Return JSON only." }, { role: "user", content: extractionPrompt(transcript) }],
      }),
    });
    if (!groqResponse.ok) throw new Error(`Groq ${groqResponse.status}: ${await groqResponse.text()}`);
    const completion = await groqResponse.json();
    const items = parseExtraction(completion?.choices?.[0]?.message?.content, record.session_id, transcript);
    const userId = record.user_id || memoryUserId();
    const profileItems = items.filter((item) => item.category === "profile" || item.category === "preference")
      .map((item) => ({ ...item, user_id: userId, updated_at: new Date().toISOString() }));
    const sessionItems = items.filter((item) => item.category === "session");
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
    console.log(`Memory Cleanup: zapisano ${profileItems.length} faktów i ${sessionItems.length} faktów sesji.`);
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
Potem poprowadź go przez 2-3 proste pozycje (np. pozycja dziecka, kot-krowa,
pies z głową w dół): powiedz jak wejść w pozycję, przypominaj o oddechu,
po kilku oddechach powiedz jak wyjść. Reaguj na to, co mówi użytkownik -
jeśli mówi, że coś boli albo że musi kończyć, dostosuj się natychmiast.`;

// ---- DOSTAWCY AWATARÓW ----
// Każdy dostawca ma swoją funkcję getSessionToken() zwracającą co najmniej
// { sessionToken } (może dorzucić dodatkowe pola — trafiają one 1:1 do
// odpowiedzi JSON). Front-end (public/index.html) wybiera dostawcę w
// dropdownie i wysyła jego klucz w body POST /api/session-token. Dodanie
// kolejnego dostawcy = nowy wpis tutaj + odpowiadający mu adapter w
// ADAPTERS w index.html.
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
      const AVATAR_ID = "55eec60c-d665-4972-a529-bbdcaf665ab8"; // Bryan Fitness Coach (globalny)
      const VOICE_ID = "9c8b542a-bf5c-4f4c-9011-75c79a274387";  // default_voice tego avatara (globalny)
      const CONTEXT_ID = "ac9b0086-8348-4caa-bf50-414ef00d36f7"; // Context "Yoga trainer" na TYM koncie

      const tokenRes = await fetch("https://api.liveavatar.com/v1/sessions/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": API_KEY },
        body: JSON.stringify({
          mode: "FULL",
          avatar_id: AVATAR_ID,
          is_sandbox: false,
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
      // Te same publiczne zasoby są już sprawdzone w istniejącym providerze
      // LiveAvatar Full. Można je opcjonalnie nadpisać w .env.
      const avatarId = process.env.LIVEAVATAR_AVATAR_ID || "55eec60c-d665-4972-a529-bbdcaf665ab8";
      const voiceId = process.env.LIVEAVATAR_VOICE_ID || "9c8b542a-bf5c-4f4c-9011-75c79a274387";
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
};

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

  // Statyczne pliki z /public
  const filePath = path.join(
    __dirname,
    "public",
    req.url === "/" ? "index.html" : req.url
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
