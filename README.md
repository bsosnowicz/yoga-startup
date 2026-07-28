# LiveAvatar FULL — Session Recorder

Uruchom serwer Node 18+ (adapter **LiveAvatar Lite + ElevenLabs** wymaga Node 22+ — patrz niżej):

```bash
cp .env.example .env
# uzupełnij LIVEAVATAR_API_KEY oraz dane Supabase
node server.js
```

W aplikacji wybierz **HeyGen LiveAvatar (Full mode)**. Serwer tworzy rekord sesji zaraz po jej uruchomieniu. Przeglądarka odbiera eventy LiveKit i przekazuje tylko finalne `user.transcription`, `avatar.transcription` oraz `session.stopped`. Przy `session.stopped` albo kliknięciu Stop serwer robi jeden upsert kompletnej sesji do `avatar_sessions`.

Sekretny klucz Supabase zostaje wyłącznie na serwerze. Jeśli zmienne Supabase nie są ustawione, rozmowa nadal działa, ale serwer wyraźnie zaloguje, że sesja nie została utrwalona.

Ustaw `LIVEAVATAR_SANDBOX=true` w `.env`, żeby testować providery `liveavatar` i `liveavatarGroq` w trybie sandbox LiveAvatar (nie zużywa realnych tokenów/minut z konta). Domyślnie (brak zmiennej albo dowolna inna wartość) sesje idą na produkcyjne tokeny.

## Supabase: prompt / SQL do wklejenia

W Supabase SQL Editor uruchom:

```sql
create table if not exists public.avatar_sessions (
  session_id text primary key,
  provider text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  user_transcript jsonb not null default '[]'::jsonb,
  avatar_transcript jsonb not null default '[]'::jsonb,
  events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists avatar_sessions_ended_at_idx
  on public.avatar_sessions (ended_at desc);

alter table public.avatar_sessions enable row level security;
```

Ustaw w lokalnym `.env` `SUPABASE_URL` oraz serwerowy `SUPABASE_SECRET_KEY` (ewentualnie starszy `SUPABASE_SERVICE_ROLE_KEY`). Nie używaj `anon` key. Serverowy klucz omija RLS i nie jest wysyłany do przeglądarki.

## Sprint 1 — Memory Cleanup

Przed zmianą aplikacja przechowywała wyłącznie surowy rekord `avatar_sessions` (transkrypcje i eventy). Nie było tabeli profilu, summary ani kodu, który przekazywał pamięć do Groq.

Uruchom po istniejącym SQL migrację [20260720_memory_cleanup.sql](supabase/migrations/20260720_memory_cleanup.sql). Nie usuwa ona danych: dodaje `user_id` do `avatar_sessions` oraz tworzy wierszowe tabele `user_memory` (profile i preferencje) i `session_memory` (stan jednej sesji).

Jeśli tabele `user_memory`/`session_memory` już istnieją w Twoim projekcie Supabase bez `UNIQUE` constraintów na `(user_id, category, key)` i `(source_session_id, key)` — sprawdź to w SQL Editor przez `\d user_memory` albo w Table Editor — odpal dodatkowo [20260721_memory_unique_constraints.sql](supabase/migrations/20260721_memory_unique_constraints.sql). Bez tych constraintów upserty w `server.js` (`on_conflict=...`) zwracają błąd Postgresa 42P10, który jest po cichu łapany i tylko logowany — pamięć nie zapisuje się wcale.

Po zakończeniu sesji backend wysyła **wyłącznie wypowiedzi użytkownika** do tego samego Groq, który już obsługuje Custom LLM. Odpowiedź musi być JSON-em z rozdzielonymi faktami `profile`, `preference` i `session`; zapisany jest każdy fakt osobno z `source_session_id` i `confidence`. Tymczasowy ból nie staje się ograniczeniem przewlekłym.

