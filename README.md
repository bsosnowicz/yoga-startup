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

## Rejestr asan — `asany/*.json`

Definicje pozycji (treść, warstwa metodyczna, progi detekcji) są **danymi, nie
kodem**: jeden plik `asany/<id>.json` na pozycję, wczytywany przy starcie przez
[asany.js](asany.js). Powód jest organizacyjny: RFP rozdziela role — warstwę
metodyczną (dobór asan, sekwencjonowanie, wykluczenia zdrowotne) dostarcza
Zamawiający, implementację Wykonawca. Wcześniej lista asan siedziała w prozie
`TRAINER_SYSTEM_PROMPT`, metadane w `posture.js`, a progi w
`public/posture-rules.js` — metodyk nie miał czego dostarczyć. JSON, nie YAML,
bo projekt świadomie nie ma żadnej zależności npm.

Kto z tego czyta:
- `TRAINER_SYSTEM_PROMPT` (`server.js`) — sekcja `[ASANY]` jest **generowana**
  przez `asanyDoPromptu()`, nie wpisana ręcznie (to naprawiło przy okazji
  usterkę: `warrior_2` miał komplet reguł i słów kluczowych, ale trener nigdy
  go nie zadawał, bo prompt o nim nie wiedział);
- `posture.js` — teksty korekt/pochwał/rozjazdu pozycji (`buildPostureCue` itd.);
- `GET /api/posture-cues` — słowa kluczowe do auto-detekcji ćwiczenia z rozmowy;
- `GET /api/asany/detekcja` — same reguły geometryczne dla przeglądarki
  (front-end nie czyta dysku), konsumowane przez `public/posture-rules.js`.

Dodanie pozycji = dodanie pliku + restart serwera. Żadnej zmiany w kodzie.

### Schemat pliku

| pole | typ | wym. | znaczenie |
| --- | --- | --- | --- |
| `id` | string | tak | identyfikator ASCII; **musi** równać się nazwie pliku (po tym samym id nazywane są nagrania kalibracyjne k-NN w `calibration/`) |
| `nazwa` | string | tak | nazwa po polsku — tą nazwą mówi trener i po niej user rozpoznaje pozycję |
| `sanskryt` | string | nie | nazwa sanskrycka, trafia do promptu w nawiasie |
| `typ` | enum | tak | `rozciaganie`, `wzmacniajaca`, `rownowaga`, `relaksacyjna`, `oddechowa` |
| `poziom_min` | enum | tak | minimalna kondycja użytkownika: `niska`, `srednia`, `wysoka` |
| `odpoczynkowa` | bool | tak | pozycja regeneracyjna — przy rozjeździe pozycji trener pyta o samopoczucie zamiast kazać wracać |
| `slowa_kluczowe` | string[] | tak | frazy (małymi literami) do wykrycia pozycji z transkrypcji rozmowy; puste = pozycja nigdy nie zostanie wykryta |
| `obciaza` | BODY_PARTS[] | tak | partie ciała, które pozycja realnie obciąża — może być `[]` |
| `przeciwwskazania_twarde` | BODY_PARTS[] | tak | aktywna kontuzja tej partii = **nie proponować** pozycji |
| `przeciwwskazania_miekkie` | BODY_PARTS[] | tak | kontuzja tej partii = proponować tylko wariant `modyfikacja_lagodna` / z ostrzeżeniem |
| `czasy_trzymania_oddechy` | obiekt | tak | liczba oddechów w trzymaniu per poziom: `{ "niska": n, "srednia": n, "wysoka": n }`, dodatnie liczby całkowite |
| `skrypty.wejscie` | string | tak | jak wejść w pozycję (używa tego też komunikat o rozjeździe pozycji) |
| `skrypty.trzymanie` / `.wyjscie` / `.modyfikacja_lagodna` | string | nie | co mówić w trzymaniu / jak wyjść / wariant łagodniejszy |
| `detekcja` | obiekt | nie | brak sekcji = pozycja działa w rozmowie, ale bez korekty z kamery |
| `detekcja.aktywna` | bool | tak\* | wyłącznik reguł bez kasowania ich z pliku |
| `detekcja.reguly[]` | tablica | tak\* | reguły geometryczne, patrz niżej |

`BODY_PARTS[]` to **ten sam enum**, którym pamięć taguje kontuzje użytkownika
(`memory-schema.js`) — `shoulder_left`, `wrist_right`, `lower_back`, … Pozycja
obciążająca symetrycznie wymienia obie strony. Dzięki wspólnemu enumowi przyszły
filtr kontuzji porówna identyfikator z identyfikatorem, bez tłumaczenia jednej
listy na drugą. Wartość spoza enuma = plik odrzucony z komunikatem w logu.

