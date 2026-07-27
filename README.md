# LiveAvatar FULL — Session Recorder

Uruchom serwer Node 18+:

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
dla **2 ćwiczeń** (`child_pose`, `downward_dog` — jedyne z pełnym pokryciem
regułami geometrycznymi). To namiastka biomechaniki ("kilka grubych błędów"),
nie pełny system.

Co działa już teraz:
- [posture.js](posture.js) — rejestr 2 ćwiczeń/odchyleń (`buildPostureCue`,
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
  (model `lite`, w 100% w przeglądarce, bez konta/klucza) + 4 reguły
  geometryczne: `child_pose/arms_not_extended` (kąt w łokciu),
  `child_pose/hips_too_high` (biodro vs kolano), `downward_dog/shoulders_shrugged`
  (ucho vs ramię), `downward_dog/heels_lifted` (pięta vs czubek stopy) — wszystkie
  jako stosunek do długości odpowiedniego segmentu ciała.
- **Ćwiczenie wykrywane jest automatycznie z rozmowy**, nie ręcznie: w
  [public/index.html](public/index.html) `detectActiveExercise()` dopasowuje
  `keywords` z `posture.js` do transkrypcji zarówno usera, jak i avatara
  (`user.transcription` / `avatar.transcription`) — proste dopasowanie
  słów kluczowych, nie wywołanie LLM-a (przy tylko 2 wyraźnie odrębnych
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

**Progi w `pose-detector.js` to wstępne zgadywanie** (140° dla łokcia, 0.15
ucho/tułów, 0.2 biodro/kolano, 0.25 pięta/czubek stopy) — do skalibrowania
patrząc na realne nagranie testera w kamerze (patrz tekstowy odczyt na
podglądzie kamery), nie sztywne liczby z podręcznika.

Co trzeba dopiąć, przenosząc pracę z drugiego komputera (LiveAvatar + Groq +
Supabase + głos ElevenLabs):
- Wciągnięcie pamięci usera (`memory.js`/`loadMemoryContext`) do promptu
  korekty/pochwały — np. nie dociskać korekty, jeśli user wcześniej zgłosił
  ból. Baza już istnieje, brakuje tylko podpięcia.
- Jeśli tamta integracja to faktycznie LiveAvatar **LITE mode** (BYO
  ASR/TTS/wideo), a nie FULL + Custom TTS — LITE komunikuje się osobnym
  WebSocketem (`docs.liveavatar.com/docs/lite-mode/events.md`), nie tym samym
  kanałem LiveKit co FULL. Wtedy trzeba dopisać wariant wysyłki po
  WebSocket; `posture.js`, `pose-detector.js` i endpointy zostają bez zmian.
- Powrót `cat_cow` (albo kolejnych ćwiczeń) wymaga najpierw własnych reguł
  geometrycznych w `pose-detector.js` — samo dopisanie do `posture.js` nie
  wystarczy (auto-detekcja z rozmowy zadziała, ale reguły — nie).
- Źródło: `docs.liveavatar.com/docs/full-mode/events.md` (topic
  `agent-control`, komendy `avatar.speak_text` / `avatar.speak_response` /
  `avatar.interrupt`) — stary link z komentarza w `server.js`
  ("docs.liveavatar.com/docs/command-events") już nie istnieje, strona się przeniosła.
  Model MediaPipe: `developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker`.

Uwaga przy okazji: ten plik referencyjnie wspomina wyżej `node test-memory.js`
oraz migracje w `supabase/migrations/`, ale w tym repo `test-memory.js` w
ogóle nie istnieje (nigdy nie trafił do gita), a `supabase/` jest
gitignorowane — prawdopodobnie też zostały na innym komputerze.
