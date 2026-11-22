const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const vm = require("node:vm");
const { yaml } = require("../node_modules/playwright-core/lib/utilsBundle");

const ROOT = path.resolve(__dirname, "..");

function workflow(relativePath) {
  return yaml.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function trustedRun(overrides = {}) {
  return {
    id: 41,
    event: "schedule",
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    created_at: "2026-09-25T23:17:00.000Z",
    head_branch: "main",
    head_repository: { full_name: "mmcars/rentcars" },
    repository: { full_name: "mmcars/rentcars" },
    has_scrape_jobs: true,
    ...overrides
  };
}

const trustOptions = {
  repository: "mmcars/rentcars",
  defaultBranch: "main"
};

test("daily notification is independent from Pages and has read-only permissions", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const notify = daily.jobs.notify;

  assert.ok(notify, "daily workflow must define a standalone notify job");
  assert.equal(notify.environment, undefined);
  assert.deepEqual(notify.permissions, { actions: "read", contents: "read", pages: "read" });
  assert.match(String(notify.if), /always\(\)/);
  assert.deepEqual(notify.needs, ["plan", "scrape", "merge"]);
  assert.equal(notify.steps.some((step) => step.uses === "actions/checkout@v4"), false);
  assert.equal(notify.steps.some((step) => step.uses === "actions/download-artifact@v4"), true);

  const notifyShell = notify.steps.map((step) => step.run || "").join("\n");
  const sendStep = notify.steps.find((step) => step.name === "Send Telegram notification");
  const freshnessStep = daily.jobs.publish.steps.find((step) => step.name === "Check report freshness");
  const verifyStep = daily.jobs.publish.steps.find((step) => step.name === "Verify published report slots");
  assert.match(notifyShell, /report-meta\.json/);
  assert.match(notifyShell, /report\.html/);
  assert.match(sendStep.run, /profile_url="\$\{pages_url\}\$\{REPORT_PROFILE\}\/"/);
  assert.match(sendStep.run, /\$\{profile_url\}report-meta\.json/);
  assert.match(sendStep.run, /\$\{profile_url\}report\.html/);
  assert.equal(sendStep.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.match(sendStep.run, /Authorization: Bearer \$\{GITHUB_TOKEN\}/);
  assert.equal(freshnessStep.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(freshnessStep.run.trim(), "node src/rentcars/pagesSite.js");
  assert.equal(verifyStep.if, "steps.pages-deployment.outcome == 'success'");
  assert.equal(verifyStep.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(verifyStep.run.trim(), "node src/rentcars/pagesSite.js --verify");
  assert.equal(daily.jobs.publish.steps.some((step) => step.name === "Prepare GitHub Pages site"), false);
  assert.equal(daily.jobs.merge.environment, undefined);
  assert.equal(daily.jobs.publish.environment.name, "github-pages");
  assert.equal([].concat(daily.jobs.publish.needs).includes("notify"), false);
  assert.match(String(daily.jobs.publish.if), /always\(\)/);
  assert.match(String(daily.jobs.publish.outputs.published), /pages-deployment\.outcome == 'success'/);
});

test("daily Pages deployment retries once when the fresh artifact is not yet visible", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const steps = daily.jobs.publish.steps;
  const index = (id) => steps.findIndex((step) => step.id === id);
  const first = steps[index("pages-deploy-first")];
  const retry = steps[index("pages-deploy-retry")];
  const confirm = steps[index("pages-deployment")];
  const wait = steps.find((step) => step.name === "Wait before retrying GitHub Pages deployment");
  const artifactName = "github-pages-attempt-${{ github.run_attempt }}";

  assert.equal(first.uses, "actions/deploy-pages@v4");
  assert.equal(first["continue-on-error"], true);
  assert.equal(first.with.artifact_name, artifactName);
  assert.equal(wait.if, "steps.pages-deploy-first.outcome == 'failure'");
  assert.match(wait.run, /sleep \d+/);
  assert.equal(retry.uses, "actions/deploy-pages@v4");
  assert.equal(retry.if, "steps.pages-deploy-first.outcome == 'failure'");
  assert.equal(retry["continue-on-error"], undefined, "a failed retry must still fail the run for the watchdog");
  assert.equal(retry.with.artifact_name, artifactName);
  assert.equal(confirm.uses, undefined);
  assert.match(confirm.if, /pages-deploy-first\.outcome == 'success'/);
  assert.match(confirm.if, /pages-deploy-retry\.outcome == 'success'/);
  assert.match(confirm.env.PAGE_URL, /pages-deploy-first\.outputs\.page_url \|\| steps\.pages-deploy-retry\.outputs\.page_url/);
  assert.match(confirm.run, /page_url=/);
  assert.ok(index("pages-deploy-first") < index("pages-deploy-retry"));
  assert.ok(index("pages-deploy-retry") < index("pages-deployment"));
  assert.equal(daily.jobs.publish.environment.url, "${{ steps.pages-deployment.outputs.page_url }}");
});

test("cancelling a daily run blocks merging and publishing its partial report", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  for (const name of ["merge", "publish"]) {
    assert.match(daily.jobs[name].if, /!cancelled\(\)/);
    assert.match(daily.jobs[name].if, /always\(\)/);
  }
});

function executeNotification({ withBody, pagesSiteAvailable = true, metadataAttempt = "2", metadataRunId = "77",
  malformedMetadata = false, htmlStatus = "200", htmlMarker = true, staleHtml = false,
  localHtmlAvailable = true, reportProfile = "afternoon", notificationPayload, mergeResult = "success",
  expectedMetadataRequests }) {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const sendStep = daily.jobs.notify.steps.find((step) => step.name === "Send Telegram notification");
  const bashPath = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";

  assert.ok(sendStep, "daily notification must have a send step");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-notify-shell-"));
  const inputDir = path.join(tempDir, "notification-input");
  const capturePath = path.join(tempDir, "telegram-message.txt");
  const bashEnvPath = path.join(tempDir, "bash-env.sh");
  const requestsPath = path.join(tempDir, "requests.txt");
  const publicHtmlPath = path.join(tempDir, "public.html");
  const publicMetaPath = path.join(tempDir, "public-meta.json");
  const expectedHtml = '<!doctype html><meta name="rentcars-report-metadata-version" content="1"><h1>Run 77/2</h1><p>220 PLN</p>';
  fs.mkdirSync(inputDir);
  if (localHtmlAvailable) {
    fs.writeFileSync(path.join(inputDir, "rentcars-report.html"), expectedHtml);
  }
  fs.writeFileSync(publicHtmlPath, htmlMarker
    ? staleHtml ? expectedHtml.replace("220 PLN", "200 PLN") : expectedHtml
    : "<html>Service unavailable</html>");
  fs.writeFileSync(publicMetaPath, malformedMetadata ? "{not-json"
    : JSON.stringify({ run_id: metadataRunId, run_attempt: Number(metadataAttempt) }));
  if (withBody) {
    const body = notificationPayload
      ? require("../src/rentcars/dailyNotification").buildDailyNotification(notificationPayload)
      : "RentCars.pl: przebieg zakończony – komplet danych";
    fs.writeFileSync(path.join(inputDir, "rentcars-notification-body.txt"), body, "utf8");
  }
  fs.writeFileSync(bashEnvPath, [
    "curl() {",
    "  local output_path=''",
    "  local is_pages_api=false",
    "  local is_metadata=false",
    "  local is_html=false",
    "  local previous=''",
    "  local argument",
    "  for argument in \"$@\"; do",
    "    if [[ \"$previous\" == '--output' ]]; then output_path=\"$argument\"; fi",
    "    if [[ \"$argument\" == */repos/*/pages ]]; then is_pages_api=true; fi",
    "    if [[ \"$argument\" == *report-meta.json* ]]; then is_metadata=true; fi",
    "    if [[ \"$argument\" == https://*report.html* ]]; then is_html=true; fi",
    "    previous=\"$argument\"",
    "  done",
    "  if [[ \"$is_pages_api\" == true ]]; then",
    "    if [[ \"$MOCK_PAGES_SITE_AVAILABLE\" == true ]]; then",
    "      printf '{\"html_url\":\"https://reports.example.test/rentcars\"}' > \"$output_path\"",
    "      printf '200'",
    "    else",
    "      printf '404'",
    "    fi",
    "    return 0",
    "  fi",
    "  if [[ \"$is_metadata\" == true ]]; then",
    "    echo metadata >> \"$REQUESTS_PATH\"",
    "    cp \"$MOCK_PUBLIC_META_PATH\" \"$output_path\"",
    "    printf '200'",
    "    return 0",
    "  fi",
    "  if [[ \"$is_html\" == true ]]; then",
    "    echo html >> \"$REQUESTS_PATH\"",
    "    cp \"$MOCK_PUBLIC_HTML_PATH\" \"$output_path\"",
    "    printf '%s' \"$MOCK_HTML_STATUS\"",
    "    return 0",
    "  fi",
    "  echo telegram >> \"$REQUESTS_PATH\"",
    "  while [[ $# -gt 0 ]]; do",
    "    if [[ \"$1\" == text=* ]]; then printf '%s' \"${1#text=}\" > \"$CAPTURE_PATH\"; fi",
    "    shift",
    "  done",
    "}",
    "sleep() { echo sleep >> \"$REQUESTS_PATH\"; }",
    "export -f curl sleep"
  ].join("\n"), "utf8");

  try {
    const result = spawnSync(bashPath, ["--noprofile", "--norc", "-eo", "pipefail", "-c", sendStep.run], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...process.env,
        BASH_ENV: bashEnvPath.replaceAll("\\", "/"),
        CAPTURE_PATH: capturePath.replaceAll("\\", "/"),
        RUNNER_TEMP: tempDir.replaceAll("\\", "/"),
        MOCK_PAGES_SITE_AVAILABLE: pagesSiteAvailable ? "true" : "false",
        MOCK_PUBLIC_META_PATH: publicMetaPath.replaceAll("\\", "/"),
        MOCK_PUBLIC_HTML_PATH: publicHtmlPath.replaceAll("\\", "/"),
        REQUESTS_PATH: requestsPath.replaceAll("\\", "/"),
        MOCK_HTML_STATUS: htmlStatus,
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_CHAT_ID: "test-chat",
        GITHUB_TOKEN: "test-github-token",
        GITHUB_RUN_ID: "77",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_REPOSITORY: "mmcars/rentcars",
        GITHUB_REPOSITORY_OWNER: "mmcars",
        REPORT_PROFILE: reportProfile,
        PLAN_RESULT: "success",
        SCRAPE_RESULT: "success",
        MERGE_RESULT: mergeResult
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const requests = fs.readFileSync(requestsPath, "utf8").trim().split(/\r?\n/);
    assert.equal(requests.filter(value => value === "telegram").length, 1);
    for (const kind of ["metadata", "html"]) {
      assert.ok(requests.filter(value => value === kind).length <= 18, `${kind} requests must remain bounded`);
    }
    assert.ok(requests.filter(value => value === "sleep").length <= 17);
    if (expectedMetadataRequests !== undefined) {
      assert.equal(requests.filter(value => value === "metadata").length, expectedMetadataRequests);
    }
    return fs.readFileSync(capturePath, "utf8");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("daily notification sends one verified report link or one bounded link-free fallback", () => {
  const execute = executeNotification;
  const linkCount = (message) => (message.match(/https?:\/\//g) || []).length;

  const successMessage = execute({ withBody: true });
  assert.equal((successMessage.match(/RentCars\.pl: przebieg zakończony/g) || []).length, 1);
  assert.match(successMessage, /Raport:\nhttps:\/\/reports\.example\.test\/rentcars\/afternoon\/report\.html\n$/);

  const morningSuccessMessage = execute({ withBody: true, reportProfile: "morning" });
  assert.equal((morningSuccessMessage.match(/RentCars\.pl: przebieg zakończony/g) || []).length, 1);
  assert.match(morningSuccessMessage, /Raport:\nhttps:\/\/reports\.example\.test\/rentcars\/morning\/report\.html\n$/);

  const noJsonMessage = execute({ withBody: false });
  assert.equal((noJsonMessage.match(/RentCars\.pl: przebieg zakończony/g) || []).length, 1);
  assert.match(noJsonMessage, /brak szczegółów \(plan=success, scrape=success, merge=success\)/);
  assert.match(noJsonMessage, /Raport:\nhttps:\/\/reports\.example\.test\/rentcars\/afternoon\/report\.html\n$/);

  for (const message of [successMessage, morningSuccessMessage, noJsonMessage]) {
    assert.equal(linkCount(message), 1, "a published report sends exactly one link");
    assert.doesNotMatch(message, /Artifact backup|GitHub Actions run|github\.test/);
  }

  const pagesFailureMessage = execute({ withBody: true, pagesSiteAvailable: false });
  assert.equal(linkCount(pagesFailureMessage), 0, "an unpublished report sends no links");
  assert.equal((pagesFailureMessage.match(/RentCars\.pl: przebieg zakończony/g) || []).length, 1);
  assert.doesNotMatch(pagesFailureMessage, /report\.html/);
  assert.match(pagesFailureMessage, /Raport nie trafił na stronę\. Napisz do Bartka, żeby sprawdził i opublikował\.\n$/);

  const staleAttemptMessage = execute({ withBody: true, metadataAttempt: "1" });
  assert.equal((staleAttemptMessage.match(/RentCars\.pl: przebieg zakończony/g) || []).length, 1);
  assert.doesNotMatch(staleAttemptMessage, /report\.html/);
  assert.match(staleAttemptMessage, /Raport nie trafił na stronę/);

  for (const failure of [{ htmlStatus: "404" }, { htmlMarker: false }]) {
    const invalidHtmlMessage = execute({ withBody: true, ...failure });
    assert.doesNotMatch(invalidHtmlMessage, /report\.html/);
    assert.match(invalidHtmlMessage, /Raport nie trafił na stronę/);
  }
});

test("fresh metadata with modified stale HTML keeps the notification link-free after eighteen checks", () => {
  const message = executeNotification({ withBody: true, staleHtml: true, expectedMetadataRequests: 18 });
  assert.doesNotMatch(message, /Raport:|report\.html/);
  assert.match(message, /Raport nie trafił na stronę\. Napisz do Bartka, żeby sprawdził i opublikował\.\n$/);
});

test("notification requires local artifact HTML and valid current run identity", () => {
  for (const options of [
    { localHtmlAvailable: false, expectedMetadataRequests: 0 },
    { metadataRunId: "76", expectedMetadataRequests: 18 },
    { malformedMetadata: true, expectedMetadataRequests: 18 }
  ]) {
    const message = executeNotification({ withBody: true, ...options });
    assert.doesNotMatch(message, /Raport:|report\.html/);
    assert.match(message, /Raport nie trafił na stronę\. Napisz do Bartka, żeby sprawdził i opublikował\.\n$/);
  }
});

test("failed partial merge still notifies its real status and may link its exact published artifact", () => {
  const message = executeNotification({ withBody: true, mergeResult: "failure", notificationPayload: {
    run_status: "partial", completed_scenario_count: 1, expected_scenario_count: 2,
    successful_check_count: 1, failed_check_count: 0, missing_check_count: 1, expected_check_count: 2,
    scenarios: []
  } });
  assert.match(message, /przebieg zakończony – niepełne dane\nScenariusze: 1\/2\nSprawdzenia cen: udane 1, błędy 0, brak wyniku 1 \(z 2\)\nWygenerowano: nieznana/);
  assert.doesNotMatch(message, /komplet danych/);
  assert.match(message, /Raport:\n/);
});

function evaluateExpression(expression, context) {
  return vm.runInNewContext(String(expression).replace(/^\$\{\{\s*|\s*\}\}$/g, ""), context);
}

test("publication accepts saved partial reports without disguising merge failure and blocks missing reports", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const cases = [
    ["complete", "success", true, true, false, true],
    ["partial", "failure", true, true, false, true],
    ["complete_with_errors", "failure", true, true, false, true],
    ["no report", "failure", false, true, false, false],
    ["no artifact", "success", true, false, false, false],
    ["cancelled", "failure", true, true, true, false]
  ];
  for (const [name, result, ready, uploaded, isCancelled, expected] of cases) {
    const context = {
      always: () => true, cancelled: () => isCancelled,
      steps: { report: { outputs: { report_exists: ready ? "true" : "" } },
        metadata: { outputs: { metadata_exists: ready ? "true" : "" } },
        upload: { outputs: { "artifact-url": uploaded ? "https://github.test/artifacts/55" : "" } } }
    };
    const outputs = Object.fromEntries(Object.entries(daily.jobs.merge.outputs)
      .map(([key, expression]) => [key, evaluateExpression(expression, context)]));
    context.needs = { merge: { result, outputs }, plan: { result: "success", outputs: { should_run: "true" } } };
    assert.equal(Boolean(evaluateExpression(daily.jobs.publish.if, context)), expected, name);
    assert.equal(evaluateExpression(daily.jobs.notify.if, context), true, `${name}: notify still runs`);
  }
  for (const [reportExists, metadataExists] of [[true, false], [false, true]]) {
    const context = { steps: { report: { outputs: { report_exists: String(reportExists) } },
      metadata: { outputs: { metadata_exists: String(metadataExists) } } } };
    assert.notEqual(evaluateExpression(daily.jobs.merge.outputs.report_ready, context), "true");
  }
});

test("daily schedule retains 60 rolling dates and durations 2 through 14", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const inputs = daily.on.workflow_dispatch.inputs;

  assert.equal(daily.env.SCHEDULE_ROLLING_DAYS, "60");
  assert.equal(daily.env.SCHEDULE_DURATIONS, "2,3,4,5,6,7,8,9,10,11,12,13,14");
  assert.equal(inputs.rolling_days.default, "60");
  assert.equal(inputs.durations.default, "2,3,4,5,6,7,8,9,10,11,12,13,14");
});

test("19:17 and 10:17 slots keep separate horizons, titles and reports whether GitHub or OVH starts them", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const watchdog = require("../src/rentcars/watchdog");
  assert.deepEqual(daily.on.schedule, [
    { cron: "17 19 * * *", timezone: "Europe/Warsaw" },
    { cron: "17 10 * * *", timezone: "Europe/Warsaw" }
  ]);
  const slotInput = daily.on.workflow_dispatch.inputs.scheduled_slot;
  assert.deepEqual(slotInput.options, ["none", "night", "daytime"]);
  assert.equal(slotInput.default, "none");
  assert.equal(daily.env.SCHEDULE_DAYTIME_ROLLING_DAYS, "20");
  const cases = [
    ["schedule", "17 10 * * *", {}, "RentCars daytime run", "daytime", "afternoon"],
    ["schedule", "17 19 * * *", {}, "RentCars daily run", "night", "morning"],
    ["schedule", "17 0 * * *", {}, "RentCars daily run", "", "morning"],
    ["workflow_dispatch", "", { scheduled_slot: "daytime" }, watchdog.OVH_DAYTIME_RUN_TITLE, "daytime", "afternoon"],
    ["workflow_dispatch", "", { scheduled_slot: "night" }, watchdog.OVH_NIGHT_RUN_TITLE, "night", "morning"],
    ["workflow_dispatch", "", { scheduled_slot: "none" }, "RentCars daily run", "", "morning"],
    ["workflow_dispatch", "", { scheduled_slot: "none", watchdog_recovery: "true" }, "RentCars watchdog recovery", "", "morning"]
  ];
  for (const [eventName, cron, inputs, title, slot, profile] of cases) {
    const context = { github: { event_name: eventName, event: { schedule: cron } }, inputs };
    const label = `${eventName} ${cron} ${JSON.stringify(inputs)}`;
    assert.equal(evaluateExpression(daily["run-name"], context), title, label);
    assert.equal(evaluateExpression(daily.env.RUN_SLOT, context), slot, label);
    assert.equal(evaluateExpression(daily.env.REPORT_PROFILE, context), profile, label);
  }
  const send = daily.jobs.notify.steps.find(step => step.name === "Send Telegram notification");
  assert.equal(send.env.TELEGRAM_BOT_TOKEN, "${{ secrets.TELEGRAM_BOT_TOKEN }}");
  assert.equal(send.env.TELEGRAM_CHAT_ID, "${{ secrets.TELEGRAM_CHAT_ID }}");
});

test("schedule gate skips slots already started and keeps day, night, retry and manual date ranges", () => {
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  const steps = daily.jobs.plan.steps;
  const gate = steps.find(step => step.id === "gate");
  const options = steps.find(step => step.id === "options");
  assert.ok(steps.findIndex(step => step.uses === "actions/checkout@v4") < steps.indexOf(gate));
  assert.equal(gate.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(options.env.RUN_CREATED_AT, "${{ steps.original_run.outputs.created_at }}");
  const original = steps.find(step => step.id === "original_run");
  assert.equal(original.if, "steps.gate.outputs.should_run == 'true' && env.RUN_SLOT != ''");
  assert.match(original.run, /actions\/runs\/\$\{GITHUB_RUN_ID\}/);
  const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
  const repo = "mmcars/rentcars";
  const ghRun = (id, event, title, createdAt) => ({ id, event, display_title: title, created_at: createdAt,
    status: "completed", conclusion: "success", head_branch: "main",
    head_repository: { full_name: repo }, repository: { full_name: repo } });
  // Each case: event, slot, created date, earlier runs, gh failure, should_run, days, rolling_days input.
  const cases = [
    ["schedule", "daytime", "2026-07-15", [], false, true, 20, ""],
    ["schedule", "daytime", "2026-12-15", [], false, true, 20, ""],
    ["schedule", "night", "2026-07-15", [], false, true, 60, ""],
    ["schedule", "night", "2026-12-15", [], false, true, 60, ""],
    ["schedule", "", "2026-07-15", [], false, false, 0, ""],
    ["workflow_dispatch", "", "2026-07-15", [], false, true, 7, "7"],
    ["workflow_dispatch", "daytime", "2026-07-15", [], false, true, 20, "60"],
    ["schedule", "night", "2026-07-15",
      [ghRun(40, "workflow_dispatch", "RentCars daily run (OVH)", "2026-07-15T17:17:02Z")], false, false, 0, ""],
    ["schedule", "daytime", "2026-07-15",
      [ghRun(40, "workflow_dispatch", "RentCars daily run (OVH)", "2026-07-15T17:17:02Z")], false, true, 20, ""],
    ["schedule", "night", "2026-07-15",
      [ghRun(40, "workflow_dispatch", "RentCars daily run", "2026-07-15T17:17:02Z")], false, true, 60, ""],
    ["schedule", "night", "2026-07-15", [], true, true, 60, ""]
  ];
  for (const [event, slot, date, earlierRuns, ghFails, shouldRun, expectedDays, inputDays] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-schedule-"));
    const label = `${date}: ${event} ${slot || "manual"} after ${earlierRuns.map(run => run.display_title).join(", ") || "nothing"}${ghFails ? " (API down)" : ""}`;
    try {
      const output = path.join(dir, "output.txt").replace(/\\/g, "/");
      const createdAt = `${date}T22:23:00Z`;
      const current = ghRun(41, event, slot === "daytime" && event === "schedule" ? "RentCars daytime run"
        : slot === "daytime" ? "RentCars daytime run (OVH)" : slot === "night" && event !== "schedule"
          ? "RentCars daily run (OVH)" : "RentCars daily run", createdAt);
      current.status = "in_progress"; current.conclusion = null;
      const bashEnv = path.join(dir, "bash-env.sh");
      fs.writeFileSync(bashEnv, [
        "gh() {",
        "  if [[ -n \"$MOCK_GH_FAIL\" ]]; then return 1; fi",
        "  if [[ \"$2\" == */actions/runs/* ]]; then printf '%s' \"$MOCK_CURRENT_RUN\"; else printf '%s' \"$MOCK_RUNS\"; fi",
        "}",
        "export -f gh"
      ].join("\n"));
      const allRuns = [current, ...earlierRuns];
      const interpolate = (source) => source.replaceAll("${{ github.event_name }}", event)
        .replaceAll("${{ steps.gate.outputs.should_run }}", String(shouldRun));
      const env = { ...process.env, ...daily.env, RUN_SLOT: slot, GITHUB_OUTPUT: output, GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "41", GITHUB_REPOSITORY: repo, DEFAULT_BRANCH: "main", BASH_ENV: bashEnv.replace(/\\/g, "/"),
        MOCK_GH_FAIL: ghFails ? "1" : "", MOCK_CURRENT_RUN: JSON.stringify(current),
        MOCK_RUNS: JSON.stringify({ total_count: allRuns.length, workflow_runs: allRuns }),
        INPUT_ROLLING_DAYS: inputDays, RUN_CREATED_AT: createdAt,
        INPUT_LOCATIONS: "", INPUT_DURATIONS: "", INPUT_SPEED_MODE: "",
        INPUT_SORT_ORDERS: "", INPUT_LOCATION_CONCURRENCY: "" };
      delete env.REPORT_PROFILE;
      const gateResult = spawnSync(bash, ["-eo", "pipefail", "-c", interpolate(gate.run)],
        { cwd: ROOT, env, encoding: "utf8" });
      assert.equal(gateResult.status, 0, gateResult.stderr);
      assert.match(fs.readFileSync(output, "utf8"), new RegExp(`should_run=${shouldRun}`), label);
      if (ghFails) assert.match(gateResult.stdout, /::warning::Could not check earlier runs/);
      if (date === "2026-12-15") continue;
      const result = spawnSync(bash, ["-eo", "pipefail", "-c", interpolate(options.run)], { cwd: ROOT, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const values = Object.fromEntries(fs.readFileSync(output, "utf8").trim().split(/\r?\n/).map(line => {
        const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
      }));
      assert.equal(Number(values.rolling_days), expectedDays, label);
      assert.equal(Number(values.expected_scenario_count), expectedDays * 13);
      assert.equal(Number(values.expected_check_count), expectedDays * 13 * 10);
      if (shouldRun) {
        assert.ok(values.locations.split(",").includes("Szczecin"));
        assert.equal(values.start_dates.split(",").length, expectedDays);
        if (slot) {
          // Created 00:23 Warsaw the next day: the night slot keeps its report-cycle date,
          // the daytime slot starts on the following day.
          const firstDate = new Date(`${date}T12:00:00Z`);
          firstDate.setUTCDate(firstDate.getUTCDate() + (slot === "night" ? 1 : 2));
          assert.equal(values.start_dates.split(",")[0], firstDate.toISOString().slice(0, 10), label);
        }
        assert.equal(JSON.parse(values.matrix).include.length, Math.ceil(expectedDays / 3));
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("OVH timers start both slots on time in Warsaw time with the workflow's slot names", () => {
  const ops = path.join(ROOT, "ops/ovh");
  const daily = workflow(".github/workflows/rentcars-daily.yml");
  for (const [slot, time] of [["night", "19:17"], ["daytime", "10:17"]]) {
    const timer = fs.readFileSync(path.join(ops, `rentcars-trigger-${slot}.timer`), "utf8");
    assert.match(timer, new RegExp(`^OnCalendar=\\*-\\*-\\* ${time}:00 Europe/Warsaw$`, "m"));
    assert.match(timer, new RegExp(`^Unit=rentcars-trigger@${slot}\\.service$`, "m"));
    assert.ok(daily.on.workflow_dispatch.inputs.scheduled_slot.options.includes(slot));
  }
  assert.match(fs.readFileSync(path.join(ops, "rentcars-trigger@.service"), "utf8"), /^ExecStart=%h\/\.local\/bin\/rentcars-trigger %i$/m);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-ovh-"));
  try {
    const argsPath = path.join(dir, "args.txt");
    fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsPath}"\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    const script = path.join(ops, "rentcars-trigger.sh");
    const ok = spawnSync("bash", [script, "daytime"], { env, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(fs.readFileSync(argsPath, "utf8").trim().split("\n"),
      ["workflow", "run", "rentcars-daily.yml", "--repo", "prejsik/MMSL-Scrapper-Rentcars", "--ref", "main", "-f", "scheduled_slot=daytime"]);
    fs.rmSync(argsPath);
    const bad = spawnSync("bash", [script, "manual"], { env, encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.equal(fs.existsSync(argsPath), false, "an unknown slot never starts a run");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("notification formatter preserves blank lines and alerts only when MM is absent for the whole date", () => {
  const { buildDailyNotification } = require("../src/rentcars/dailyNotification");
  const scenario = (startDate, rentalDays, providerName) => ({
    start_date: startDate,
    rental_days: rentalDays,
    expected_check_count: 1,
    successful_check_count: 1,
    failed_check_count: 0,
    results: [{ provider_name: providerName }]
  });
  const payload = {
    run_status: "complete",
    completed_scenario_count: 4,
    expected_scenario_count: 4,
    successful_check_count: 4,
    failed_check_count: 0,
    missing_check_count: 0,
    expected_check_count: 4,
    generated_at: "2026-09-26T05:00:00.000Z",
    scenarios: [
      scenario("2026-10-01", 2, "MM Cars Rental"),
      scenario("2026-10-01", 3, "Another provider"),
      scenario("2026-10-02", 2, "Another provider"),
      scenario("2026-10-02", 3, "Another provider")
    ]
  };

  assert.equal(buildDailyNotification(payload, {
    expectedStartDates: "2026-10-01,2026-10-02",
    expectedDurations: "2,3"
  }), [
    "RentCars.pl: przebieg zakończony – komplet danych",
    "Scenariusze: 4/4",
    "Sprawdzenia cen: udane 4, błędy 0, brak wyniku 0 (z 4)",
    "Wygenerowano: 26.09.2026, 07:00",
    "",
    "ALERT MM Cars Rental",
    "",
    "Brak MM - pe\u0142ne dane:",
    "2026-10-02"
  ].join("\n"));
});

test("notification formatter CLI rejects malformed source JSON", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-notification-"));
  const inputPath = path.join(tempDir, "invalid.json");
  const helperPath = path.join(ROOT, "src/rentcars/dailyNotification.js");
  fs.writeFileSync(inputPath, "{not-json", "utf8");

  try {
    assert.equal(fs.existsSync(helperPath), true, "notification formatter CLI must exist");
    const result = spawnSync(process.execPath, [
      helperPath,
      inputPath,
      "2026-10-01",
      "2"
    ], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JSON|Unexpected|property name/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("smoke validation rejects partial, error, malformed, and missing JSON after exit zero", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-smoke-validation-"));
  const helperPath = path.join(ROOT, "src/rentcars/validateSmokeResult.js");
  const cases = [
    {
      name: "partial",
      file: "partial.json",
      contents: JSON.stringify({
        run_status: "partial",
        is_partial: true,
        expected_scenario_count: 1,
        completed_scenario_count: 0,
        expected_check_count: 9,
        successful_check_count: 0,
        failed_check_count: 0,
        missing_check_count: 9
      })
    },
    {
      name: "error",
      file: "error.json",
      contents: JSON.stringify({
        run_status: "complete_with_errors",
        is_partial: false,
        expected_scenario_count: 1,
        completed_scenario_count: 1,
        expected_check_count: 9,
        successful_check_count: 8,
        failed_check_count: 1,
        missing_check_count: 0
      })
    },
    {
      name: "null count",
      file: "null-count.json",
      contents: JSON.stringify({
        run_status: "complete",
        is_partial: false,
        expected_scenario_count: 1,
        completed_scenario_count: 1,
        expected_check_count: 9,
        successful_check_count: 9,
        failed_check_count: null,
        missing_check_count: 0
      })
    },
    { name: "malformed", file: "malformed.json", contents: "{" },
    { name: "missing", file: "missing.json", contents: null }
  ];

  try {
    assert.equal(fs.existsSync(helperPath), true, "smoke validation CLI must exist");
    for (const fixture of cases) {
      const inputPath = path.join(tempDir, fixture.file);
      if (fixture.contents != null) {
        fs.writeFileSync(inputPath, fixture.contents, "utf8");
      }
      const result = spawnSync(process.execPath, [helperPath, "0", inputPath], { encoding: "utf8" });
      assert.notEqual(result.status, 0, `${fixture.name} result must fail validation`);
      assert.match(result.stderr, /smoke|JSON|ENOENT|complete/i);
    }

    const validPath = path.join(tempDir, "blank-status.json");
    fs.writeFileSync(validPath, JSON.stringify({
      run_status: "complete",
      is_partial: false,
      expected_scenario_count: 1,
      completed_scenario_count: 1,
      expected_check_count: 9,
      successful_check_count: 9,
      failed_check_count: 0,
      missing_check_count: 0
    }), "utf8");
    const blankStatus = spawnSync(process.execPath, [helperPath, "", validPath], { encoding: "utf8" });
    assert.notEqual(blankStatus.status, 0, "blank subprocess status must fail validation");
    assert.match(blankStatus.stderr, /subprocess status is invalid/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("smoke validation accepts a complete zero-error result", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rentcars-smoke-validation-"));
  const inputPath = path.join(tempDir, "complete.json");
  fs.writeFileSync(inputPath, JSON.stringify({
    run_status: "complete",
    is_partial: false,
    expected_scenario_count: 1,
    completed_scenario_count: 1,
    expected_check_count: 9,
    successful_check_count: 9,
    failed_check_count: 0,
    missing_check_count: 0
  }), "utf8");

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "src/rentcars/validateSmokeResult.js"),
      "0",
      inputPath
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Validated complete RentCars smoke result: 1\/1 scenarios, 9\/9 checks/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("smoke workflow validates JSON before rendering a report", () => {
  const smoke = workflow(".github/workflows/rentcars-smoke.yml");
  const steps = smoke.jobs.smoke.steps;
  const scrapeIndex = steps.findIndex((step) => step.name === "Run one-day smoke scraper");
  const validateIndex = steps.findIndex((step) => step.name === "Validate smoke JSON");
  const reportIndex = steps.findIndex((step) => step.name === "Generate smoke report");

  assert.ok(scrapeIndex >= 0 && validateIndex > scrapeIndex && reportIndex > validateIndex);
  assert.match(steps[scrapeIndex].run, /scraper_status=.*GITHUB_OUTPUT/s);
  assert.match(steps[validateIndex].run, /validateSmokeResult\.js/);
  assert.match(steps[validateIndex].run, /steps\.scraper\.outputs\.scraper_status/);
});

test("watchdog listens for completed daily runs and serializes recovery", () => {
  const watchdog = workflow(".github/workflows/rentcars-watchdog.yml");

  assert.deepEqual(watchdog.on.workflow_run.workflows, ["RentCars daily run"]);
  assert.deepEqual(watchdog.on.workflow_run.types, ["completed"]);
  assert.equal(watchdog.concurrency.group, "rentcars-watchdog-recovery");
  assert.equal(watchdog.concurrency["cancel-in-progress"], false);
  assert.deepEqual(watchdog.permissions, { actions: "write", contents: "read" });
});

test("completed-run recovery accepts only trusted default-repository default-branch daily runs", () => {
  const { decideCompletedRunRecovery } = require("../src/rentcars/watchdog");
  const source = trustedRun();

  assert.deepEqual(decideCompletedRunRecovery(source, [source], trustOptions), {
    action: "rerun",
    runId: 41,
    runAttempt: 1
  });
  assert.deepEqual(decideCompletedRunRecovery(
    trustedRun({ head_repository: { full_name: "fork/rentcars" } }),
    [],
    trustOptions
  ), { action: "none", runId: null, runAttempt: 0 });
  assert.deepEqual(decideCompletedRunRecovery(
    trustedRun({ head_branch: "feature" }),
    [],
    trustOptions
  ), { action: "none", runId: null, runAttempt: 0 });
  assert.deepEqual(decideCompletedRunRecovery(
    trustedRun({ event: "pull_request" }),
    [],
    trustOptions
  ), { action: "none", runId: null, runAttempt: 0 });
});

test("completed-run recovery stops at attempt three and never races an active trusted run", () => {
  const { decideCompletedRunRecovery } = require("../src/rentcars/watchdog");
  const exhausted = trustedRun({ run_attempt: 3 });
  assert.deepEqual(decideCompletedRunRecovery(exhausted, [exhausted], trustOptions), {
    action: "exhausted",
    runId: 41,
    runAttempt: 3
  });

  const failed = trustedRun();
  const active = trustedRun({
    id: 42,
    status: "in_progress",
    conclusion: null,
    run_attempt: 2,
    created_at: "2026-09-26T00:00:00.000Z"
  });
  assert.deepEqual(decideCompletedRunRecovery(failed, [failed, active], trustOptions), {
    action: "monitor",
    runId: 42,
    runAttempt: 2
  });
});

test("completed-run recovery accepts only the watchdog-marked dispatch", () => {
  const { decideCompletedRunRecovery } = require("../src/rentcars/watchdog");
  const recovery = trustedRun({
    event: "workflow_dispatch",
    display_title: "RentCars watchdog recovery"
  });
  const manual = trustedRun({
    event: "workflow_dispatch",
    display_title: "RentCars daily run"
  });

  assert.equal(decideCompletedRunRecovery(recovery, [recovery], trustOptions).action, "rerun");
  assert.deepEqual(decideCompletedRunRecovery(manual, [manual], trustOptions), {
    action: "none",
    runId: null,
    runAttempt: 0
  });
});
