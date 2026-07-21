"use strict";

const PROFILE_LIMIT = 7;
const PREFERENCE_LIMIT = 3;
const ALLOWED_CATEGORIES = new Set(["profile", "preference", "session"]);

function clampConfidence(value) {
  const number = Number(value);
  // Model nie ocenia tu prawdopodobieństwa medycznego, tylko to, czy fakt
  // był jawnie powiedziany. Nie zapisujemy bezużytecznych zerowych pewności.
  return Number.isFinite(number) ? Math.max(0.7, Math.min(1, number)) : 0.8;
}

function plainText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function parseExtraction(raw, sourceSessionId, transcript = "") {
  const text = String(raw || "").replace(/^```json\s*|^```|```$/gm, "").trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return []; }
  const candidates = Array.isArray(parsed?.items) ? parsed.items : [];
  const items = candidates
    .filter((item) => item && ALLOWED_CATEGORIES.has(item.category))
    .map((item) => ({
      category: item.category,
      key: plainText(item.key, 80).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, ""),
      value: plainText(item.value),
      source_session_id: sourceSessionId,
      confidence: clampConfidence(item.confidence),
    }))
    .filter((item) => item.key && item.value);
  // Jeśli model zapisał jawny powód przerwania, przerwanie jest faktem
  // logicznie pewnym nawet gdy nie wygenerował osobnej flagi boolean.
  if (items.some((item) => item.category === "session" && item.key === "interruption_reason")
    && !items.some((item) => item.category === "session" && item.key === "interrupted")) {
    items.push({ category: "session", key: "interrupted", value: "true", source_session_id: sourceSessionId, confidence: 0.99 });
  }
  const sentences = String(transcript).split(/[.!?]\s*/).map((sentence) => plainText(sentence)).filter(Boolean);
  const discomfort = sentences.find((sentence) => /\b(boli|bolał|bolały|bolą|dolegliwoś)/i.test(sentence));
  if (discomfort && !items.some((item) => item.category === "session" && item.key === "reported_discomfort")) {
    items.push({ category: "session", key: "reported_discomfort", value: `User explicitly reported: ${discomfort}`, source_session_id: sourceSessionId, confidence: 0.99 });
  }
  const stopping = sentences.find((sentence) => /\b(muszę kończyć|musimy przerwać|muszę przerwać|kończę|mam telefon)/i.test(sentence));
  if (stopping && !items.some((item) => item.category === "session" && item.key === "interrupted")) {
    items.push({ category: "session", key: "interrupted", value: "true", source_session_id: sourceSessionId, confidence: 0.99 });
  }
  return items;
}

function extractionPrompt(userTranscript) {
  return `Extract durable, explicit memory from ONLY the user's words below.
Return valid JSON only: {"items":[{"category":"profile|preference|session","key":"snake_case","value":"short factual statement","confidence":0.0}]}

Rules:
- Never infer, diagnose, embellish, or use avatar statements.
- Profile: explicit durable facts only (name, age, experience, explicit goals, chronic/ongoing limitations).
- Preference: explicit recurring preference only.
- Session: explicit facts about this one session only (goal, last_completed_activity, next_activity, interruption, interruption_reason, reported_discomfort).
- A currently reported pain/discomfort belongs in session as reported_discomfort unless the user explicitly says it is ongoing/chronic. Do not omit it.
- If the user says they must stop/end/leave, output interrupted: "true" and, if stated, interruption_reason.
- If there is no explicit fact, return an empty items array.
- Keep values neutral and attributable; e.g. "User reported temporary back discomfort after a previous workout", never a diagnosis.

USER TRANSCRIPT:
${plainText(userTranscript, 12000)}`;
}

function buildMemoryContext({ profile = [], preferences = [], unfinishedSession = [] }) {
  const selectedProfile = profile.slice(0, PROFILE_LIMIT);
  const selectedPreferences = preferences.slice(0, PREFERENCE_LIMIT);
  const lines = [];
  if (selectedProfile.length) lines.push("Profile: " + selectedProfile.map((item) => `${item.key}: ${item.value}`).join("; "));
  if (selectedPreferences.length) lines.push("Preferences: " + selectedPreferences.map((item) => `${item.key}: ${item.value}`).join("; "));
  if (unfinishedSession.length) lines.push("Previous unfinished session: " + unfinishedSession.map((item) => `${item.key}: ${item.value}`).join("; "));
  return lines;
}

function buildCoachPrompt(basePrompt, memory) {
  const lines = buildMemoryContext(memory);
  if (!lines.length) return `${basePrompt}\n\nThis is a new user. Do not claim to remember prior sessions.`;
  const name = memory.profile.find((item) => item.key === "name")?.value;
  return `${basePrompt}\n\n${name ? `Returning user: ${name}.` : "Returning user."}\nRemembered information (may be used only as stated; never invent or diagnose):\n- ${lines.join("\n- ")}\n\nUse these facts as the current conversation context. Do not ask again for information already listed. If the user asks to continue and an unfinished session is listed, continue from its next_activity or last_completed_activity; do not ask where the session stopped. Mention remembered identity or discomfort only when the user asks or it is relevant to safety.`;
}

module.exports = { buildCoachPrompt, buildMemoryContext, extractionPrompt, parseExtraction };
