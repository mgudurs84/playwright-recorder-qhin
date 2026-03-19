import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import os from "os";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CwTransactionRecord = Record<string, any>;

const SCREENSHOTS_DIR = path.join(os.tmpdir(), "cw-screenshots");
const SESSION_DIR = path.join(os.tmpdir(), "cw-sessions");
const PORTAL_URL = "https://integration.commonwellalliance.lkopera.com/";
const DEFAULT_TIMEOUT = 60000;
const ESCALATED_TIMEOUT = 120000;
const SESSION_MAX_AGE_HOURS = parseInt(process.env.SESSION_MAX_AGE_HOURS || "24", 10);

if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

interface RetryOptions {
  maxAttempts?: number;
  backoffMs?: number;
  escalateTimeout?: boolean;
  reloadOnStale?: boolean;
  page?: Page;
  onRetry?: (attempt: number, error: Error) => void;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    backoffMs = 1000,
    escalateTimeout = false,
    reloadOnStale = false,
    page,
    onRetry,
  } = opts;
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (escalateTimeout && attempt > 1 && page) {
        page.setDefaultTimeout(ESCALATED_TIMEOUT);
      }
      return await fn(attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isStaleElement =
        lastError.message.includes("stale") ||
        lastError.message.includes("detached") ||
        lastError.message.includes("Target closed") ||
        lastError.message.includes("frame was detached");
      const isTimeout =
        lastError.message.includes("Timeout") ||
        lastError.message.includes("timeout");
      const isNetworkError =
        lastError.message.includes("net::") ||
        lastError.message.includes("ERR_") ||
        lastError.message.includes("ECONNREFUSED");

      if (attempt < maxAttempts && (isStaleElement || isTimeout || isNetworkError)) {
        onRetry?.(attempt, lastError);
        const delay = backoffMs * Math.pow(2, attempt - 1);
        console.log(
          `[PlaywrightService] Retry ${attempt}/${maxAttempts} after ${delay}ms: ${lastError.message.substring(0, 100)}`
        );

        if (reloadOnStale && isStaleElement && page && !page.isClosed()) {
          console.log("[PlaywrightService] Stale element detected — reloading page...");
          try {
            await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForTimeout(2000);
          } catch (reloadErr) {
            console.warn("[PlaywrightService] Page reload failed:", (reloadErr as Error).message);
          }
        }

        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastError;
    } finally {
      if (escalateTimeout && attempt > 1 && page) {
        page.setDefaultTimeout(DEFAULT_TIMEOUT);
      }
    }
  }
  throw lastError;
}

export async function takeScreenshotAsync(page: Page, label: string): Promise<string> {
  const filename = `${label}-${Date.now()}.png`;
  const filepath = path.join(SCREENSHOTS_DIR, filename);
  try {
    await page.screenshot({ path: filepath, fullPage: true });
  } catch (err: unknown) {
    console.error(`[PlaywrightService] Screenshot failed (${label}):`, (err as Error).message);
  }
  return `/api/screenshots/${filename}`;
}

interface SessionData {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  storageState: {
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "Strict" | "Lax" | "None";
    }>;
    origins: Array<{
      origin: string;
      localStorage: Array<{ name: string; value: string }>;
    }>;
  };
}

type RunPhase = "idle" | "authenticating" | "waitingForOtp" | "authenticated" | "navigating" | "extracted" | "reporting" | "complete" | "error";

interface Checkpoint {
  phase: RunPhase;
  url: string;
  timestamp: string;
}

