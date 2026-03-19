import { Express } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { createVertex } from "@ai-sdk/google-vertex";
import { generateText } from "ai";
import { getPlaywrightService } from "../services/playwright-service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CwTransactionRecord = Record<string, any>;

type RunnerPhase =
  | "idle"
  | "login:started"
  | "otp:waiting"
  | "navigating"
  | "extracting"
  | "reporting"
  | "complete"
  | "error";

interface RunnerState {
  phase: RunnerPhase;
  daysBack: number;
  transactionId: string | null;
  searchMode: "date" | "transaction_id";
  maxRecords: number;
  recordCount: number;
  errorCount: number;
  errorMessage: string | null;
  reportFile: string | null;
  screenshotUrls: string[];
}

let state: RunnerState = {
  phase: "idle",
  daysBack: 7,
  transactionId: null,
  searchMode: "date",
  maxRecords: 0,
  recordCount: 0,
  errorCount: 0,
  errorMessage: null,
  reportFile: null,
  screenshotUrls: [],
};

let otpResolver: ((otp: string) => void) | null = null;
let otpRejecter: ((err: Error) => void) | null = null;
let cancelFlag = false;

function checkCancelled() {
  if (cancelFlag) throw new Error("Cancelled by user");
}

function waitForOtp(): Promise<string> {
  return new Promise((resolve, reject) => {
    otpResolver = resolve;
    otpRejecter = reject;
  });
}

const REPORT_DIR = path.join(os.tmpdir(), "cw-reports");

function createVertexModel() {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error("GCP_SERVICE_ACCOUNT_JSON not set");
  const serviceAccount = JSON.parse(serviceAccountJson) as { project_id: string };
  const vertex = createVertex({
    project: serviceAccount.project_id,
    location: "us-central1",
    googleAuthOptions: { credentials: serviceAccount },
  });
  return vertex(process.env.VERTEX_MODEL_ID || "gemini-2.5-flash");
}

function buildStats(records: CwTransactionRecord[]) {
  const statusCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  const orgCounts: Record<string, number> = {};
  let earliest = "";
  let latest = "";

  for (const r of records) {
    const s = r.status ?? r.Status ?? "Unknown";
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;

    const t = r.transaction_type ?? r["Transaction Type"] ?? r.transactionType ?? "Unknown";
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;

    const org = r.initiating_org_name ?? r["Initiating Org Name"] ?? r.initiatingOrgName ?? "Unknown";
    orgCounts[org] = (orgCounts[org] ?? 0) + 1;

    const ts = r.timestamp ?? r.Timestamp ?? "";
    if (ts) {
      if (!earliest || ts < earliest) earliest = ts;
      if (!latest || ts > latest) latest = ts;
    }
  }

  const topN = (map: Record<string, number>, n = 10) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");

  return { statusCounts, typeCounts, orgCounts, earliest, latest, topN };
}

async function generateReport(records: CwTransactionRecord[]): Promise<string> {
  const model = createVertexModel();

  const isError = (r: CwTransactionRecord) => {
    const s = (r.status ?? r.Status ?? "").toLowerCase();
    return s.includes("error") || s.includes("fail");
  };

  const errorRecords = records.filter(isError);

  // Build compact aggregate stats — send these instead of raw JSON blobs
  const { topN, earliest, latest } = buildStats(records);
  const { topN: errTopN } = buildStats(errorRecords);
  const allStats = buildStats(records);

  // Only include up to 80 error records verbatim (to keep prompt small)
  const errorSample = errorRecords.slice(0, 80);

  const prompt = `You are a CommonWell Health Alliance transaction analyst. Generate a comprehensive markdown error analysis report.

## Dataset Summary
- Total records extracted: ${records.length}
- Error/failure records: ${errorRecords.length} (${((errorRecords.length / records.length) * 100).toFixed(1)}% error rate)
- Date range: ${earliest || "N/A"} → ${latest || "N/A"}

## Status Distribution (all records)
${topN(allStats.statusCounts, 15)}

## Transaction Type Distribution (all records)
${topN(allStats.typeCounts, 15)}

## Top Initiating Organizations (all records)
${topN(allStats.orgCounts, 15)}

## Error Record Status Distribution
${errTopN(buildStats(errorRecords).statusCounts, 10)}

## Error Records Sample (${errorSample.length} of ${errorRecords.length} shown)
${JSON.stringify(errorSample, null, 2)}

---

Generate a well-structured markdown report with these sections:
1. **Executive Summary** — total transactions, error rate, date range covered
2. **Error Breakdown** — errors grouped by status/type with counts and percentages, using tables
3. **Affected Organizations** — which orgs have the most errors (table with org name, error count, error rate)
4. **Transaction Type Analysis** — which transaction types fail most (table)
5. **Top Issues and Recommendations** — actionable next steps based on the specific errors seen

Use markdown tables wherever appropriate. Be specific and data-driven.`;

  const { text } = await generateText({
    model,
    prompt,
    maxTokens: 8192,
  });

  return text;
}

