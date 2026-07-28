// Maszyna stanów "zadana vs wykonywana pozycja". Niezależna od DOM/sieci —
// czysta logika na timestampach (performance.now() od wołającego), testowalna
// bez przeglądarki. "Zadana pozycja" pochodzi z istniejącej auto-detekcji z
// transkrypcji (detectActiveExercise w index.html) — ta maszyna jej nie
// zmienia, tylko reaguje na setTarget() wołane stamtąd. "Wykonywana pozycja"
// to wynik klasyfikatora k-NN (public/knn.js), throttlowany w index.html
// (klasyfikacja co N klatek) — dlatego okna stabilności są liczone po CZASIE
// (ms), nie po liczbie klatek: liczenie "N klatek ciągiem" byłoby kruche przy
// zmianie stałej throttlingu.
//
// Stany:
//   ENTERING (WCHODZENIE) — cisza. Target wykryty stabilnie przez
//     KNN_STABLE_ENTER_MS ciągiem -> IN_POSE. Po KNN_PATIENCE_MS ciszy, inna
//     NAZWANA pozycja (nie "nieznana") stabilnie przez KNN_STABLE_MISMATCH_MS
//     ciągiem, i cooldown minął -> MISMATCH.
//   IN_POSE (W_POZYCJI) — reguły kątowe co klatkę (istniejący mechanizm,
//     poza tą maszyną). Utrata targetu stabilnie przez KNN_STABLE_EXIT_MS
//     ciągiem -> powrót do ENTERING (histereza, bez migotania).
//   MISMATCH (ROZJAZD) — komunikat wysłany (mismatchEvent w wyniku update()),
//     korekty kątowe wstrzymane (to wymusza wołający w index.html, nie ta
//     maszyna). Powtarza się co MISMATCH_COOLDOWN_MS, dopóki rozjazd trwa.
//     Powrót do targetu stabilnie przez KNN_STABLE_ENTER_MS ciągiem -> IN_POSE.
//
// Zadanie nowej pozycji w dowolnym momencie (setTarget) resetuje do ENTERING.
const KNN_STABLE_ENTER_MS = 2000;
const KNN_STABLE_EXIT_MS = 3000;
const KNN_PATIENCE_MS = 10000;
const KNN_STABLE_MISMATCH_MS = 5000;
const MISMATCH_COOLDOWN_MS = 10000;

export function createPostureStateMachine() {
  let state = "ENTERING";
  let targetPose = null;
  let enteredAt = 0;
  let matchStreakStart = null; // ENTERING/MISMATCH -> IN_POSE
  let awayStreakStart = null; // IN_POSE -> ENTERING
  let otherLabel = null;
  let otherStreakStart = null; // stabilne wykrycie innej nazwanej pozycji
  let lastMismatchAt = -Infinity;

  function setTarget(poseId, now) {
    targetPose = poseId;
    state = "ENTERING";
    enteredAt = now;
    matchStreakStart = null;
    awayStreakStart = null;
    otherLabel = null;
    otherStreakStart = null;
  }

  function fireMismatch(now, detectedLabel) {
    lastMismatchAt = now;
    state = "MISMATCH";
    // Zerujemy otherStreak — kolejne przypomnienie wymaga ponownych
    // KNN_STABLE_MISMATCH_MS ciągiem (nie tylko cooldownu), żeby pojedyncza
    // migawka innej klasyfikacji tuż po cooldownie nie wystrzeliła od razu.
    otherLabel = null;
    otherStreakStart = null;
    return { state, mismatchEvent: { detected: detectedLabel } };
  }

  // classification: { label: string|null, confidence } z knnClassifier.classify().
  // Wołać TYLKO gdy knnClassifier.isReady() i tylko na klatkach klasyfikacyjnych
  // (throttling po stronie index.html) — ta funkcja sama nie throttluje.
  function update(now, classification) {
    const label = classification.label;
    const isTarget = label === targetPose;
    const isOtherNamed = label !== null && label !== targetPose;

    if (state === "ENTERING" || state === "MISMATCH") {
      if (isTarget) {
        if (matchStreakStart === null) matchStreakStart = now;
        if (now - matchStreakStart >= KNN_STABLE_ENTER_MS) {
          state = "IN_POSE";
          awayStreakStart = null;
          return { state, mismatchEvent: null };
        }
      } else {
        matchStreakStart = null;
      }

      const patienceOver = state === "MISMATCH" || now - enteredAt >= KNN_PATIENCE_MS;
      if (patienceOver && isOtherNamed) {
        if (otherLabel !== label) {
          otherLabel = label;
          otherStreakStart = now;
        }
        const stable = now - otherStreakStart >= KNN_STABLE_MISMATCH_MS;
        const cooldownOver = now - lastMismatchAt >= MISMATCH_COOLDOWN_MS;
        if (stable && cooldownOver) return fireMismatch(now, label);
      } else if (!isOtherNamed && state === "ENTERING") {
        otherLabel = null;
        otherStreakStart = null;
      }
      return { state, mismatchEvent: null };
    }

    if (state === "IN_POSE") {
      if (isTarget) {
        awayStreakStart = null;
      } else {
        if (awayStreakStart === null) awayStreakStart = now;
        if (now - awayStreakStart >= KNN_STABLE_EXIT_MS) {
          state = "ENTERING";
          enteredAt = now;
          matchStreakStart = null;
          otherLabel = null;
          otherStreakStart = null;
        }
      }
      return { state, mismatchEvent: null };
    }
  }

  function getState() {
    return state;
  }

  return { setTarget, update, getState };
}
