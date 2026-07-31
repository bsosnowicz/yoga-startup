# Audyt stanu repo — 2026-07-31 (po PR `61aa35e`)

Raport z czytania kodu (bez zmian w plikach źródłowych). Źródła:
[server.js](server.js), [memory.js](memory.js), [posture.js](posture.js),
[calibration.js](calibration.js), [public/pose-detector.js](public/pose-detector.js),
[public/posture-rules.js](public/posture-rules.js), [public/knn.js](public/knn.js),
[public/posture-state-machine.js](public/posture-state-machine.js),
[public/index.html](public/index.html).

Wszystkie stwierdzenia pochodzą z kodu, nie z README. Rozbieżności wobec README
są zebrane w osobnej sekcji na końcu.

---

## Co zmienił PR `61aa35e` — streszczenie

> `[new] live posture correction (rule engine + k-NN) and fix avatar
> self-interrupting in Lite mode` — +1127 / −125 linii, 10 plików.

| Obszar | Przed | Po |
| --- | --- | --- |
| Liczba pozycji z regułami | 2 (`child_pose`, `downward_dog`) | **3** (+ `warrior_2`) |
| Reguły geometryczne | 4 funkcje pisane „z ręki" | **6 reguł deklaratywnych** + generyczny silnik `evaluateRule` |
| k-NN | nie istniał | **jest** ([knn.js](public/knn.js)) — ale bez danych treningowych |
| Maszyna stanów ENTERING/IN_POSE/MISMATCH | nie istniała | **jest** ([posture-state-machine.js](public/posture-state-machine.js)) |
| Tryb kalibracyjny | nie istniał | **jest** (`?calibrate=1` + `calibration.js` + 2 endpointy) |
| Echo własnego głosu awatara (Lite) | przerywało awatara i szło do Groq | **naprawione** (`isLikelyEcho`) |
| Wygładzanie wartości kąta/ratio | brak | **okno 5 klatek** (`createValueSmoother`) |
| Próg widoczności | 0.5 | **0.6** |

**Nie zmieniło się nic** w obszarze pamięci/persystencji (A), plannera sesji (C)
ani filtrów kontuzji — te sekcje mają identyczne odpowiedzi co poprzednio.

---

## A. Pamięć i persystencja

> **Bez zmian względem poprzedniego audytu.** PR nie dotknął tego obszaru;
> zaktualizowane są tylko numery linii.

### 1. Transkrypty trybu „LiveAvatar Lite + ElevenLabs" — Supabase czy pamięć procesu?