async function runPipeline(daysBack: number, transactionId: string | null, maxRecords: number) {
  const pw = getPlaywrightService();
  const username = process.env.CW_USERNAME;
  const password = process.env.CW_PASSWORD;

  if (!username || !password) {
    state.phase = "error";
    state.errorMessage = "CW_USERNAME or CW_PASSWORD environment variable not set";
    return;
  }

  try {
    state.phase = "login:started";
    console.log("[CW Runner] Starting login...");
    const { needsOtp, screenshotUrl } = await pw.login(username, password);
    if (screenshotUrl) state.screenshotUrls = [screenshotUrl];

    checkCancelled();

    if (needsOtp) {
      state.phase = "otp:waiting";
      console.log("[CW Runner] Waiting for OTP from user...");
      const otp = await waitForOtp();
      checkCancelled();
      console.log("[CW Runner] OTP received, submitting...");
      const { success, screenshotUrl: otpShot } = await pw.submitOtp(otp);
      if (otpShot) state.screenshotUrls.push(otpShot);
      if (!success) throw new Error("OTP submission failed — check the code and try again");
    }

    checkCancelled();

    state.phase = "navigating";
    console.log("[CW Runner] Navigating to transaction logs...");
    const navShot = await pw.navigateToTransactionLogs();
    if (navShot) state.screenshotUrls.push(navShot);

    checkCancelled();

    let filterShot: string;
    if (transactionId) {
      console.log(`[CW Runner] Searching by transaction ID: ${transactionId}`);
      filterShot = await pw.searchByTransactionId(transactionId);
    } else {
      console.log(`[CW Runner] Applying ${daysBack}-day date filter...`);
      filterShot = await pw.applyDateFilter(daysBack);
    }
    if (filterShot) state.screenshotUrls.push(filterShot);

    checkCancelled();

    state.phase = "extracting";
    console.log(`[CW Runner] Extracting transactions (maxRecords=${maxRecords || "unlimited"})...`);
    const { records, screenshotUrl: extractShot } = await pw.extractTransactions(maxRecords);
    if (extractShot) state.screenshotUrls.push(extractShot);

    checkCancelled();

    state.recordCount = records.length;
    state.errorCount = records.filter(
      (r) =>
        r.status?.toLowerCase().includes("error") ||
        r.status?.toLowerCase().includes("fail")
    ).length;
    console.log(`[CW Runner] Extracted ${records.length} records, ${state.errorCount} errors`);

    state.phase = "reporting";
    console.log("[CW Runner] Generating report with LLM...");
    try {
      const report = await generateReport(records);
      if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const file = path.join(REPORT_DIR, `cw-report-${ts}.md`);
      fs.writeFileSync(file, report, "utf8");
      state.reportFile = file;
      console.log(`[CW Runner] Report saved: ${file}`);
    } catch (reportErr) {
      console.warn("[CW Runner] Report generation failed (skipped):", (reportErr as Error).message);
      state.reportFile = null;
    }

    state.phase = "complete";
    console.log(`[CW Runner] Complete. ${records.length} records extracted, report ${state.reportFile ? "saved" : "skipped"}.`);
  } catch (err) {
    state.phase = "error";
    state.errorMessage = (err as Error).message;
    console.error("[CW Runner] Pipeline error:", state.errorMessage);
  } finally {
    otpResolver = null;
    otpRejecter = null;
  }
}