Przed nową sesją backend pobiera maks. 7 faktów profilu, 3 preferencje i tylko najnowszą niedokończoną sesję. Aktualizuje istniejący LiveAvatar Context tym ograniczonym kontekstem — bez zmiany providera, modelu czy integracji LiveKit.

Sprawdź zachowanie bez uruchamiania rozmowy:

```bash
node test-memory.js
```

## Sprint 2 — korekta postawy (live)

"Czytaj ruch na żywo → wygeneruj korektę (albo pochwałę) dla bieżącego
ćwiczenia → niech awatar to od razu powie" — działa dziś w pełni automatycznie
dla **3 ćwiczeń** (`child_pose`, `downward_dog`, `warrior_2` — jedyne z pełnym
pokryciem regułami geometrycznymi). To namiastka biomechaniki ("kilka grubych
błędów"), nie pełny system.

Co działa już teraz:
- [posture.js](posture.js) — rejestr 3 ćwiczeń/odchyleń (`buildPostureCue`,
  `buildPostureAffirmation`, `listExerciseCues`). `text` w rejestrze to
  **fallback**, nie główne źródło wypowiedzi (patrz niżej). `keywords` per
  ćwiczenie służą do wykrycia z transkrypcji rozmowy, które ćwiczenie trwa.
- `GET /api/posture-cues` — zwraca rejestr (z keywordami) do klienta.
- `POST /api/posture-correction` `{ exercise, deviation }` i
  `POST /api/posture-affirmation` `{ exercise }` → `{ text, source }` — oba
  symetryczne: tekst generuje **Groq** (`generateGroqCorrection` /
  `generateGroqAffirmation` w `server.js`), karmiony etykietą + wspólnym
  `POSTURE_COACH_STYLE_GUIDE` (jednorazowy styl-guide trenera — ton i
  bezpieczeństwo, nie zdanie na każdą kombinację). Przy błędzie Groqa (brak
  `GROQ_API_KEY`, sieć, timeout) — cichy fallback z `posture.js`, endpoint się
  nie wywala. `source: "groq" | "fallback"` w odpowiedzi — widoczne w logu.
- [public/pose-detector.js](public/pose-detector.js) — MediaPipe Pose Landmarker
  (model `lite`, w 100% w przeglądarce, bez konta/klucza) + generyczny silnik
  oceny reguł (`evaluateRule`, `computeAngle`, `computeRatio`). Punkty
  niewidoczne dla kamery (`visibility < 0.6`) są odrzucane, a surowa wartość
  (kąt/ratio) jest wygładzana w oknie ostatnich 5 klatek (`createValueSmoother`)
  PRZED porównaniem z progiem — osobny mechanizm od czasowego debounce'a
  (`createDeviationDebouncer`) niżej, który wygładza w czasie już gotowy wynik
  bool, nie samą liczbę.
- [public/posture-rules.js](public/posture-rules.js) — deklaratywne dane 6
  reguł geometrycznych (typ `angle` albo `ratio`, indeksy landmarków, progi
  `min`/`max`), oddzielone od silnika w `pose-detector.js`: `child_pose/arms_not_extended`
  (kąt w łokciu), `child_pose/hips_too_high` (biodro vs kolano),
  `downward_dog/shoulders_shrugged` (ucho vs ramię), `downward_dog/heels_lifted`
  (pięta vs czubek stopy), `warrior_2/front_knee_not_bent` (kąt przedniego
  kolana), `warrior_2/arms_not_level` (nadgarstek vs linia barków). Reguły typu
  `ratio` liczą znormalizowany stosunek do długości odpowiedniego segmentu
  ciała — celowy wybór (patrz komentarz przy `heels_lifted` w kodzie), nie
  uproszczenie tymczasowe.
- **Ćwiczenie wykrywane jest automatycznie z rozmowy**, nie ręcznie: w
  [public/index.html](public/index.html) `detectActiveExercise()` dopasowuje
  `keywords` z `posture.js` do transkrypcji zarówno usera, jak i avatara
  (`user.transcription` / `avatar.transcription`) — proste dopasowanie
  słów kluczowych, nie wywołanie LLM-a (przy tylko 3 wyraźnie odrębnych
  polskich nazwach jest równie niezawodne i praktycznie darmowe/natychmiastowe;
  ta sama zasada co przy regułach kątowych zamiast LLM-a do samej detekcji).
  Po przełączeniu ćwiczenia jest **4s grace period**, zanim reguły zaczną
  wyzwalać korekty/pochwały — user dostaje chwilę na wejście w pozycję. To
  nie jest pełne rozwiązanie: nie ma klasyfikatora "czy user faktycznie jest
  w tej pozycji", tylko reguły zakładające, że dana pozycja jest już
  wykonywana — świadome ograniczenie, nie ukryty bug.
- **Potwierdzanie dobrej postawy, nie tylko korekta błędów**: gdy wszystkie
  reguły aktywnego ćwiczenia są spełnione przez dłużej (3.5s, dłużej niż
  korekta potrzebuje do wyzwolenia się — 1s) niż `cooldownMs` (25s) od
  ostatniej pochwały, leci `sendPostureAffirmation`. Korekta domyślnie
  przerywa bieżącą wypowiedź avatara (`avatar.interrupt`), pochwała nie
  (nie jest pilna).
- **Avatar nie ocenia sam z siebie, czy postawa jest poprawna** — to była
  realna usterka: avatar (zwykła rozmowa, ślepy na obraz) potrafił powiedzieć
  "wszystko dobrze" niezależnie od faktycznej pozycji. `TRAINER_SYSTEM_PROMPT`
  i `GROQ_TRAINER_PROMPT` w `server.js` mają teraz jawny zakaz oceniania
  postawy — to zadanie wyłącznie dla systemu korekty opisanego wyżej.
  **Uwaga:** to automatycznie działa tylko dla `liveavatarGroq` (Context
  patchowany dynamicznie przy starcie sesji). Dla zwykłego `liveavatar` (Full
  mode) trzeba ręcznie zaktualizować treść Contextu w dashboardzie LiveAvatar
  — to ten sam, już istniejący problem co przy każdej innej zmianie promptu
  dla tego providera (patrz komentarz przy `PROVIDERS.liveavatar`).
- Podgląd kamery rysuje szkielet + landmarki na canvasie nad wideo
  (`drawLandmarks` w `pose-detector.js`) — pomarańczowe punkty to te, które
  faktycznie zasilają regułę aktywnego ćwiczenia, plus tekstowy odczyt
  aktualnej wartości (kąt/stosunek) do kalibracji progów na żywo.

**Progi w `posture-rules.js` to wstępne zgadywanie** (140° dla łokcia, 0.15
ucho/tułów, 0.2 biodro/kolano, 0.25 pięta/czubek stopy, 80-120° dla kolana
w Wojowniku II, ±0.2 dla ręce/barki) — do skalibrowania patrząc na realne
nagranie testera w kamerze (patrz tekstowy odczyt na podglądzie kamery), nie
sztywne liczby z podręcznika. `warrior_2/front_knee_not_bent` mierzy tę nogę,
która akurat jest lepiej widoczna dla kamery, nie anatomicznie "przednią" —
w typowym ustawieniu bokiem do kamery obie bywają podobnie widoczne, więc
która noga faktycznie zostanie zmierzona może się różnić między sesjami.

Co trzeba dopiąć:
- Wciągnięcie pamięci usera (`memory.js`/`loadMemoryContext`) do promptu
  korekty/pochwały — np. nie dociskać korekty, jeśli user wcześniej zgłosił
  ból. Baza już istnieje, brakuje tylko podpięcia.
- Powrót `cat_cow` (albo kolejnych ćwiczeń) wymaga najpierw własnych reguł
  geometrycznych w `posture-rules.js` — samo dopisanie do `posture.js` nie
  wystarczy (auto-detekcja z rozmowy zadziała, ale reguły — nie).
- Źródło: `docs.liveavatar.com/docs/full-mode/events.md` (topic
  `agent-control`, komendy `avatar.speak_text` / `avatar.speak_response` /
  `avatar.interrupt`) — stary link z komentarza w `server.js`
  ("docs.liveavatar.com/docs/command-events") już nie istnieje, strona się przeniosła.
  Model MediaPipe: `developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker`.

**Korekta postawy działa też na LiveAvatar LITE mode** (patrz sekcja niżej),
nie tylko na FULL/Groq: LITE komunikuje się osobnym WebSocketem
(`docs.liveavatar.com/docs/lite-mode/events.md`), bez natywnego TTS po stronie
LiveAvatar — jedyna droga to gotowe audio PCM 16-bit/24kHz przez `agent.speak`.
`speakLiteCue()` w `server.js` generuje to audio przez ElevenLabs (ten sam
pipeline co zwykła rozmowa w `runLiteTurn`, tylko bez strumieniowania z Groq —
tekst korekty jest już gotowy) i wysyła je do `ws_url` tej sesji.
`/api/posture-correction`/`/api/posture-affirmation` przyjmują opcjonalny
`sessionId` — gdy pasuje do aktywnej sesji Lite, wygłaszają korektę tam,
zamiast (albo obok) zwrócenia samego tekstu do przeglądarki. `posture.js` i
`pose-detector.js` zostały bez zmian, zgodnie z założeniem.

Uwaga przy okazji: ten plik referencyjnie wspomina wyżej `node test-memory.js`
oraz migracje w `supabase/migrations/`, ale w tym repo `test-memory.js` w
ogóle nie istnieje (nigdy nie trafił do gita), a `supabase/` jest
gitignorowane — prawdopodobnie też zostały na innym komputerze.

## LiveAvatar Lite + ElevenLabs (własny STT/LLM/TTS)

Czwarty dostawca w dropdownie. W przeciwieństwie do pozostałych trzech (Full mode — LiveAvatar sam ogarnia LLM+TTS) tu LiveAvatar **tylko renderuje twarz**; STT, LLM i TTS są w całości po naszej stronie:

```
mikrofon (Web Speech API, pl-PL) --> Groq LLM (llama-3.3-70b, streaming)
  --> ElevenLabs TTS (streaming, PCM 24kHz, Twój sklonowany głos)
  --> ws_url LiveAvatar (agent.speak) --> twarz awatara
```

### Wymagania

- **Node 22+** do uruchomienia `server.js`, kiedy ten adapter ma działać — Lite łączy się z `ws_url` (LiveAvatar) i ze streamingiem ElevenLabs przez natywny, globalny `WebSocket`, którego Node 18 (dotychczasowe minimum tego projektu) nie ma. Pozostałe trzy adaptery nie używają WebSocket po stronie serwera i działają identycznie na 18 i 22 — podniesienie wymagania dotyczy praktycznie tylko tego, że to jeden proces. Najprościej przez [nvm](https://github.com/nvm-sh/nvm): `nvm install 22 && nvm use 22`.
- W `.env`, oprócz istniejących zmiennych: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (id Twojego sklonowanego głosu w ElevenLabs). Opcjonalnie `ELEVENLABS_MODEL_ID` (domyślnie `eleven_flash_v2_5` — model zoptymalizowany pod latencję, wspiera polski).
- Klucz ElevenLabs nigdy nie trafia do przeglądarki — całe wywołanie streamingu TTS dzieje się na serwerze, tak jak `GROQ_API_KEY` już wcześniej.

### Jak to działa

- Sesja startuje tak samo jak Full mode (`/sessions/token` z `mode:"LITE"` → `/sessions/start`), ale zamiast LiveKit data channel dostajemy dodatkowo `ws_url` — osobny WebSocket do sterowania awatarem (`agent.speak`, `agent.speak_end`, `agent.start_listening`/`agent.stop_listening`, `session.keep_alive`). Przeglądarka łączy się z LiveKit **tylko po wideo**, bez publikowania mikrofonu.
- Transkrypcję robi Web Speech API w przeglądarce (wybrane zamiast Groq Whisper — niższa latencja i prostszy kod, patrz komentarz przy adapterze w `public/index.html`); finalny tekst leci do `POST /api/lite-turn`.
- Backend strumieniuje odpowiedź Groq zdanie po zdaniu do ElevenLabs (`stream-input` WebSocket, `output_format=pcm_24000` — dokładnie format wymagany przez LiveAvatar Lite, zero resamplingu) i przekazuje przychodzące audio do `ws_url` w kawałkach (pierwszy ~600ms, kolejne ~1s), więc awatar zaczyna mówić, zanim LLM skończy całą odpowiedź.
- Postęp per ogniwo (STT gotowe / pierwszy token LLM / pierwszy chunk TTS / awatar zaczyna mówić) leci do przeglądarki przez `GET /api/lite-events` (Server-Sent Events) i loguje się tym samym formatem `LATENCJA ODPOWIEDZI: X ms`, co pozostałe adaptery — wyniki są bezpośrednio porównywalne.
- Session Recorder i pamięć (Supabase) działają przez ten sam mechanizm co pozostałe adaptery LiveAvatar — bez osobnej ścieżki: backend sam woła `recordLiveAvatarEvent()` dla `user.transcription`/`avatar.transcription` (ma ten tekst od razu, bez przekazywania przez przeglądarkę), a zamknięcie sesji robi ten sam upsert do `avatar_sessions` i tę samą ekstrakcję pamięci przez Groq.
- Zamykanie sesji Lite różni się od Full: dokumentacja HeyGena podaje `DELETE /v1/sessions`, co w testach zwracało 405. Działający sposób (zweryfikowany bezpośrednio) to `POST /v1/sessions/stop` z `Authorization: Bearer <session_token>` (nie `X-API-KEY` jak w Full mode) — tak zaimplementowano `endSession()` tego adaptera.
- Barge-in (przerywanie awatara w trakcie mówienia) działa: przeglądarka wykrywa nową mowę usera podczas `liteAvatarSpeaking` (z buforem ~600ms po starcie mówienia awatara, żeby resztkowy wynik rozpoznawania własnej, dopiero co wysłanej wypowiedzi nie przerywał sam siebie) i woła `POST /api/lite-interrupt`, który przerywa Groq (`AbortController`) oraz LiveAvatar (`agent.interrupt`). **Bez słuchawek** ten bufor sam w sobie nie wystarczał: głos awatara leciał z głośników z powrotem do mikrofonu, Web Speech API słyszało to jako "użytkownika" i po 600ms wciąż potrafiło przerwać resztę wypowiedzi jej własnym echem (a potem wysłać to jako user turn do Groq, który odpowiadał na coś zupełnie nie na temat). Dlatego doszła druga warstwa: `isLikelyEcho()` w `public/index.html` porównuje usłyszany tekst z tym, co avatar aktualnie mówi (`liteLastAvatarUtterance`, z SSE `avatar_transcription`) i ignoruje wynik, gdy pokrywa się w ≥60% słów — prawdziwe przerwanie (inne słowa niż avatar) nadal działa normalnie.
- Korekta/pochwała postawy (patrz sekcja "Sprint 2" wyżej) działa też tutaj: `speakLiteCue()` w `server.js` generuje audio przez ElevenLabs z gotowego tekstu (bez Groq) i wysyła je tym samym `ws_url` co zwykła rozmowa.

### Znane ograniczenia

- Web Speech API działa tylko w przeglądarkach opartych o Chromium (Chrome/Edge) — tak jak reszta aplikacji już zakłada dla WebRTC/LiveKit.
- Historia rozmowy trzymana w pamięci procesu (do 4 ostatnich wymian), nie w Supabase — ograniczenie kontekstu Groq w ramach jednej żywej sesji, niezależne od `user_memory`/`session_memory`.