Pola reguły w `detekcja.reguly[]` — **`id`, `etykieta`, `korekta` po polsku
(treść dla metodyka), reszta po angielsku 1:1** (to kontrakt z `evaluateRule()`
w `public/pose-detector.js`, który dostaje regułę bez tłumaczenia):

| pole | typ | wym. | znaczenie |
| --- | --- | --- | --- |
| `id` | string | tak | identyfikator odchylenia, np. `heels_lifted`; unikalny w obrębie pozycji |
| `etykieta` | string | tak | nazwa błędu po polsku — karmi Groqa przy generowaniu korekty |
| `korekta` | string | nie | **fallback** wypowiedzi, gdy Groq zawiedzie; bez niego składane jest zdanie z `etykieta` |
| `type` | `"angle"` \| `"ratio"` | tak | kąt w stopniach albo znormalizowany stosunek |
| `label` | string | tak | podpis odczytu na podglądzie kamery, np. `kąt łokcia` |
| `points.left` / `.right` | int[] | tak | indeksy landmarków MediaPipe (0–32), obie strony tej samej długości; `angle` wymaga dokładnie 3 punktów `[A, B, C]` (kąt w `B`) |
| `numerator` / `denominator` | [int, int] | ratio | indeksy **w tablicy `points`**, nie surowe landmarki |
| `min` / `max` | number | ≥1 z nich | zdrowy zakres; reguła jest aktywna (błąd), gdy wartość wyjdzie poza `[min, max]` |

Walidacja przy starcie zgłasza **wszystkie** błędy pliku naraz i pomija tylko ten
plik — literówka metodyka nie kładzie serwera (ten sam kontrakt co
`loadAllCalibrations` w `calibration.js`):

```
Asany: pomijam zla_partia.json — 3 błąd(ów) walidacji:
  - pole "obciaza": "shoulder" nie jest partią ciała z enuma BODY_PARTS (memory-schema.js)
  - pole "przeciwwskazania_twarde": "prawy nadgarstek" nie jest partią ciała z enuma BODY_PARTS (memory-schema.js)
  - detekcja.reguly[0]: indeks landmarku 99 jest spoza zakresu 0-32
Asany: wczytano 3 z 5 plików (child_pose, downward_dog, warrior_2).
```

**Wartości metodyczne w trzech obecnych plikach są robocze** (wypełnione przez
Wykonawcę, do zatwierdzenia przez metodyka): `typ`, `poziom_min`, `obciaza`,
oba rodzaje przeciwwskazań, `czasy_trzymania_oddechy` oraz skrypty
`trzymanie`/`wyjscie`/`modyfikacja_lagodna`. Przeniesione 1:1 ze starego kodu
(bez zmiany wartości) są: `nazwa`, `slowa_kluczowe`, `odpoczynkowa`,
`skrypty.wejscie` i cała sekcja `detekcja`.

## Sprint 2 — korekta postawy (live)