function resetState(): void {
  cancelFlag = false;
  state = {
    phase: "idle",
    daysBack: 7,
    transactionId: null,
    searchMode: "date",
    maxRecords: 0,
    recordCount: 0,
    errorCount: 0,
    errorMessage: null,
    reportFile: null,
    screenshotUrls: [],
  };
}

export function registerCwRunnerRoutes(app: Express) {
  app.post("/api/cw/run", async (req, res) => {
    const running = state.phase !== "idle" && state.phase !== "complete" && state.phase !== "error";
    if (running) {
      return res.status(409).json({ error: "A run is already in progress", phase: state.phase });
    }

    const { daysBack = 7, transactionId = null, maxRecords = 0 } = req.body as {
      daysBack?: number;
      transactionId?: string | null;
      maxRecords?: number;
    };

    if (otpRejecter) otpRejecter(new Error("Cancelled by new run"));
    const pw = getPlaywrightService();
    try { await pw.close(); } catch {}

    resetState();
    state.daysBack = Number(daysBack) || 7;
    state.transactionId = transactionId || null;
    state.searchMode = transactionId ? "transaction_id" : "date";
    state.maxRecords = Number(maxRecords) || 0;

    runPipeline(state.daysBack, state.transactionId, state.maxRecords).catch(console.error);

    res.json({ started: true, daysBack: state.daysBack, transactionId: state.transactionId, maxRecords: state.maxRecords });
  });

  app.post("/api/cw/otp", (req, res) => {
    if (state.phase !== "otp:waiting") {
      return res.status(400).json({ error: `Not waiting for OTP (phase: ${state.phase})` });
    }
    const { otp } = req.body as { otp: string };
    if (!otp?.trim()) {
      return res.status(400).json({ error: "OTP is required" });
    }
    if (!otpResolver) {
      return res.status(500).json({ error: "OTP resolver not ready" });
    }
    otpResolver(otp.trim());
    res.json({ accepted: true });
  });

  app.get("/api/cw/status", (_req, res) => {
    const pw = getPlaywrightService();
    res.json({
      ...state,
      liveExtractionPage: pw.liveExtractionPage,
      liveExtractionCount: pw.liveExtractionCount,
    });
  });

  app.post("/api/cw/cancel", async (_req, res) => {
    const running = state.phase !== "idle" && state.phase !== "complete" && state.phase !== "error";
    if (!running) {
      return res.status(400).json({ error: "No run in progress" });
    }
    cancelFlag = true;
    if (otpRejecter) otpRejecter(new Error("Cancelled by user"));
    state.phase = "error";
    state.errorMessage = "Cancelled by user";
    console.log("[CW Runner] Run cancelled by user");
    res.json({ cancelled: true });
  });

  app.post("/api/cw/reset", async (_req, res) => {
    if (otpRejecter) otpRejecter(new Error("Run cancelled"));
    const pw = getPlaywrightService();
    try { await pw.close(); } catch {}
    resetState();
    res.json({ reset: true });
  });

  app.get("/api/cw/report", (_req, res) => {
    if (!state.reportFile || !fs.existsSync(state.reportFile)) {
      return res.status(404).json({ error: "No report available" });
    }
    const date = new Date().toISOString().split("T")[0];
    res.download(state.reportFile, `cw-report-${date}.md`);
  });

  app.head("/api/cw/report", (_req, res) => {
    if (!state.reportFile || !fs.existsSync(state.reportFile)) {
      return res.status(404).end();
    }
    res.status(200).end();
  });
}
