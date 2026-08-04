// Reguły geometryczne — CO mierzymy i jakie są progi (wiedza domenowa o
// jodze) — NIE są już wpisane w tym pliku. Ich źródłem jest sekcja "detekcja"
// w asany/<id>.json (patrz asany.js), serwowana przeglądarce przez
// GET /api/asany/detekcja: front-end nie czyta dysku, a metodyk ma progi w tym
// samym pliku co treść pozycji. Ten moduł jest teraz tylko klientem tego
// endpointu i cache'em na czas życia karty.
//
// JAK mierzyć (silnik: computeAngle, computeRatio, evaluateRule, wygładzanie,
// wybór widocznej strony) nadal żyje w pose-detector.js, który nie wie nic o
// jodze — ta sama granica co między server.js (logika) a posture.js (teksty).
//
// Kształt reguły (walidowany po stronie serwera przez asany.js, tu przyjmowany
// bez tłumaczenia — dlatego pola zostały po angielsku 1:1):
//   type: "angle" | "ratio"
//   label: tekst do podglądu na żywo (odczyt kąta/ratio na canvasie kamery)
//   points: { left: [idx...], right: [idx...] } — pickVisibleSide (w
//     evaluateRule) wybiera stronę lepiej widoczną dla kamery
//   dla "angle": points musi mieć DOKŁADNIE 3 indeksy [A, B, C] →
//     computeAngle(A, B, C), kąt w stopniach w wierzchołku B
//   dla "ratio": numerator:[i,j], denominator:[i,j] — indeksy W TABLICY
//     points (nie surowe indeksy landmarków MediaPipe!), ratio =
//     (points[j].y - points[i].y) / (points[j'].y - points[i'].y)
//   min / max: zdrowy/akceptowalny zakres wartości — reguła jest "active"
//     (błąd postawy), gdy wartość WYCHODZI poza [min, max]. Można podać tylko
//     jedno z nich (brak dolnej albo górnej granicy).
//
// Pozycja bez sekcji "detekcja" (albo z "aktywna": false) po prostu nie trafia
// z serwera — tak jak dawniej `cat_cow` świadomie nie miał tu wpisu, bo jego
// odchylenia opisują krzywiznę kręgosłupa, a MediaPipe Pose nie daje żadnego
// landmarku na kręgosłup (tylko ramiona i biodra — 2 punkty nie pokażą
// krzywizny). Taka pozycja działa normalnie w rozmowie, tylko bez korekty z kamery.
import { deriveHighlightIndices } from "./pose-detector.js";

let RULES = {};
let HIGHLIGHT_INDICES = {};

// Wołane raz przy starcie strony. Błąd sieci nie może wywalić apki: rejestr
// zostaje pusty, rulesFor() zwraca null i cały tor korekty po prostu milczy
// (ta sama graceful degradation co przy braku danych kalibracyjnych k-NN).
export async function loadPostureRules() {
  const res = await fetch("/api/asany/detekcja");
  if (!res.ok) throw new Error(`GET /api/asany/detekcja zwrócił ${res.status}`);
  const { reguly } = await res.json();
  RULES = reguly || {};
  // Wyprowadzone z RULES zamiast utrzymywane osobno — patrz
  // deriveHighlightIndices w pose-detector.js (zmiana reguły nie może po cichu
  // rozjechać się z tym, co faktycznie się podświetla na podglądzie kamery).
  HIGHLIGHT_INDICES = deriveHighlightIndices(RULES);
  return Object.keys(RULES);
}

export function rulesFor(exercise) {
  return RULES[exercise] || null;
}

export function highlightIndicesFor(exercise) {
  return HIGHLIGHT_INDICES[exercise] || [];
}