**Trafiają do Supabase.** `liveavatarLiteEleven` jest w `LIVEAVATAR_PROVIDERS`
([server.js:89](server.js#L89)), a backend sam woła `recordLiveAvatarEvent()` dla
wypowiedzi usera ([server.js:992](server.js#L992)) i avatara
([server.js:1149](server.js#L1149) oraz [server.js:1290](server.js#L1290) dla
korekt postawy). Finalny upsert do `avatar_sessions` leci przez
`/api/session-end` → `persistRecordedSession()`
([server.js:1681-1688](server.js#L1681-L1688), [server.js:246](server.js#L246)).

> **Haczyk (nadal aktualny):** w Lite nie ma żadnej obsługi `session.stopped` —
> zapis następuje **wyłącznie** po kliknięciu Stop. Zamknięcie karty albo
> wygaszenie sesji po stronie LiveAvatar = rekord ginie w pamięci procesu.

### 2. Czy każdy z 5 adapterów zapisuje sesje tym samym kanałem?

**Nie — i nie tym samym kanałem.**

| Adapter | Zapisuje? | Kanał |
| --- | --- | --- |
| `anam` | **NIE** | brak `sessionId`, nie ma w `LIVEAVATAR_PROVIDERS`; `disconnect()` nie woła nawet `endServerSession` ([index.html:394-397](public/index.html#L394-L397)) |
| `liveavatar` (Full) | TAK | przeglądarka → `POST /api/session-record/event` ([index.html:462](public/index.html#L462), [467](public/index.html#L467), [485](public/index.html#L485)) |
| `liveavatarGroq` | TAK | ten sam kod co wyżej (deleguje `connect`) |
| `tavus` | **NIE** | woła `endServerSession("tavus", …)`, ale `LIVEAVATAR_PROVIDERS.has("tavus")` = false ([server.js:1680](server.js#L1680)) → recorder pomijany |
| `liveavatarLiteEleven` | TAK | **serwer sam** zapisuje eventy, bez rundy przez przeglądarkę |

### 3. Migracje SQL / schemat odtworzony z kodu

Katalog `supabase/` **nie istnieje w repo** (jest w [.gitignore](.gitignore#L2)).

**`avatar_sessions`** — upsert `on_conflict=session_id`
([server.js:197-207](server.js#L197-L207), [server.js:246](server.js#L246)):
`session_id`, `provider`, `user_id`, `started_at`, `ended_at`, `end_reason`,
`user_transcript` (jsonb `[{text,at}]`), `avatar_transcript` (jsonb),
`events` (jsonb `[{event_type,at,payload}]`).

**`user_memory`** — upsert `on_conflict=user_id,category,key`
([server.js:170-174](server.js#L170-L174)), odczyt
([server.js:134-135](server.js#L134-L135)):
`user_id`, `category`, `key`, `value`, `confidence`, `source_session_id`,
`updated_at`. Wymaga **UNIQUE(user_id, category, key)**.

**`session_memory`** — upsert `on_conflict=source_session_id,key`
([server.js:180-182](server.js#L180-L182)), odczyt
([server.js:136](server.js#L136)):
`user_id`, `category`, `key`, `value`, `source_session_id`, `confidence`,
`is_unfinished` (bool), `created_at`. Wymaga **UNIQUE(source_session_id, key)**.

> Dwie kolumny, o których README zapomina, a kod je wysyła przez `{...item}`:
> `user_memory.source_session_id` oraz `session_memory.category`.

**🆕 NOWE — drugi magazyn danych, poza Supabase:** PR dodał
`calibration/<poseId>.<variant>.json` na dysku serwera
([calibration.js:6-39](calibration.js#L6-L39)). To pliki JSON z surowymi
landmarkami, nie tabela — dane treningowe k-NN. Katalog jest gitignorowany
([.gitignore:3](.gitignore#L3)) i **nie istnieje**.

### 4. `test-memory.js`

**Nadal nie istnieje.** README wciąż każe go uruchomić (README:57), a
README:167-170 sam przyznaje, że go nie ma.

### 5. Czy pamięć jest wpięta również do promptu korekt postawy?

**Nie — tylko do głównego promptu rozmowy.** `buildCoachPrompt()` wołane jest
w dwóch miejscach: [server.js:592](server.js#L592) (`liveavatarGroq`) oraz
[server.js:788](server.js#L788) (Lite).

**🆕 Po PR jest już nie dwa, ale TRZY prompty postawy bez pamięci:**

| funkcja | linia | dostaje pamięć? |
| --- | --- | --- |
| `generateGroqCorrection` | [server.js:303](server.js#L303) | nie |
| `generateGroqAffirmation` | [server.js:330](server.js#L330) | nie |
| `generateGroqMismatchCue` 🆕 | [server.js:360](server.js#L360) | nie |

Wszystkie trzy dostają wyłącznie `POSTURE_COACH_STYLE_GUIDE`
([server.js:293](server.js#L293)) + etykiety — **zero kontekstu o kontuzjach**.
Dodatkowo `anam`, `liveavatar` (Full) i `tavus` w ogóle nie widzą pamięci.

---

## B. Korekta postawy

### 6. Pozycje z pełnymi regułami kątowymi — 🆕 z 2 na 3

**Trzy pozycje, po 2 reguły każda (razem 6)**
([posture-rules.js:28-127](public/posture-rules.js#L28-L127)):

| id pozycji | liczba reguł | reguły (typ, próg) |
| --- | --- | --- |
| `child_pose` | 2 | `arms_not_extended` (angle, min 140°), `hips_too_high` (ratio, max 0.2) |
| `downward_dog` | 2 | `shoulders_shrugged` (ratio, min 0.15), `heels_lifted` (ratio, max 0.25) |
| `warrior_2` 🆕 | 2 | `front_knee_not_bent` (angle, 80–120°), `arms_not_level` (ratio, −0.2…0.2) |

Pokrycie jest pełne (6/6) — [posture.js:18-55](posture.js#L18-L55) definiuje
dokładnie te same 6 odchyleń.

**Zmiana architektoniczna:** reguły przestały być funkcjami pisanymi „z ręki".
Teraz są **deklaratywnymi danymi** (`type`, `points`, `min`/`max`) w
`posture-rules.js`, a generyczny silnik `evaluateRule()`
([pose-detector.js:92-104](public/pose-detector.js#L92-L104)) je wykonuje.
Dodanie reguły = wpis w obiekcie, bez pisania kodu.

### 7. k-NN i maszyna stanów — 🆕 ISTNIEJĄ, ale bez danych

**Oba są zaimplementowane i wpięte w gorącą pętlę** — to główna zmiana PR-a.

- **k-NN:** [public/knn.js](public/knn.js) — `K = 5`,
  `CONFIDENCE_THRESHOLD = 0.6` ([knn.js:16-17](public/knn.js#L16-L17)), dystans
  = średni kwadrat błędu po znormalizowanych landmarkach, liczony tylko po
  punktach widocznych po obu stronach ([knn.js:95-106](public/knn.js#L95-L106)).
  Normalizacja (środek bioder → (0,0), skala = dystans biodra↔barki) jest
  współdzielona z zapisem kalibracji
  ([pose-detector.js:132-154](public/pose-detector.js#L132-L154)).
- **Maszyna stanów:** [public/posture-state-machine.js](public/posture-state-machine.js)
  — dokładnie stany `ENTERING` / `IN_POSE` / `MISMATCH`
  ([posture-state-machine.js:31-120](public/posture-state-machine.js#L31-L120)).
- **Wpięcie:** [index.html:1083-1121](public/index.html#L1083-L1121) — klasyfikacja
  co 12 klatek, `MISMATCH` blokuje korekty kątowe przez wczesny `return`
  ([index.html:1120](public/index.html#L1120)).

**Katalog `calibration/` NIE ISTNIEJE** (i jest gitignorowany,
[.gitignore:3](.gitignore#L3)). Wobec tego:

`GET /api/calibration` zwraca `[]` ([calibration.js:42](calibration.js#L42))
→ `loadTrainingData` ustawia `sampleCount = 0` → `isReady()` = false
([knn.js:74-76](public/knn.js#L74-L76)) → cały blok w
[index.html:1083](public/index.html#L1083) się nie wykonuje → maszyna stanów
zostaje na `ENTERING` i nikt nigdy nie woła `update()`.

✅ **Potwierdzam: przy pustym `calibration/` k-NN jest nieaktywny, a zachowanie
jest identyczne jak przed PR-em (czysta graceful degradation).** Reguły kątowe
działają normalnie, w logu leci `„k-NN: brak danych kalibracyjnych —
klasyfikacja pozycji wyłączona"` ([index.html:975](public/index.html#L975)).

Jedyna droga do danych: ręczne nagranie przez tryb `?calibrate=1` (5 s
odliczania + 10 s zbierania próbek, [index.html:1240-1250](public/index.html#L1240)).

### 8. Hardcode czy pliki?

**Nadal hardcode, ale rozdzielony na dwie warstwy** (nowość PR-a):

| co | gdzie | strona |
| --- | --- | --- |
| Lista pozycji, etykiety, keywordy, teksty fallback, `entryScript`, flaga `odpoczynkowa` | [posture.js:18-55](posture.js#L18-L55) | serwer |
| Reguły geometryczne: typ, indeksy landmarków, progi `min`/`max` | [posture-rules.js:28-127](public/posture-rules.js#L28-L127) | klient |
| Silnik liczący (bez wiedzy o jodze) | [pose-detector.js:92-104](public/pose-detector.js#L92-L104) | klient |

`HIGHLIGHT_INDICES` nie jest już utrzymywane ręcznie — wyprowadza się z `RULES`
([posture-rules.js:132](public/posture-rules.js#L132),
[pose-detector.js:111-118](public/pose-detector.js#L111-L118)).

**Jedyna rzecz ładowana z plików to dane kalibracyjne k-NN**
(`calibration/*.json` → `GET /api/calibration` →
[index.html:969-981](public/index.html#L969-L981)).

---

## C. Logika sesji

> **Bez zmian względem poprzedniego audytu.** PR nie dodał żadnej logiki
> planowania sesji.

### 9. Deterministyczny planner sesji

**Nie ma — ani linijki.** Cały dobór i kolejność asan siedzi w prozie promptu:
blok `[PERSONALITY]` w `TRAINER_SYSTEM_PROMPT`,
[server.js:274-279](server.js#L274-L279):

> „Na początku zapytaj, ile ma dziś czasu i jak ocenia swoją kondycję. Potem
> poprowadź go przez pozycję dziecka i psa z głową w dół (dokładnie tymi
> nazwami): powiedz jak wejść w pozycję, przypominaj o oddechu, po kilku
> oddechach powiedz jak wyjść."

Uwaga: prompt wymienia **2 pozycje**, a rejestr ma już **3** — `warrior_2`
nigdy nie zostanie zadany przez trenera, bo prompt o nim nie wie
(patrz sekcja „nie działa w praktyce").

Wariant `GROQ_TRAINER_PROMPT` ([server.js:29](server.js#L29)) nie wymienia nawet
nazw pozycji. W kodzie nie ma listy asan z czasami, timera etapu ani stanu
„która asana jest teraz" poza `activeExercise` wykrywanym **z transkrypcji**
([index.html:908-923](public/index.html#L908-L923)).

### 10. Scenariusz „muszę kończyć za X minut"

**Wyłącznie jedno zdanie w prompcie** — [server.js:279](server.js#L279)
(„jeśli mówi, że coś boli albo że musi kończyć, dostosuj się natychmiast").

Kod robi z tym tylko jedno, i to **po fakcie**: regex w
[memory.js:44-47](memory.js#L44-L47) wyłapuje „muszę kończyć / musimy przerwać /
mam telefon" i oznacza sesję `is_unfinished=true`. Żadnego skracania planu,
żadnego timera, żadnego odliczania.

### 11. Filtr wykluczający pozycje na podstawie kontuzji

**Twardego filtra nie ma nigdzie.** Kontuzja/ból jest ekstrahowana
([memory.js:40-43](memory.js#L40-L43), klucz `reported_discomfort`) i wstrzykiwana
**jako tekst** do promptu przez `buildCoachPrompt()`
([memory.js:83](memory.js#L83)) — czyli **prośba, nie ograniczenie**.
`EXERCISES` nie jest nigdzie filtrowane.

**🆕 Najbliżej „logiki bezpieczeństwa" jest flaga `odpoczynkowa: true`**
na `child_pose` ([posture.js:28](posture.js#L28)): gdy k-NN wykryje pozycję
odpoczynkową zamiast zadanej, komunikat **pyta o samopoczucie zamiast
komenderować powrotem** ([posture.js:92-95](posture.js#L92-L95),
[server.js:362-364](server.js#L362-L364)). To realna decyzja w kodzie (`if`,
nie prompt) — ale dotyczy **wykrytej pozycji**, nie zgłoszonych kontuzji.
Zabezpieczeniem promptowym pozostaje „Nigdy nie każ przeć przez ból"
([server.js:295-296](server.js#L295-L296)).

---

## D. Limity i konfiguracja

### 12. Limity zaszyte w kodzie

**Długość sesji:** **brak jakiegokolwiek limitu w kodzie**. Zewnętrznie:
`max_session_duration` = 120 s po stronie LiveAvatar (tylko komentarz,
[server.js:487](server.js#L487)), limit bezczynności 5 min odświeżany
keep-alive'em co 100 s ([server.js:881-883](server.js#L881-L883)).

**Historia rozmowy:** 4 **wiadomości** (nie wymiany) w Lite —
[server.js:1003](server.js#L1003); `max_tokens: 250`, `temperature: 0.35`
([server.js:1024-1025](server.js#L1024-L1025)).

**Pamięć:** 7 faktów profilu / 3 preferencje ([memory.js:3-4](memory.js#L3-L4),
[server.js:134-135](server.js#L134-L135)), 20 rekordów sesji
([server.js:136](server.js#L136)), `confidence` klamrowane do 0.7–1.0
([memory.js:11](memory.js#L11)), wartość faktu 500 znaków, transkrypt do
ekstrakcji 12 000 znaków ([memory.js:14](memory.js#L14), [66](memory.js#L66)).

**Cooldowny korekt:**

| co | sustain | cooldown | gdzie |
| --- | --- | --- | --- |
| korekta błędu | 1000 ms | 15 000 ms | [index.html:945](public/index.html#L945) |
| pochwała | 3500 ms | 25 000 ms | [index.html:949](public/index.html#L949) |
| komunikat ROZJAZD 🆕 | 5000 ms | 10 000 ms | [posture-state-machine.js:28-29](public/posture-state-machine.js#L28-L29) |

**🆕 Okna czasowe maszyny stanów** ([posture-state-machine.js:25-29](public/posture-state-machine.js#L25-L29)):

| stała | wartość | znaczenie |
| --- | --- | --- |
| `KNN_STABLE_ENTER_MS` | 2000 ms | stabilne wykrycie targetu → `IN_POSE` |
| `KNN_STABLE_EXIT_MS` | 3000 ms | utrata targetu → powrót do `ENTERING` (histereza) |
| `KNN_PATIENCE_MS` | 10 000 ms | cisza po zadaniu pozycji, zanim ROZJAZD w ogóle może wystrzelić |
| `KNN_STABLE_MISMATCH_MS` | 5000 ms | stabilne wykrycie innej pozycji → ROZJAZD |
| `MISMATCH_COOLDOWN_MS` | 10 000 ms | powtórka komunikatu ROZJAZD |

**🆕 Pozostałe nowe limity:**

- `KNN_CLASSIFY_EVERY_N_FRAMES = 12` (~2.5 klasyfikacji/s przy 30 fps) —
  [index.html:966](public/index.html#L966)
- `K = 5`, `CONFIDENCE_THRESHOLD = 0.6` — [knn.js:16-17](public/knn.js#L16-L17)
- okno wygładzania wartości kąta/ratio = **5 klatek** —
  [pose-detector.js:69](public/pose-detector.js#L69)
- kalibracja: 5 s odliczania + 10 s nagrywania —
  [index.html:1240-1250](public/index.html#L1240-L1250)
- próg echa własnego głosu awatara: **≥60% wspólnych słów**, min. 2 słowa —
  [index.html:217-225](public/index.html#L217-L225)

**Pozostałe (bez zmian):** grace period po zmianie ćwiczenia 4000 ms
([index.html:956](public/index.html#L956)), bufor anty-barge-in 600 ms
([index.html:805](public/index.html#L805)), watchdog Web Speech 8000 ms
([index.html:852](public/index.html#L852)), bufor transkrypcji 300 znaków
([index.html:913](public/index.html#L913)), watchdog tury 30 s
([server.js:983](server.js#L983)), oczekiwanie na `speak_ended` 20 s
([server.js:1168](server.js#L1168), [1298](server.js#L1298)), „cisza TTS" 2000 ms
([server.js:1082](server.js#L1082), [1273](server.js#L1273)), chunki PCM
0.25 s / 1 s ([server.js:921-922](server.js#L921-L922)), flush zdania po
60 znakach.

**Progi visibility:** `MIN_VISIBILITY` **podniesiony z 0.5 na 0.6** 🆕
([pose-detector.js:21](public/pose-detector.js#L21)). Ta sama stała rządzi teraz
trzema rzeczami: oceną reguł (`evaluateRule`), maską widoczności w normalizacji
k-NN ([pose-detector.js:151](public/pose-detector.js#L151)) i podsumowaniem
kalibracji ([pose-detector.js:183](public/pose-detector.js#L183)).

### 13. Zmienne środowiskowe

**Bez zmian** poza tym, że `LIVEAVATAR_SANDBOX` steruje teraz również wyborem
avatara w trybie Lite ([server.js:781-782](server.js#L781-L782)).

**Wymagane** (`requireEnv` rzuca wyjątek, ale tylko dla swojego adaptera):

| zmienna | dla kogo | w `.env`? |
| --- | --- | --- |
| `ANAM_API_KEY` | `anam` ([server.js:414](server.js#L414)) | **BRAK** |
| `LIVEAVATAR_API_KEY` | 3 adaptery LiveAvatar | jest |
| `TAVUS_API_KEY` | `tavus` ([server.js:713](server.js#L713)) | **BRAK** |
| `GROQ_API_KEY` | twardo dla `liveavatarGroq` i Lite ([server.js:584](server.js#L584), [777](server.js#L777)) | jest |
| `ELEVENLABS_API_KEY` | Lite ([server.js:775](server.js#L775)) | jest |
| `ELEVENLABS_VOICE_ID` | Lite ([server.js:776](server.js#L776)) | jest |

**Opcjonalne:** `SUPABASE_URL` + `SUPABASE_SECRET_KEY` (lub
`SUPABASE_SERVICE_ROLE_KEY`) — bez nich sesja działa, nic się nie zapisuje;
`MEMORY_USER_ID` (`"local-demo-user"`); `LIVEAVATAR_SANDBOX`;
`LIVEAVATAR_AVATAR_ID` / `LIVEAVATAR_VOICE_ID`; `LIVEAVATAR_VIDEO_QUALITY`
(`"medium"`); `GROQ_MODEL` (`llama-3.3-70b-versatile`); `ELEVENLABS_MODEL_ID`
(`eleven_flash_v2_5`).

Tryb kalibracyjny **nie ma** własnej zmiennej — włącza się query stringiem
`?calibrate=1` ([index.html:984](public/index.html#L984)), a serwer musiał
dostać obsługę `pathname` zamiast surowego `req.url`, żeby `/?calibrate=1` nie
dawało 404 ([server.js:1709-1715](server.js#L1709-L1715)).

---

## E. Dla designu

### 14. Element wideo awatara

**Bez zmian.** Wszystkie 5 adapterów dzieli JEDEN element —
`<video id="persona-video">` ([index.html:27](public/index.html#L27)); każdy
`connect()` dostaje ten sam string `"persona-video"`
([index.html:1287](public/index.html#L1287)).

Styl wspólny, **bez narzuconych proporcji**:
`width: 100%; max-width: 480px; border-radius: 12px; background: #000`
([index.html:10](public/index.html#L10)). Wysokość wynika z natywnego aspektu
streamu, więc layout „skacze" przy starcie i różni się między dostawcami — brak
rezerwacji miejsca (`aspect-ratio` / placeholdera).

### 15. Podgląd kamery użytkownika z canvasem szkieletu

**Bez zmian w wymiarach.** Kontener `#camera-wrap`
([index.html:47](public/index.html#L47)): `width: 480px; max-width: 100%`,
`position: relative`, czarne tło, `border-radius: 12px`, lustrzany przez
`transform: scaleX(-1)`. W środku `<video id="user-camera">` (100% szerokości,
`height: auto`) i `<canvas id="pose-canvas">` rozciągnięty absolutnie na
100%×100% CSS-owo, z bitmapą w natywnej rozdzielczości klatki
([index.html:1043-1044](public/index.html#L1043-L1044)).

**🆕 Zmiana w layoucie:** pod `<fieldset>` korekty postawy doszedł drugi,
domyślnie ukryty `<fieldset id="calibration-panel">`
([index.html:56-76](public/index.html#L56-L76)) — pokazywany tylko przy
`?calibrate=1`. Zawiera dropdown pozycji, pola „nowa pozycja", radio
pełna/złagodzona, przycisk Nagraj, status i `<pre>` z podsumowaniem kątów.

**🆕 Canvas ma teraz dwie warstwy tekstu:** linia k-NN ze stanem maszyny
(kolor czerwony `#ff3b30` przy `MISMATCH`, zielony poza tym) rysowana jako
pierwsza ([index.html:1104-1115](public/index.html#L1104-L1115)), a pod nią
odczyty reguł, przesunięte o 18 px.

### 16. Stany UI rozróżniane przez kod

**🆕 Pierwszy realny stan aplikacji z nazwami z kodu** — wcześniej wszystko było
tekstem w logu. `postureStateMachine.getState()` zwraca `ENTERING` / `IN_POSE` /
`MISMATCH` i ten string jest **rysowany na canvasie kamery**
([index.html:1104-1114](public/index.html#L1104-L1114)) wraz z etykietą k-NN
i confidence. Nadal nie jest to jednak stan całego UI, tylko napis na podglądzie.

**Realnie widoczne w UI:**

- `#audio-unlock-btn` — żółty przycisk „Nie słychać avatara?"
  ([index.html:28](public/index.html#L28), [111-123](public/index.html#L111-L123))
- `#active-exercise-status` — „Wykryte ćwiczenie: X" / „brak"
  ([index.html:44](public/index.html#L44), [918](public/index.html#L918))
- `#pose-camera-toggle` — „Włącz / Wyłącz kamerę i auto-korektę"
  ([index.html:1150](public/index.html#L1150), [1169](public/index.html#L1169))
- `startBtn.disabled` / `stopBtn.disabled` / `providerSelect.disabled`
- napis „czekam na przydzielenie ćwiczenia w rozmowie…"
  ([index.html:1068](public/index.html#L1068))
- 🆕 `k-NN [STAN]: <pozycja> (<confidence>)` na canvasie
- 🆕 `#calibration-status` — „Przygotuj się… (5s)" / „Nagrywam… 10s." /
  „Zapisuję…" / „Zapisano (N klatek)" / „BŁĄD zapisu"
  ([index.html:1240-1272](public/index.html#L1240-L1272))
- 🆕 `#calibration-summary` — `<pre>` z min/max/mean/stddev kątów
- 3 panele tekstowe: `#log`, `#provider-output`, `#database-log`

**Rozróżniane, ale wyłącznie jako tekst w logu:**

- kamera / uprawnienia — `describeCameraError()`: `NotAllowedError` /
  `PermissionDeniedError`, `NotFoundError`, `NotReadableError` /
  `TrackStartError`, `OverconstrainedError`
  ([index.html:1058-1068](public/index.html#L1058-L1068) → funkcja przy
  [index.html:1000](public/index.html#L1000))
- pipeline Lite (SSE): `stt_ready`, `llm_first_token`, `tts_first_chunk`,
  `audio_sent_to_avatar`, `avatar_speak_started`, `avatar_speak_ended`,
  `interrupted`, `error`, `avatar_transcription`
  ([index.html:715-750](public/index.html#L715-L750))
- Full mode (LiveKit): `user.speak_started`, `user.speak_ended`,
  `avatar.speak_started`, `avatar.speak_ended`, `session.stopped`
- 🆕 `„(Zignorowano echo własnego głosu awatara w mikrofonie.)"`
  ([index.html:791](public/index.html#L791))
- 🆕 `„Maszyna stanów: ROZJAZD — zadana X, wykryta Y"`
  ([index.html:1093](public/index.html#L1093))
- 🆕 `„k-NN: brak danych kalibracyjnych — klasyfikacja pozycji wyłączona"`
  ([index.html:975](public/index.html#L975))
- ostrzeżenie o braku wsparcia Web Speech API po 8 s ciszy

**Czego NIE ma wcale (bez zmian):** stanu „łączenie", widocznego wskaźnika
„mówi / słucha" (`liteAvatarSpeaking` to wewnętrzny bool,
[index.html:197](public/index.html#L197)), stanu odmowy mikrofonu dla Full mode,
**jakiegokolwiek stanu „koniec limitu"** — 120-sekundowy cutoff LiveAvatar nadal
nie ma obsługi.

---

## Rozbieżności README vs kod

### 🆕 Nowe po tym PR

1. **README w ogóle nie dokumentuje głównej funkcji PR-a.** Grep po README nie
   znajduje ani jednego wystąpienia słów `k-NN`, `knn`, `kalibracja` (w sensie
   trybu), `calibrate`, `MISMATCH`, `maszyna stanów`. Nieudokumentowane
   zostały: [knn.js](public/knn.js),
   [posture-state-machine.js](public/posture-state-machine.js),
   [calibration.js](calibration.js), tryb `?calibrate=1`, endpointy
   `GET/POST /api/calibration` ([server.js:1416](server.js#L1416),
   [1430](server.js#L1430)) i `POST /api/posture-mismatch`
   ([server.js:1597](server.js#L1597)).
2. **README opisuje 6 reguł jako „w `posture-rules.js`"** i to się zgadza, ale
   komentarz w kodzie [pose-detector.js:5](public/pose-detector.js#L5) twierdzi
   „**6 z 8** odchyleń z posture.js ma tu regułę" — `posture.js` ma **6**
   odchyleń, nie 8. Stale komentarz (poprzednio było „4 z 6").
3. **Prompt trenera nie wie o `warrior_2`** — `TRAINER_SYSTEM_PROMPT`
   ([server.js:275-277](server.js#L275-L277)) wymienia tylko dwie pozycje,
   a README ogłasza, że system działa „dla **3 ćwiczeń**" (README:64).

### Nadal aktualne z poprzedniego audytu

4. **`node test-memory.js`** (README:57) — pliku nie ma.
5. **Linki do `supabase/migrations/*.sql`** (README:46, 48) — katalogu nie ma.
6. **SQL dla `avatar_sessions` w README** nie zawiera `user_id`, a kod tę
   kolumnę wysyła ([server.js:200](server.js#L200)).
7. **README: „pierwszy chunk ~600ms"** — kod używa **0.25 s**
   ([server.js:921](server.js#L921)).
8. **README: „do 4 ostatnich wymian"** — kod trzyma 4 **wiadomości**
   ([server.js:1003](server.js#L1003)), czyli realnie 2 wymiany.
9. **README opisuje pamięć jako mechanizm ogólny** — działa tylko dla
   `liveavatarGroq` i Lite.

---

## Rzeczy, które są w kodzie, ale nie działają w praktyce

### 🆕 Nowe po tym PR

1. **Cały tor k-NN + maszyna stanów jest martwy — brak danych wejściowych.**
   To podręcznikowy przypadek „funkcja zaimplementowana, ale bez danych":
   ~260 linii nowego kodu ([knn.js](public/knn.js),
   [posture-state-machine.js](public/posture-state-machine.js)) nie wykona się
   ani razu, dopóki ktoś ręcznie nie nagra pozycji przez `?calibrate=1`.
   Katalog `calibration/` nie istnieje i jest gitignorowany, więc **nie
   przeniesie się też na inną maszynę ani na produkcję**. Degradacja jest
   czysta i zamierzona ([index.html:1083](public/index.html#L1083)) — ale efekt
   netto dziś to zero działania.
2. **Pułapka: `MISMATCH` potrafi trwale wyłączyć korekty kątowe.** Jedyne
   wyjście ze stanu `MISMATCH` to stabilne (2 s) rozpoznanie **zadanej** pozycji
   ([posture-state-machine.js:70-96](public/posture-state-machine.js#L70-L96)).
   Gdy user wstanie / zrobi coś nierozpoznanego, `label` = null → warunek wyjścia
   nigdy nie spełniony → stan zostaje `MISMATCH` → gate
   [index.html:1120](public/index.html#L1120) blokuje **wszystkie** korekty
   i pochwały bezterminowo.
3. **Częściowa kalibracja jest gorsza niż żadna.** Przy jednej skalibrowanej
   klasie k-NN nie potrafi zwrócić „nieznana": wszystkie 5 sąsiadów należy do tej
   klasy, więc `confidence` = 1.0 ≥ 0.6
   ([knn.js:119-137](public/knn.js#L119-L137)). Jeśli zadana pozycja **nie jest**
   skalibrowana, po ~15 s (patience 10 s + stabilność 5 s) wystrzeli fałszywy
   ROZJAZD, a potem zadziała pułapka z punktu 2.
4. **`warrior_2/front_knee_not_bent` mierzy losową nogę.** `pickVisibleSide`
   wybiera stronę po widoczności, nie po tym, która noga jest anatomicznie
   przednia — przy ustawieniu bokiem do kamery obie bywają podobnie widoczne
   ([posture-rules.js:92-99](public/posture-rules.js#L92-L99), świadomie
   udokumentowane w kodzie).
5. **`warrior_2` nigdy nie zostanie zadany przez trenera** — prompt wymienia
   tylko pozycję dziecka i psa z głową w dół
   ([server.js:275-277](server.js#L275-L277)). Reguły, keywordy i `entryScript`
   dla Wojownika II istnieją, ale rozmowa do nich nie doprowadzi bez ręcznej
   zmiany promptu.
6. **`POST /api/calibration` nie ma żadnej autoryzacji ani limitu rozmiaru**
   ([server.js:1430](server.js#L1430)) — każdy, kto dosięgnie serwera, zapisze
   pliki na dysku. `safeSegment` chroni przed path traversal
   ([calibration.js:11-13](calibration.js#L11-L13)), ale `readJsonBody` przyjmie
   dowolnie duże body.

### Nadal aktualne z poprzedniego audytu

7. **`detectActiveExercise()` nie potrafi przełączyć się na kolejną pozycję** —
   `find()` przechodzi rejestr w kolejności, więc gdy w 300-znakowym buforze
   siedzą keywordy kilku ćwiczeń, zawsze wygrywa pierwsze
   ([index.html:914](public/index.html#L914)). **Po PR jest gorzej**: pozycji
   jest 3, a `child_pose` stoi pierwszy w rejestrze
   ([posture.js:19](posture.js#L19)) — więc raz wypowiedziana „pozycja dziecka"
   blokuje i psa, i Wojownika, aż wypadnie z okna bufora.
8. **Pamięć nie dojeżdża do 3 z 5 adapterów** (`anam`, `liveavatar`, `tavus`).
9. **Session Recorder nie zbiera nic dla `anam` i `tavus`** — pętla
   „zapamiętaj → wykorzystaj" jest dla nich przerwana.
10. **`is_unfinished` nigdy nie wraca na `false`** — raz przerwana sesja dokleja
    się do promptu w nieskończoność ([memory.js:75](memory.js#L75)).
11. **`deviations` z `GET /api/posture-cues` to nadal martwe dane** — panel
    kalibracyjny (jedyny nowy konsument `postureExercises`) używa wyłącznie
    `key` i `label` ([index.html:1200-1206](public/index.html#L1200-L1206)).
12. **Lite gubi całą sesję, jeśli user nie kliknie Stop.**
13. **Cichy zabójca zapisu pamięci:** brak kolumn
    `user_memory.source_session_id` / `session_memory.category` → PostgREST
    odrzuca upsert, a `catch` ([server.js:186-189](server.js#L186-L189)) tylko
    loguje ostrzeżenie.
14. **Fallbackowe teksty w `posture.js`** są nieosiągalne dopóki Groq odpowiada.
