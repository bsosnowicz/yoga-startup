# LiveAvatar FULL — Session Recorder

Uruchom serwer Node 18+:

```bash
cp .env.example .env
# uzupełnij LIVEAVATAR_API_KEY oraz dane Supabase
node server.js
```

W aplikacji wybierz **HeyGen LiveAvatar (Full mode)**. Serwer tworzy rekord sesji zaraz po jej uruchomieniu. Przeglądarka odbiera eventy LiveKit i przekazuje tylko finalne `user.transcription`, `avatar.transcription` oraz `session.stopped`. Przy `session.stopped` albo kliknięciu Stop serwer robi jeden upsert kompletnej sesji do `avatar_sessions`.

Sekretny klucz Supabase zostaje wyłącznie na serwerze. Jeśli zmienne Supabase nie są ustawione, rozmowa nadal działa, ale serwer wyraźnie zaloguje, że sesja nie została utrwalona.

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
