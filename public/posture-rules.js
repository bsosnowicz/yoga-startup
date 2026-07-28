// Deklaratywny rejestr reguł geometrycznych — CO mierzymy i jakie są progi
// (wiedza domenowa o jodze). JAK mierzyć (silnik: computeAngle, computeRatio,
// evaluateRule, wygładzanie, wybór widocznej strony) żyje w pose-detector.js,
// który nie wie nic o jodze — ta sama granica co między server.js (logika) a
// posture.js (teksty korekt/keywordy).
//
// Kształt reguły:
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
// `cat_cow` nie ma tu wpisu świadomie: oba jego odchylenia (back_flat,
// neck_strain) opisują krzywiznę kręgosłupa/karku, a MediaPipe Pose nie daje
// żadnego landmarku na kręgosłup (tylko ramiona i biodra — 2 punkty nie
// pokażą krzywizny) — zostają ręczne z dropdowna, zamiast zgadywać
// niewiarygodną regułę.
import { IDX, deriveHighlightIndices } from "./pose-detector.js";

export const RULES = {
  child_pose: {
    // Wyprostowana ręka ~180°, wyraźnie ugięta/schowana < 140°.
    arms_not_extended: {
      type: "angle",
      label: "kąt łokcia",
      points: {
        left: [IDX.leftShoulder, IDX.leftElbow, IDX.leftWrist],
        right: [IDX.rightShoulder, IDX.rightElbow, IDX.rightWrist],
      },
      min: 140,
    },
    // (kolano.y - biodro.y) / (biodro.y - bark.y). Dodatnie = biodro wyżej
    // niż kolano. Najlepiej widoczne z boku — z przodu kolano i biodro mogą
    // się nakładać na obrazie, więc to zgrubna reguła.
    hips_too_high: {
      type: "ratio",
      label: "biodro nad kolanem",
      points: {
        left: [IDX.leftShoulder, IDX.leftHip, IDX.leftKnee],
        right: [IDX.rightShoulder, IDX.rightHip, IDX.rightKnee],
      },
      numerator: [1, 2],
      denominator: [0, 1],
      max: 0.2,
    },
  },
  downward_dog: {
    // (bark.y - ucho.y) / (biodro.y - bark.y). Barki podciągnięte do uszu ->
    // mały stosunek.
    shoulders_shrugged: {
      type: "ratio",
      label: "ucho/tułów",
      points: {
        left: [IDX.leftEar, IDX.leftShoulder, IDX.leftHip],
        right: [IDX.rightEar, IDX.rightShoulder, IDX.rightHip],
      },
      numerator: [0, 1],
      denominator: [1, 2],
      min: 0.15,
    },
    // (czubek.y - pięta.y) / (kostka.y - kolano.y). Dodatnie = pięta wyżej
    // niż czubek stopy. To jedyna z pierwotnie "trudnych" reguł, którą jednak
    // da się policzyć bez punktu odniesienia do podłogi — MediaPipe ma
    // osobne landmarki na piętę I czubek stopy.
    heels_lifted: {
      type: "ratio",
      label: "pięta nad czubkiem stopy",
      points: {
        left: [IDX.leftKnee, IDX.leftAnkle, IDX.leftHeel, IDX.leftFootIndex],
        right: [IDX.rightKnee, IDX.rightAnkle, IDX.rightHeel, IDX.rightFootIndex],
      },
      numerator: [2, 3],
      denominator: [0, 1],
      max: 0.25,
    },
  },
  // NOWE — progi wstępne/zgadywane, tak jak 4 reguły wyżej (patrz README,
  // sekcja "Sprint 2"): wymagają kalibracji na realnym nagraniu testera, nie
  // są sztywnymi liczbami z podręcznika biomechaniki.
  warrior_2: {
    // Kąt biodro-kolano-kostka przedniej nogi. Docelowo ~90°. Pasmo 80-120°
    // to celowo szeroki "gruby błąd" (jak 140° dla łokcia), nie precyzyjna
    // biomechanika.
    // UWAGA: pickVisibleSide (w evaluateRule) wybiera stronę PO WIDOCZNOŚCI,
    // nie po tym, która noga jest anatomicznie "przednia" — w typowym
    // ustawieniu Wojownika II (bok do kamery) obie nogi bywają podobnie
    // widoczne, więc która noga faktycznie zostanie zmierzona może być
    // niedeterministyczne między klatkami/sesjami. Świadome uproszczenie w
    // tym refaktorze — właściwe rozróżnienie przedniej/tylnej nogi wymaga
    // znajomości orientacji użytkownika względem kamery, co należy do
    // przyszłego zadania z klasyfikatorem/maszyną stanów.
    front_knee_not_bent: {
      type: "angle",
      label: "kąt kolana",
      points: {
        left: [IDX.leftHip, IDX.leftKnee, IDX.leftAnkle],
        right: [IDX.rightHip, IDX.rightKnee, IDX.rightAnkle],
      },
      min: 80,
      max: 120,
    },
    // (nadgarstek.y - bark.y) / (biodro.y - bark.y). Dodatnie = ręka opadła
    // niżej barku, ujemne = ręka uniesiona powyżej barku — oba to "nie na
    // wysokości barków", stąd symetryczne pasmo ±0.2 (rząd wielkości innych
    // ratio w tym rejestrze, np. hips_too_high).
    arms_not_level: {
      type: "ratio",
      label: "nadgarstek vs linia barków",
      points: {
        left: [IDX.leftShoulder, IDX.leftHip, IDX.leftWrist],
        right: [IDX.rightShoulder, IDX.rightHip, IDX.rightWrist],
      },
      numerator: [0, 2],
      denominator: [0, 1],
      min: -0.2,
      max: 0.2,
    },
  },
};

// Wyprowadzone z RULES zamiast ręcznie utrzymywane osobno — patrz
// deriveHighlightIndices w pose-detector.js (dodanie/zmiana reguły nie może
// tu po cichu rozjechać się z tym, co faktycznie się podświetla).
export const HIGHLIGHT_INDICES = deriveHighlightIndices(RULES);