export class PlaywrightService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentPhase: RunPhase = "idle";
  public liveExtractionPage = 0;
  public liveExtractionCount = 0;
  private lastCheckpointUrl: string | null = null;

  private crashDetected = false;
  private intentionalClose = false;

  async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }
    console.log("[PlaywrightService] Launching browser...");
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    this.browser.on("disconnected", () => {
      if (this.intentionalClose) {
        // Deliberate close — not a crash, ignore
        return;
      }
      console.warn("[PlaywrightService] Browser disconnected unexpectedly");
      this.crashDetected = true;
      this.browser = null;
      this.context = null;
      this.page = null;
    });
    return this.browser;
  }

  private lastCheckpoint: Checkpoint | null = null;

  private persistCheckpoint(url: string): void {
    this.lastCheckpointUrl = url;
    this.lastCheckpoint = {
      phase: this.currentPhase,
      url,
      timestamp: new Date().toISOString(),
    };
  }

  private async createFreshPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    this.context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
    return this.page;
  }

  async recoverFromCrash(): Promise<boolean> {
    console.log(`[PlaywrightService] Attempting crash recovery (phase: ${this.currentPhase})...`);
    this.crashDetected = false;
    try {
      this.browser = null;
      this.context = null;
      this.page = null;

      // If the run already completed, reset cleanly and spin up a fresh page
      if (this.currentPhase === "complete" || this.currentPhase === "idle") {
        console.log(`[PlaywrightService] Run ${this.currentPhase} — resetting for fresh start`);
        this.currentPhase = "idle";
        await this.createFreshPage();
        return true;
      }

      const resumeUrl = this.lastCheckpoint?.url || this.lastCheckpointUrl;

      const username = process.env.CW_USERNAME;
      let sessionRestored = false;
      if (username) {
        sessionRestored = await this.loadSessionFromDb(username);
        if (sessionRestored) {
          console.log(`[PlaywrightService] Session restored for ${username} during crash recovery`);
        }
      }

      if (!sessionRestored) {
        await this.createFreshPage();
      }

      if (this.lastCheckpoint?.phase) {
        this.currentPhase = this.lastCheckpoint.phase;
      }

      if (resumeUrl) {
        const page = await this.getPage();
        console.log(`[PlaywrightService] Navigating back to checkpoint: ${resumeUrl}`);
        await page.goto(resumeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

        const isLoggedIn = await this.validateSession();
        if (!isLoggedIn) {
          console.warn(`[PlaywrightService] Session invalid after recovery — auth will need to re-run`);
          this.currentPhase = "idle";
        }
      }

      console.log(`[PlaywrightService] Crash recovered${sessionRestored ? " with session" : ""}, phase: ${this.currentPhase}`);
      return true;
    } catch (err) {
      console.error("[PlaywrightService] Crash recovery failed:", (err as Error).message);
      return false;
    }
  }

  async getPage(): Promise<Page> {
    if (this.crashDetected) {
      const recovered = await this.recoverFromCrash();
      if (!recovered) throw new Error("Browser crashed and recovery failed");
      return this.page!;
    }
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    return this.createFreshPage();
  }

  async saveSessionToDb(username: string): Promise<void> {
    if (!this.context) return;
    const cookies = await this.context.cookies();
    const storageState = await this.context.storageState();
    const sessionData: SessionData = { cookies, storageState };
    const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_HOURS * 60 * 60 * 1000);
    const file = path.join(SESSION_DIR, `session-${username.replace(/[^a-z0-9]/gi, "_")}.json`);
    writeFileSync(file, JSON.stringify({ sessionData, expiresAt: expiresAt.toISOString() }), "utf8");
    console.log(`[PlaywrightService] Session saved for ${username}, expires: ${expiresAt.toISOString()}`);
  }

  async loadSessionFromDb(username: string): Promise<boolean> {
    const file = path.join(SESSION_DIR, `session-${username.replace(/[^a-z0-9]/gi, "_")}.json`);
    if (!existsSync(file)) return false;

    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (new Date() > new Date(raw.expiresAt)) {
        console.log(`[PlaywrightService] Session for ${username} expired`);
        return false;
      }
      const data = raw.sessionData as SessionData;
      const browser = await this.ensureBrowser();
      this.context = await browser.newContext({
        storageState: data.storageState,
        viewport: { width: 1280, height: 800 },
      });
      if (data.cookies?.length > 0) {
        await this.context.addCookies(data.cookies);
      }
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(DEFAULT_TIMEOUT);
      console.log(`[PlaywrightService] Session restored for ${username}`);
      return true;
    } catch (err) {
      console.error("[PlaywrightService] Failed to restore session:", (err as Error).message);
      return false;
    }
  }

  async validateSession(): Promise<boolean> {
    if (!this.page) return false;
    try {
      return await withRetry(async () => {
        await this.page!.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        const url = this.page!.url();
        const isLoginPage =
          url.includes("login") ||
          url.includes("signin") ||
          url.includes("auth") ||
          (await this.page!.$('input[type="password"]')) !== null;

        if (isLoginPage) {
          console.log("[PlaywrightService] Session invalid — redirected to login");
          return false;
        }
        await this.persistCheckpoint(url);
        console.log("[PlaywrightService] Session valid — portal loaded");
        return true;
      }, { page: this.page, maxAttempts: 2, reloadOnStale: true, escalateTimeout: true });
    } catch {
      return false;
    }
  }

  async login(username: string, password: string): Promise<{ needsOtp: boolean; screenshotUrl: string }> {
    const page = await this.getPage();
    this.currentPhase = "authenticating";

    return withRetry(
      async () => {
        await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

        // Quick check: if session is still valid the portal redirects away from the login page
        // and #UserName will never appear. Detect this fast (3s) instead of timing out (30s).
        const hasLoginForm = await page.locator('#UserName, input[name="UserName"], input[name="username"], input[type="email"]')
          .isVisible({ timeout: 3000 })
          .catch(() => false);

        if (!hasLoginForm) {
          console.log("[PlaywrightService] Already authenticated — session still valid, skipping login form");
          this.currentPhase = "authenticated";
          const screenshotUrl = await takeScreenshotAsync(page, "already-authenticated");
          await this.persistCheckpoint(page.url());
          return { needsOtp: false, screenshotUrl };
        }

        // Portal uses #UserName (type=text) and #Password
        const usernameInput = page.locator('#UserName, input[name="UserName"], input[name="username"], input[type="email"]');
        const passwordInput = page.locator('#Password, input[name="Password"], input[type="password"]');

        await usernameInput.first().fill(username);
        await passwordInput.first().fill(password);

        // Portal submit button is #btnLogin (type=button, text="Sign in")
        const submitBtn = page.locator('#btnLogin, button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), input[type="submit"]');
        await submitBtn.first().click();

        await page.waitForTimeout(5000);

        // Portal OTP page: /Login/UserValidate with #OTP input and #btnSendEmail / #btnSendSMS
        const onOtpPage =
          page.url().includes("UserValidate") ||
          (await page.$('#OTP')) !== null ||
          (await page.$('#btnSendEmail')) !== null ||
          (await page.$('#btnSendSMS')) !== null;

        if (onOtpPage) {
          this.currentPhase = "waitingForOtp";
          // Automatically trigger OTP send via email (no SMS required from user)
          const sendEmailBtn = page.locator('#btnSendEmail');
          if ((await sendEmailBtn.count()) > 0) {
            console.log("[PlaywrightService] Clicking Send OTP (email)...");
            await sendEmailBtn.click();
            await page.waitForTimeout(2000);
          }
        } else {
          // Check if we landed on an authenticated page already
          const isLoggedIn = !page.url().includes("Login") && !page.url().includes("login");
          if (isLoggedIn) {
            this.currentPhase = "authenticated";
          }
        }

        const screenshotUrl = await takeScreenshotAsync(page, onOtpPage ? "otp-required" : "post-login");
        await this.persistCheckpoint(page.url());

        return { needsOtp: onOtpPage, screenshotUrl };
      },
      {
        maxAttempts: 2,
        backoffMs: 2000,
        escalateTimeout: true,
        page,
        onRetry: (attempt, err) =>
          console.warn(`[PlaywrightService] Login retry ${attempt}: ${err.message}`),
      }
    );
  }

  async submitOtp(otp: string): Promise<{ success: boolean; screenshotUrl: string }> {
    const page = await this.getPage();

    return withRetry(async () => {
      // Portal OTP input is #OTP (type=text, name="OTP")
      const otpInput = page.locator('#OTP, input[name="OTP"], input[name="otp"], input[name="code"], input[name="verificationCode"]');
      await otpInput.first().fill(otp);

      // Portal submit button on OTP page is #btnLogin (type=submit, text="Submit")
      const verifyBtn = page.locator('#btnLogin, button[type="submit"], button:has-text("Submit"), button:has-text("Verify"), button:has-text("Confirm")');
      await verifyBtn.first().click();

      await page.waitForTimeout(5000);

      // Still on OTP page if URL still contains UserValidate or #OTP is still present
      const stillOnOtpPage =
        page.url().includes("UserValidate") ||
        (await page.$('#OTP')) !== null ||
        (await page.$('#btnSendEmail')) !== null;

      const screenshotUrl = await takeScreenshotAsync(page, stillOnOtpPage ? "otp-failed" : "otp-success");
      if (!stillOnOtpPage) {
        this.currentPhase = "authenticated";
        await this.persistCheckpoint(page.url());
      }

      return { success: !stillOnOtpPage, screenshotUrl };
    }, { page, reloadOnStale: true, escalateTimeout: true });
  }

  async navigateToTransactionLogs(): Promise<string> {
    const page = await this.getPage();
    this.currentPhase = "navigating";

    return withRetry(async () => {
      const txUrl = new URL("TransactionLogs/index", PORTAL_URL).toString();
      await page.goto(txUrl, { waitUntil: "networkidle", timeout: 60000 });
      await this.persistCheckpoint(page.url());
      return await takeScreenshotAsync(page, "transaction-logs");
    }, { page, escalateTimeout: true, reloadOnStale: true });
  }

  async applyDateFilter(daysBack: number): Promise<string> {
    const page = await this.getPage();

    return withRetry(async () => {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);

      const formatDate = (d: Date) =>
        `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

      const startStr = formatDate(startDate);
      const endStr = formatDate(endDate);

      // Diagnostic: log all input fields on the page so we can debug selector mismatches
      const allInputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll("input")).map(el => ({
          id: el.id, name: el.name, type: el.type,
          placeholder: el.placeholder, className: el.className,
          dataRole: el.getAttribute("data-role"),
          visible: (el as HTMLElement).offsetParent !== null,
        }))
      );
      console.log("[PlaywrightService] Inputs on page:", JSON.stringify(allInputs));

      // Strategy 1: Kendo DatePicker via jQuery/Kendo API
      const kendoSet = await page.evaluate(({ s, e }: { s: string; e: string }) => {
        type Win = Window & { jQuery?: (sel: string) => { length: number; eq(i: number): { data(k: string): { value(v: string): void; trigger(t: string): void } | undefined }; } };
        const $ = (window as Win).jQuery;
        if (!$) return false;
        const pickers = $("[data-role='datepicker']");
        console.log("[KendoPicker] Found", pickers.length, "Kendo date pickers");
        if (pickers.length >= 2) {
          try {
            pickers.eq(0).data("kendoDatePicker")?.value(s);
            pickers.eq(0).data("kendoDatePicker")?.trigger("change");
            pickers.eq(1).data("kendoDatePicker")?.value(e);
            pickers.eq(1).data("kendoDatePicker")?.trigger("change");
            return true;
          } catch { return false; }
        }
        return false;
      }, { s: startStr, e: endStr });

      if (kendoSet) {
        console.log(`[PlaywrightService] Set dates via Kendo API: ${startStr} → ${endStr}`);
      } else {
        // Strategy 2: Try broad input selectors (plain HTML or non-Kendo)
        const startSelectors = [
          'input[name="StartDate"]', 'input[name="startDate"]', 'input[name="FromDate"]',
          'input[name="fromDate"]', 'input[id*="StartDate" i]', 'input[id*="FromDate" i]',
          'input[id*="start" i]', 'input[id*="from" i]',
          'input[placeholder*="start" i]', 'input[aria-label*="start" i]',
          '.k-datepicker:first-of-type input', '[data-role="datepicker"]:first-of-type',
        ];
        const endSelectors = [
          'input[name="EndDate"]', 'input[name="endDate"]', 'input[name="ToDate"]',
          'input[name="toDate"]', 'input[id*="EndDate" i]', 'input[id*="ToDate" i]',
          'input[id*="end" i]', 'input[id*="to" i]',
          'input[placeholder*="end" i]', 'input[aria-label*="end" i]',
          '.k-datepicker:last-of-type input', '[data-role="datepicker"]:last-of-type',
        ];

        let startFilled = false;
        let endFilled = false;

        for (const sel of startSelectors) {
          const el = page.locator(sel);
          if ((await el.count()) > 0) {
            console.log(`[PlaywrightService] Start date input found via: ${sel}`);
            await el.first().click({ clickCount: 3 });
            await el.first().fill(startStr);
            await el.first().press("Tab");
            startFilled = true;
            break;
          }
        }

        for (const sel of endSelectors) {
          const el = page.locator(sel);
          if ((await el.count()) > 0) {
            console.log(`[PlaywrightService] End date input found via: ${sel}`);
            await el.first().click({ clickCount: 3 });
            await el.first().fill(endStr);
            await el.first().press("Tab");
            endFilled = true;
            break;
          }
        }

        if (!startFilled || !endFilled) {
          console.warn(`[PlaywrightService] Date inputs not found — startFilled=${startFilled}, endFilled=${endFilled}. Check diagnostics above.`);
        } else {
          console.log(`[PlaywrightService] Set dates via HTML inputs: ${startStr} → ${endStr}`);
        }
      }

      await page.waitForTimeout(500);

      const searchBtn = page.locator(
        'button:has-text("Search"), button:has-text("Filter"), button:has-text("Apply"), input[type="submit"][value*="Search" i]'
      );
      if ((await searchBtn.count()) > 0) {
        console.log("[PlaywrightService] Clicking search button...");
        await searchBtn.first().click();
        await page.waitForTimeout(3000);
      } else {
        console.warn("[PlaywrightService] No search button found after setting dates");
      }

      return await takeScreenshotAsync(page, "date-filter-applied");
    }, { page, reloadOnStale: true });
  }

  async searchByTransactionId(transactionId: string): Promise<string> {
    const page = await this.getPage();

    return withRetry(async () => {
      // Strategy 1: form input labelled "Transaction ID" or similar
      const txInput = page.locator(
        'input[name*="transactionId" i], input[name*="transaction_id" i], ' +
        'input[id*="transactionId" i], input[placeholder*="transaction id" i]'
      );
      if ((await txInput.count()) > 0) {
        await txInput.first().clear();
        await txInput.first().fill(transactionId);
        const searchBtn = page.locator(
          'button:has-text("Search"), button:has-text("Filter"), button:has-text("Apply"), input[type="submit"]'
        );
        if ((await searchBtn.count()) > 0) await searchBtn.first().click();
        await page.waitForTimeout(3000);
        return await takeScreenshotAsync(page, "tx-id-filter-applied");
      }

      // Strategy 2: Kendo column filter icon on "Transaction ID" header
      const headers = page.locator(".k-grid-header th");
      const count = await headers.count();
      let txColIdx = -1;
      for (let i = 0; i < count; i++) {
        const text = (await headers.nth(i).innerText()).toLowerCase();
        if (text.includes("transaction id") || text.includes("transactionid") || text.includes("trace id")) {
          txColIdx = i;
          break;
        }
      }
      if (txColIdx >= 0) {
        const filterIcon = headers.nth(txColIdx).locator(".k-grid-filter, a[class*='filter'], span[class*='filter']");
        if ((await filterIcon.count()) > 0) {
          await filterIcon.first().click();
          await page.waitForTimeout(500);
          const filterInput = page.locator(".k-filter-menu input[type='text'], .k-popup input[type='text']");
          if ((await filterInput.count()) > 0) {
            await filterInput.first().fill(transactionId);
            const applyBtn = page.locator(".k-filter-menu button.k-primary, .k-popup button.k-primary, .k-filter-menu button:has-text('Filter')");
            if ((await applyBtn.count()) > 0) await applyBtn.first().click();
            await page.waitForTimeout(3000);
            return await takeScreenshotAsync(page, "tx-id-filter-applied");
          }
        }
      }

      // Strategy 3: Kendo Grid JavaScript API — most reliable for Kendo grids
      await page.evaluate((txId: string) => {
        const gridEl = document.querySelector("[data-role='grid']") as HTMLElement & {
          kendoGrid?: { dataSource: { filter(f: object): void } };
        };
        if (gridEl?.kendoGrid) {
          gridEl.kendoGrid.dataSource.filter({
            field: "TransactionId",
            operator: "contains",
            value: txId,
          });
        }
      }, transactionId);
      await page.waitForTimeout(3000);
      return await takeScreenshotAsync(page, "tx-id-filter-applied");
    }, { page, reloadOnStale: true });
  }

  async waitForDataLoaded(): Promise<boolean> {
    const page = await this.getPage();

    return withRetry(async () => {
      for (let attempt = 1; attempt <= 15; attempt++) {
        const hasData = await page.evaluate(() => {
          const grid = document.querySelector(".k-grid-content table tbody");
          if (!grid) return false;
          const rows = grid.querySelectorAll("tr");
          if (rows.length === 0) return false;
          const firstCell = rows[0].querySelector("td");
          if (firstCell && firstCell.textContent?.trim() === "No data found") return false;
          return true;
        });

        if (hasData) {
          console.log(`[PlaywrightService] Data loaded (attempt ${attempt})`);
          return true;
        }
        console.log(`[PlaywrightService] Waiting for data... (${attempt}/15)`);
        await page.waitForTimeout(2000);
      }
      return false;
    }, { page, reloadOnStale: true, escalateTimeout: true });
  }

  async extractViaKendoDataSource(maxRecords: number): Promise<CwTransactionRecord[] | null> {
    const page = await this.getPage();

    try {
      const records = await withRetry(async () => {
        return page.evaluate((max: number) => {
          const gridEl = document.querySelector("[data-role='grid']") as HTMLElement & {
            kendoGrid?: {
              dataSource: {
                data(): Array<Record<string, string>>;
              };
            };
          };
          if (!gridEl?.kendoGrid) return null;
          const ds = gridEl.kendoGrid.dataSource;
          if (!ds) return null;
          const allData = ds.data();
          if (!allData || allData.length === 0) return null;

          // Read the actual header column names from the DOM
          const headerCells = document.querySelectorAll(".k-grid-header th");
          const headers: string[] = [];
          headerCells.forEach((th) => {
            const text = (th.textContent || "").trim();
            if (text) headers.push(text);
          });

          // Log first raw item so we can debug field names
          const firstRaw = allData[0];
          const rawKeys = Object.keys(firstRaw).filter(k => !k.startsWith("_") && !k.startsWith("$") && !k.startsWith("uid"));
          console.log("[KendoExtract] Headers from DOM:", headers.join(", "));
          console.log("[KendoExtract] Kendo field keys:", rawKeys.join(", "));
          console.log("[KendoExtract] First raw item:", JSON.stringify(firstRaw));

          const limit = max > 0 ? Math.min(allData.length, max) : allData.length;
          const results: Array<Record<string, string>> = [];

          for (let i = 0; i < limit; i++) {
            const item = allData[i];
            // Extract all non-internal fields
            const record: Record<string, string> = {};
            rawKeys.forEach(k => {
              const val = (item as Record<string, unknown>)[k];
              if (val !== null && val !== undefined) {
                record[k] = String(val);
              }
            });
            results.push(record);
          }
          return results;
        }, maxRecords);
      }, { page, reloadOnStale: true, escalateTimeout: true });

      if (records && records.length > 0) {
        console.log(`[PlaywrightService] Kendo DataSource extraction: ${records.length} records, fields: ${Object.keys(records[0]).join(", ")}`);
        // Map raw Kendo fields to CwTransactionRecord using flexible key lookup
        return records.map(item => this.mapKendoRecord(item));
      }
    } catch (err) {
      console.log(`[PlaywrightService] Kendo DataSource not available: ${(err as Error).message}`);
    }
    return null;
  }

  private mapKendoRecord(item: Record<string, string>): CwTransactionRecord {
    const find = (...keys: string[]) => {
      for (const k of keys) {
        if (item[k] !== undefined && item[k] !== null && item[k] !== "") return item[k];
        // try case-insensitive
        const lk = k.toLowerCase();
        const match = Object.keys(item).find(ik => ik.toLowerCase() === lk);
        if (match && item[match]) return item[match];
      }
      return "";
    };
    return {
      timestamp: find("TransactionDateTime", "Timestamp", "DateTime", "Date"),
      transactionId: find("TransactionId", "TraceId", "Id"),
      transactionType: find("TransactionType", "Type", "MessageType"),
      memberName: find("InitiatingOrganization", "MemberName", "Organization", "OrgName"),
      initiatingOrgId: find("InitiatingOrgId", "OrgId", "OrganizationId"),
      duration: find("ResponseTime", "Duration", "Time"),
      status: find("Status", "Result", "TransactionStatus", "ResponseCode", "StatusCode"),
      raw: item,
    };
  }

  async extractViaDOMPagination(maxRecords: number): Promise<CwTransactionRecord[]> {
    const page = await this.getPage();
    const allTransactions: CwTransactionRecord[] = [];
    let pageNum = 1;
    this.liveExtractionPage = 0;
    this.liveExtractionCount = 0;

    while (true) {
      const pageTransactions = await withRetry(async () => {
        return page.evaluate(() => {
          // Read header column names for proper mapping
          const headerCells = document.querySelectorAll(".k-grid-header th");
          const headers: string[] = [];
          headerCells.forEach((th) => {
            const text = (th.textContent || "").trim();
            headers.push(text);
          });

          const rows = document.querySelectorAll(".k-grid-content table tbody tr");
          const txns: Array<Record<string, string>> = [];
          rows.forEach((row) => {
            const cells = row.querySelectorAll("td");
            if (cells.length >= 3) {
              const record: Record<string, string> = {};
              cells.forEach((cell, idx) => {
                const key = headers[idx] || `col_${idx}`;
                record[key] = cell.textContent?.trim() || "";
              });
              // Also store cell index values for debugging
              record["_cols"] = cells.length.toString();
              txns.push(record);
            }
          });
          return txns;
        });
      }, { page, reloadOnStale: true, escalateTimeout: true });

      console.log(`[PlaywrightService] Page ${pageNum}: ${pageTransactions.length} transactions`);
      if (pageNum === 1 && pageTransactions.length > 0) {
        console.log(`[PlaywrightService] DOM columns: ${Object.keys(pageTransactions[0]).join(", ")}`);
      }
      const mapped = pageTransactions.map(r => this.mapKendoRecord(r));
      if (maxRecords > 0) {
        const remaining = maxRecords - allTransactions.length;
        allTransactions.push(...mapped.slice(0, remaining));
      } else {
        allTransactions.push(...mapped);
      }
      this.liveExtractionPage = pageNum;
      this.liveExtractionCount = allTransactions.length;

      if (maxRecords > 0 && allTransactions.length >= maxRecords) {
        console.log(`[PlaywrightService] Max records (${maxRecords}) reached, stopping at ${allTransactions.length}`);
        break;
      }

      const nextButton = page.getByRole("button", { name: "Next" });
      const hasNext = (await nextButton.count()) > 0 && !(await nextButton.isDisabled().catch(() => true));
      if (!hasNext) break;

      await withRetry(async () => {
        await nextButton.click();
        await page.waitForTimeout(2000);
      }, { page, reloadOnStale: true, escalateTimeout: true });
      pageNum++;
    }

    return allTransactions;
  }

  async extractTransactions(maxRecords: number = 0): Promise<{
    records: CwTransactionRecord[];
    screenshotUrl: string;
  }> {
    this.currentPhase = "navigating";
    let records = await this.extractViaKendoDataSource(maxRecords);
    if (!records) {
      records = await this.extractViaDOMPagination(maxRecords);
    }

    const page = await this.getPage();
    const screenshotUrl = await takeScreenshotAsync(page, "extraction-complete");
    this.currentPhase = "extracted";

    return { records, screenshotUrl };
  }

  getCurrentPhase(): RunPhase {
    return this.currentPhase;
  }

  setPhase(phase: RunPhase): void {
    this.currentPhase = phase;
  }

  async close(): Promise<void> {
    this.intentionalClose = true;
    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
      if (this.context) await this.context.close();
      if (this.browser) await this.browser.close();
    } catch {
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
      this.crashDetected = false;
      this.intentionalClose = false;
      this.lastCheckpoint = null;
      this.lastCheckpointUrl = null;
      this.currentPhase = "idle";
    }
    console.log("[PlaywrightService] Browser closed");
  }
}

let _instance: PlaywrightService | null = null;

export function getPlaywrightService(): PlaywrightService {
  if (!_instance) {
    _instance = new PlaywrightService();
  }
  return _instance;
}
