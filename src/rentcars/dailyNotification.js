#!/usr/bin/env node

const fs = require("node:fs");
const { buildMmAvailabilityAlert } = require("./telegramSummary");

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

const RUN_STATUS_LABELS = {
  complete: "komplet danych",
  complete_with_errors: "z błędami",
  partial: "niepełne dane"
};

/** Formats an ISO timestamp as Warsaw local time, e.g. "22.11.2026, 05:22". */
function formatWarsawTime(value) {
  const date = new Date(String(value || ""));
  if (!value || Number.isNaN(date.getTime())) {
    return "nieznana";
  }
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw",
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

/**
 * Builds the Polish Telegram summary for a merged RentCars run.
 * The workflow appends the report link (or the "not published" note) below it.
 */
function buildDailyNotification(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("RentCars notification source must be a JSON object.");
  }
  if (!payload.run_status) {
    throw new Error("RentCars notification source is missing run_status.");
  }

  const status = RUN_STATUS_LABELS[payload.run_status] || String(payload.run_status);
  const summary = [
    `RentCars.pl: przebieg zakończony – ${status}`,
    `Scenariusze: ${count(payload.completed_scenario_count)}/${count(payload.expected_scenario_count)}`,
    `Sprawdzenia cen: udane ${count(payload.successful_check_count)}, błędy ${count(payload.failed_check_count)}, brak wyniku ${count(payload.missing_check_count)} (z ${count(payload.expected_check_count)})`,
    `Wygenerowano: ${formatWarsawTime(payload.generated_at)}`
  ].join("\n");
  const sections = [summary];
  const mmAlert = buildMmAvailabilityAlert(payload, options);
  if (mmAlert) {
    sections.push(mmAlert);
  }
  return sections.join("\n\n");
}

function main() {
  const [inputPath, expectedStartDates, expectedDurations] = process.argv.slice(2);
  if (!inputPath) {
    throw new Error("Usage: node src/rentcars/dailyNotification.js INPUT_JSON START_DATES_CSV DURATIONS_CSV");
  }
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  process.stdout.write(buildDailyNotification(payload, {
    expectedStartDates,
    expectedDurations
  }));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  RUN_STATUS_LABELS,
  buildDailyNotification
};