"Czytaj ruch na żywo → wygeneruj korektę (albo pochwałę) dla bieżącego
ćwiczenia → niech awatar to od razu powie" — działa dziś w pełni automatycznie
dla **3 ćwiczeń** (`child_pose`, `downward_dog`, `warrior_2` — jedyne z pełnym
pokryciem regułami geometrycznymi). To namiastka biomechaniki ("kilka grubych
błędów"), nie pełny system.

Co działa już teraz:
- [posture.js](posture.js) — buduje teksty (`buildPostureCue`,
  `buildPostureAffirmation`, `listExerciseCues`, `buildPostureMismatchCue`) nad
  rejestrem asan; **sam nie zna żadnej pozycji** — dane bierze z `asany/*.json`
  (patrz sekcja "Rejestr asan" wyżej). `korekta` w regule to **fallback**, nie
  główne źródło wypowiedzi (patrz niżej). `slowa_kluczowe` per pozycja służą do
  wykrycia z transkrypcji rozmowy, które ćwiczenie trwa.
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
- [public/posture-rules.js](public/posture-rules.js) — klient
  `GET /api/asany/detekcja` i cache reguł na czas życia karty (`loadPostureRules`,
  `rulesFor`, `highlightIndicesFor`). Same dane 6 reguł geometrycznych (typ
  `angle` albo `ratio`, indeksy landmarków, progi `min`/`max`) mieszkają w sekcji
  `detekcja` plików `asany/*.json`, oddzielone od silnika w `pose-detector.js`:
  `child_pose/arms_not_extended`
  (kąt w łokciu), `child_pose/hips_too_high` (biodro vs kolano),
  `downward_dog/shoulders_shrugged` (ucho vs ramię), `downward_dog/heels_lifted`
  (pięta vs czubek stopy), `warrior_2/front_knee_not_bent` (kąt przedniego
  kolana), `warrior_2/arms_not_level` (nadgarstek vs linia barków). Reguły typu
  `ratio` liczą znormalizowany stosunek do długości odpowiedniego segmentu
  ciała — celowy wybór (patrz komentarz przy `heels_lifted` w kodzie), nie
  uproszczenie tymczasowe.
- **Ćwiczenie wykrywane jest automatycznie z rozmowy**, nie ręcznie: w
  [public/index.html](public/index.html) `detectActiveExercise()` dopasowuje
  `slowa_kluczowe` z `asany/*.json` do transkrypcji zarówno usera, jak i avatara
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

**Progi w sekcji `detekcja` plików `asany/*.json` to wstępne zgadywanie** (140° dla łokcia, 0.15
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
- Powrót `cat_cow` (albo kolejnych ćwiczeń) to dziś dodanie pliku
  `asany/<id>.json` — trener i auto-detekcja podłapią pozycję od razu, ale
  korekta z kamery zadziała dopiero, gdy plik dostanie własną sekcję `detekcja`
  (dla `cat_cow` to wciąż otwarty problem: MediaPipe nie daje landmarków na
  kręgosłup, więc nie ma z czego policzyć krzywizny).
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
- Punkt startowy tego pomiaru jest jawnie oznaczony w logu: `(od ciszy)` = od `onspeechend` Web Speech API, czyli odpowiednik `user.speak_ended` u pozostałych dostawców (porównywalne); `(od gotowego tekstu, bez narzutu STT)` = Chrome nie dał dla tej wypowiedzi sygnału ciszy, więc liczymy od finalnego transkryptu i wynik jest **zaniżony** o narzut STT. Znacznik ciszy jest ważny tylko dla wypowiedzi, na której finalny transkrypt aktualnie czekamy — Chrome odpala `speechend` również po `stop()` i po echu głosu awatara, a taki osierocony znacznik przeciekał wcześniej do następnej sesji i dawał w logu latencje rzędu minut.
- Session Recorder i pamięć (Supabase) działają przez ten sam mechanizm co pozostałe adaptery LiveAvatar — bez osobnej ścieżki: backend sam woła `recordLiveAvatarEvent()` dla `user.transcription`/`avatar.transcription` (ma ten tekst od razu, bez przekazywania przez przeglądarkę), a zamknięcie sesji robi ten sam upsert do `avatar_sessions` i tę samą ekstrakcję pamięci przez Groq.
- Zamykanie sesji Lite różni się od Full: dokumentacja HeyGena podaje `DELETE /v1/sessions`, co w testach zwracało 405. Działający sposób (zweryfikowany bezpośrednio) to `POST /v1/sessions/stop` z `Authorization: Bearer <session_token>` (nie `X-API-KEY` jak w Full mode) — tak zaimplementowano `endSession()` tego adaptera.
- Barge-in (przerywanie awatara w trakcie mówienia) działa: przeglądarka wykrywa nową mowę usera podczas `liteAvatarSpeaking` (z buforem ~600ms po starcie mówienia awatara, żeby resztkowy wynik rozpoznawania własnej, dopiero co wysłanej wypowiedzi nie przerywał sam siebie) i woła `POST /api/lite-interrupt`, który przerywa Groq (`AbortController`) oraz LiveAvatar (`agent.interrupt`). **Bez słuchawek** ten bufor sam w sobie nie wystarczał: głos awatara leciał z głośników z powrotem do mikrofonu, Web Speech API słyszało to jako "użytkownika" i po 600ms wciąż potrafiło przerwać resztę wypowiedzi jej własnym echem (a potem wysłać to jako user turn do Groq, który odpowiadał na coś zupełnie nie na temat). Dlatego doszła druga warstwa: `isLikelyEcho()` w `public/index.html` porównuje usłyszany tekst z tym, co avatar aktualnie mówi (`liteLastAvatarUtterance`, z SSE `avatar_transcription`) i ignoruje wynik, gdy pokrywa się w ≥60% słów — prawdziwe przerwanie (inne słowa niż avatar) nadal działa normalnie.
- Korekta/pochwała postawy (patrz sekcja "Sprint 2" wyżej) działa też tutaj: `speakLiteCue()` w `server.js` generuje audio przez ElevenLabs z gotowego tekstu (bez Groq) i wysyła je tym samym `ws_url` co zwykła rozmowa.

### Znane ograniczenia

- Web Speech API działa tylko w przeglądarkach opartych o Chromium (Chrome/Edge) — tak jak reszta aplikacji już zakłada dla WebRTC/LiveKit.
- Historia rozmowy trzymana w pamięci procesu (do 4 ostatnich wymian), nie w Supabase — ograniczenie kontekstu Groq w ramach jednej żywej sesji, niezależne od `user_memory`/`session_memory`.
