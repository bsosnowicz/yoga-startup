"use strict";

const fs = require("fs");
const path = require("path");

const CALIBRATION_DIR = path.join(__dirname, "calibration");

// poseId/variant przychodzą z inputu klienta (dropdown + pole "nowa
// pozycja") i trafiają bezpośrednio do nazwy pliku — bez sanityzacji
// payload {poseId: "../../etc/passwd"} mógłby pisać poza calibration/.
function safeSegment(value) {
  return String(value || "").trim().replace(/[^a-z0-9_-]/gi, "").toLowerCase();
}

function calibrationFilePath(poseId, variant) {
  return path.join(CALIBRATION_DIR, `${safeSegment(poseId)}.${safeSegment(variant)}.json`);
}

// Sync celowo: odczyt+zapis bez await pomiędzy wyklucza race przy dwóch
// równoczesnych POST-ach do tego samego pliku (append to read-modify-write).
function appendCalibrationRecording(poseId, variant, poseLabel, recording) {
  const id = safeSegment(poseId);
  const v = safeSegment(variant);
  if (!id || !v) throw new Error("Nieprawidłowe poseId/variant.");
  fs.mkdirSync(CALIBRATION_DIR, { recursive: true });
  const filePath = calibrationFilePath(id, v);
  let data = { poseId: id, variant: v, poseLabel: poseLabel || id, recordings: [] };
  if (fs.existsSync(filePath)) {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  data.poseLabel = poseLabel || data.poseLabel || id;
  data.recordings.push(recording);
  fs.writeFileSync(filePath, JSON.stringify(data));
  return {
    file: `calibration/${id}.${v}.json`,
    recordingIndex: data.recordings.length - 1,
    totalRecordings: data.recordings.length,
  };
}

function loadAllCalibrations() {
  if (!fs.existsSync(CALIBRATION_DIR)) return [];
  return fs
    .readdirSync(CALIBRATION_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(CALIBRATION_DIR, f), "utf8"));
      } catch (e) {
        console.warn(`Kalibracja: pomijam uszkodzony plik ${f}:`, e.message);
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { appendCalibrationRecording, loadAllCalibrations };
