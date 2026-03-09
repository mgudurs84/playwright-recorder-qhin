#!/usr/bin/env node
/**
 * CommonWell Management Portal — Flexible E2E Automation
 *
 * Features:
 *  - Bulk data extraction via Kendo Grid dataSource API (no slow pagination!)
 *  - CLI arguments for full control: dates, formats, filters, modules
 *  - Multiple export formats: CSV, JSON, TXT summary, Excel-ready
 *  - Modular portal sections: Transaction Logs, Audit Logs, etc.
 *  - Configurable filters: type, status, member, org
 *
 * Usage:
 *   node commonwell-login.js [options]
 *
 * Examples:
 *   node commonwell-login.js                                  # defaults: 7 days, all formats
 *   node commonwell-login.js --days 1                         # last 24 hours
 *   node commonwell-login.js --days 30 --format csv           # CSV only, 30 days
 *   node commonwell-login.js --from 2026-03-01 --to 2026-03-08
 *   node commonwell-login.js --module transactions --format json
 *   node commonwell-login.js --module audit                   # audit logs
 *   node commonwell-login.js --filter-status failure          # only failures
 *   node commonwell-login.js --filter-type CreatePatient      # specific type
 *   node commonwell-login.js --headless                       # headless after OTP
 *   node commonwell-login.js --max-records 500                # cap extraction
 *   node commonwell-login.js --skip-login                     # reuse saved session
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ---------------------------------------------------------------------------
// CLI Argument Parser
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    days: parseInt(process.env.SEARCH_DAYS_BACK || '7', 10),
    from: null,        // explicit start date (YYYY-MM-DD)
    to: null,          // explicit end date (YYYY-MM-DD)
    format: 'all',     // csv | json | txt | all
    module: 'transactions', // transactions | audit | organizations
    filterStatus: null,     // e.g. 'success', 'failure'
    filterType: null,       // e.g. 'CreatePatient'
    filterMember: null,     // e.g. 'SomeMember'
    filterOrg: null,        // e.g. 'OrgId'
    headless: false,
    maxRecords: 0,          // 0 = unlimited
    skipLogin: false,
    outputDir: path.join(__dirname, 'reports'),
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];
    switch (arg) {
      case '--days':         opts.days = parseInt(next(), 10); break;
      case '--from':         opts.from = next(); break;
      case '--to':           opts.to = next(); break;
      case '--format':       opts.format = next(); break;
      case '--module':       opts.module = next(); break;
      case '--filter-status': opts.filterStatus = next(); break;
      case '--filter-type':  opts.filterType = next(); break;
      case '--filter-member': opts.filterMember = next(); break;
      case '--filter-org':   opts.filterOrg = next(); break;
      case '--headless':     opts.headless = true; break;
      case '--max-records':  opts.maxRecords = parseInt(next(), 10); break;
      case '--skip-login':   opts.skipLogin = true; break;
      case '--output-dir':   opts.outputDir = next(); break;
      case '--help': case '-h': opts.help = true; break;
      default:
        console.warn(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║        CommonWell Automation — Flexible E2E Runner              ║
╚══════════════════════════════════════════════════════════════════╝

  USAGE:  node commonwell-login.js [options]

  DATE OPTIONS:
    --days N              Search N days back (default: 7)
    --from YYYY-MM-DD     Explicit start date
    --to   YYYY-MM-DD     Explicit end date

  OUTPUT OPTIONS:
    --format FORMAT       csv | json | txt | all (default: all)
    --output-dir PATH     Custom output directory (default: ./reports)
    --max-records N       Cap extraction at N records (0 = unlimited)

  MODULE OPTIONS:
    --module MODULE       transactions | audit | organizations (default: transactions)

  FILTER OPTIONS:
    --filter-status STR   Filter by status (e.g. "success", "failure")
    --filter-type STR     Filter by transaction type (e.g. "CreatePatient")
    --filter-member STR   Filter by member name
    --filter-org STR      Filter by initiating org ID

  BROWSER OPTIONS:
    --headless            Run headless (after OTP entry)
    --skip-login          Reuse saved session (skip login/OTP)

  EXAMPLES:
    node commonwell-login.js --days 1 --format csv
    node commonwell-login.js --from 2026-03-01 --to 2026-03-07 --format json
    node commonwell-login.js --filter-type CreatePatient --filter-status failure
    node commonwell-login.js --module audit --days 3
    node commonwell-login.js --max-records 500 --format all
`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const CONFIG = {
  url: 'https://integration.commonwellalliance.lkopera.com/',
  username: process.env.CW_USERNAME,
  password: process.env.CW_PASSWORD,
  sessionFile: path.join(__dirname, 'commonwell-session.json'),
  timeout: 60000,
};

const MODULE_URLS = {
  transactions: 'TransactionLogs/index',
  audit: 'AuditLogs/index',
  organizations: 'Organizations',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OTP_FILE = path.join(__dirname, 'otp-input.txt');

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] ${message}`);
}

function sendDesktopNotification(title, message) {
  try {
    const notifier = require('node-notifier');
    notifier.notify({ title, message, sound: true, wait: true });
  } catch {
    // node-notifier not available — skip silently
  }
}

// Strategy 1: GUI popup via PowerShell InputBox (best for desktop / scheduled runs)
function waitForOTPViaGUI(prompt) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const psScript = `
      Add-Type -AssemblyName Microsoft.VisualBasic
      $otp = [Microsoft.VisualBasic.Interaction]::InputBox(
        'Enter the OTP code sent to your email:',
        'CommonWell Automation — OTP Required',
        ''
      )
      Write-Output $otp
    `;
    log('Opening OTP popup dialog...');
    execFile('powershell.exe', ['-NoProfile', '-Command', psScript], { timeout: 5 * 60 * 1000 }, (err, stdout) => {
      if (err) return reject(err);
      const otp = (stdout || '').trim();
      if (otp.length > 0) {
        log(`OTP received via popup: ${otp}`);
        resolve(otp);
      } else {
        reject(new Error('OTP popup was cancelled or empty.'));
      }
    });
  });
}

// Strategy 2: Terminal readline prompt (fallback for visible terminal)
function waitForOTPViaTerminal(prompt) {
  return new Promise((resolve, reject) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n🔐 ${prompt}\n   Enter OTP: `, (otp) => {
      rl.close();
      otp = (otp || '').trim();
      if (otp.length > 0) {
        log(`OTP received via terminal: ${otp}`);
        resolve(otp);
      } else {
        reject(new Error('No OTP entered in terminal.'));
      }
    });
    // Timeout after 5 minutes
    setTimeout(() => { rl.close(); reject(new Error('Timed out waiting for OTP in terminal.')); }, 5 * 60 * 1000);
  });
}

// Strategy 3: File-based polling (original — used as last resort or by CI/scripts)
function waitForOTPViaFile(prompt) {
  return new Promise(async (resolve, reject) => {
    if (fs.existsSync(OTP_FILE)) fs.unlinkSync(OTP_FILE);
    log(`Waiting for OTP via file... Write it to: ${OTP_FILE}`);

    const maxWaitMs = 5 * 60 * 1000;
    const pollMs = 2000;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      if (fs.existsSync(OTP_FILE)) {
        const otp = fs.readFileSync(OTP_FILE, 'utf8').trim();
        if (otp.length > 0) {
          fs.unlinkSync(OTP_FILE);
          log(`OTP received via file: ${otp}`);
          return resolve(otp);
        }
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
    reject(new Error('Timed out waiting for OTP file (5 minutes).'));
  });
}

// Combined: GUI popup → terminal prompt → file-based (with fallback chain)
async function waitForOTP(prompt) {
  log(prompt);

  // Try GUI popup first
  try {
    return await waitForOTPViaGUI(prompt);
  } catch (e) {
    log(`GUI popup failed (${e.message}). Falling back to terminal...`);
  }

  // Try terminal prompt
  try {
    if (process.stdin.isTTY) {
      return await waitForOTPViaTerminal(prompt);
    }
    log('No interactive terminal detected. Falling back to file-based input...');
  } catch (e) {
    log(`Terminal prompt failed (${e.message}). Falling back to file-based input...`);
  }

  // Last resort: file-based
  return await waitForOTPViaFile(prompt);
}

function computeDateRange(opts) {
  let fromDate, toDate;

  if (opts.from) {
    fromDate = new Date(opts.from + 'T00:00:00');
  } else {
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - opts.days);
    fromDate.setHours(0, 0, 0, 0);
  }

  if (opts.to) {
    toDate = new Date(opts.to + 'T23:59:00');
  } else {
    toDate = new Date();
    toDate.setHours(23, 59, 0, 0);
  }

  return { fromDate, toDate };
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Login + MFA (unchanged — proven to work)
// ---------------------------------------------------------------------------

async function loginWithCredentials(page) {
  log('Navigating to CommonWell login page...');
  await page.goto(CONFIG.url, { waitUntil: 'networkidle', timeout: CONFIG.timeout });

  log('Filling credentials...');
  await page.getByRole('textbox', { name: 'Email Address' }).fill(CONFIG.username);
  await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.password);

  log('Clicking Sign In...');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForTimeout(3000);
}

async function handleMFA(page) {
  log('Waiting for MFA/OTP screen...');

  // Screen 1: Click "Send OTP"
  log('Looking for Send OTP button...');
  try {
    const sendOtpBtn = page.getByRole('button', { name: /send otp/i });
    await sendOtpBtn.waitFor({ timeout: 10000 });
    log('Send OTP button found. Clicking...');
    await sendOtpBtn.click();
    log('OTP sent to your email! Check your inbox.');
    await page.waitForTimeout(3000);
  } catch {
    log('Send OTP button not found — may already be on OTP entry screen.');
  }

  sendDesktopNotification('CommonWell Automation', 'OTP sent! Enter code.');

  // Screen 2: Enter OTP
  log('Waiting for OTP input field...');
  const otpSelectors = [
    'input[placeholder*="OTP"]', 'input[placeholder*="otp"]',
    'input[name*="otp"]', 'input[name*="OTP"]',
    'input[name*="code"]', 'input[type="tel"]', 'input[type="number"]',
  ];

  let matchedSelector = null;
  for (const selector of otpSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      matchedSelector = selector;
      log(`OTP field detected: ${selector}`);
      break;
    } catch { /* try next */ }
  }

  const otp = await waitForOTP('📧 OTP needed! Check your email.');

  // Re-locate the OTP field AFTER receiving OTP to avoid stale element handles
  let filled = false;
  if (matchedSelector) {
    try {
      const freshField = await page.waitForSelector(matchedSelector, { timeout: 5000 });
      if (freshField) {
        await freshField.fill(otp);
        filled = true;
      }
    } catch {
      log('Original OTP field no longer available, trying fallback...');
    }
  }
  if (!filled) {
    // Fallback: try all OTP selectors again fresh
    for (const selector of otpSelectors) {
      try {
        const field = await page.waitForSelector(selector, { timeout: 3000 });
        if (field) {
          await field.fill(otp);
          filled = true;
          break;
        }
      } catch { /* try next */ }
    }
  }
  if (!filled) {
    const inputs = await page.locator('input[type="text"], input[type="tel"], input[type="number"]').all();
    if (inputs.length > 0) await inputs[0].fill(otp);
  }

  log('OTP entered. Clicking SUBMIT...');
  const submitBtn = page.getByRole('button', { name: /submit/i });
  if (await submitBtn.count() > 0) {
    await submitBtn.first().click();
  } else if (matchedSelector) {
    const currentField = await page.$(matchedSelector);
    if (currentField) await currentField.press('Enter');
  }

  // Wait for login to complete
  log('Waiting for login to complete...');
  try {
    await page.waitForURL(/(?!.*Login)(?!.*UserValidate).*/, { timeout: 30000 });
    log('Navigation detected — left login page.');
  } catch {
    log('URL did not change. Checking state...');
  }

  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const currentUrl = page.url();
  if (currentUrl.includes('UserValidate') || currentUrl.includes('Login')) {
    log('Still on login page. Attempting direct navigation...');
    await page.goto(CONFIG.url, { waitUntil: 'networkidle', timeout: CONFIG.timeout });
    await page.waitForTimeout(3000);
  }

  log(`Logged in! URL: ${page.url()}`);
}

// ---------------------------------------------------------------------------
// FAST Bulk Data Extraction via Kendo Grid API
// ---------------------------------------------------------------------------

async function extractViaKendoDataSource(page, opts) {
  log('⚡ Using Kendo Grid dataSource API for FAST bulk extraction...');

  const result = await page.evaluate(({ maxRecords }) => {
    // Find the Kendo Grid widget
    const gridElement = document.querySelector('[data-role="grid"]') ||
                        document.querySelector('.k-grid');
    if (!gridElement) return { error: 'No Kendo Grid found on page' };

    const grid = $(gridElement).data('kendoGrid');
    if (!grid) return { error: 'Could not access Kendo Grid widget' };

    const dataSource = grid.dataSource;
    if (!dataSource) return { error: 'No dataSource on grid' };

    // Get total count and all data
    const total = dataSource.total();
    const currentPageSize = dataSource.pageSize();
    const data = dataSource.data();  // current page data
    const view = dataSource.view();  // current view

    // Get column info for dynamic extraction
    const columns = grid.columns.map(c => ({
      field: c.field,
      title: c.title || c.field,
    })).filter(c => c.field);

    return {
      total,
      currentPageSize,
      currentDataCount: data.length,
      columns,
      needsServerFetch: total > data.length,
    };
  }, { maxRecords: opts.maxRecords });

  if (result.error) {
    log(`Kendo API error: ${result.error}. Falling back to DOM scraping...`);
    return null;
  }

  log(`Grid info: ${result.total} total records, ${result.columns.length} columns`);
  log(`Columns: ${result.columns.map(c => c.field).join(', ')}`);

  // Strategy: Temporarily set page size to total (or maxRecords) to load everything at once
  const targetSize = opts.maxRecords > 0
    ? Math.min(opts.maxRecords, result.total)
    : result.total;

  log(`Loading ${targetSize} records in a single request (was ${result.currentPageSize}/page)...`);

  const allData = await page.evaluate(async ({ targetSize, columns }) => {
    const gridElement = document.querySelector('[data-role="grid"]') ||
                        document.querySelector('.k-grid');
    const grid = $(gridElement).data('kendoGrid');
    const dataSource = grid.dataSource;

    // Save original page size
    const originalPageSize = dataSource.pageSize();

    // Set page size to target to fetch all at once
    dataSource.pageSize(targetSize);

    // Wait for the data to load
    await new Promise((resolve) => {
      const handler = () => {
        dataSource.unbind('change', handler);
        resolve();
      };
      dataSource.bind('change', handler);

      // If data already loaded, resolve immediately
      if (dataSource.data().length >= targetSize || dataSource.data().length === dataSource.total()) {
        dataSource.unbind('change', handler);
        resolve();
      }
    });

    // Small delay to ensure data is ready
    await new Promise(r => setTimeout(r, 1000));

    // Extract all data using column fields
    const data = dataSource.data();
    const records = [];

    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const record = {};
      columns.forEach(col => {
        let val = item[col.field];
        // Handle Date objects
        if (val instanceof Date) {
          val = val.toLocaleString();
        }
        record[col.field] = val != null ? String(val) : '';
      });
      records.push(record);
    }

    // Restore original page size (cleanup)
    dataSource.pageSize(originalPageSize);

    return { records, total: dataSource.total() };
  }, { targetSize, columns: result.columns });

  log(`✅ Extracted ${allData.records.length} of ${allData.total} records in ONE request!`);

  return {
    records: allData.records,
    columns: result.columns,
    total: allData.total,
  };
}

// Fallback: DOM-based extraction with pagination (but with max page limit)
async function extractViaDOMPagination(page, opts) {
  log('Using DOM pagination fallback...');
  const allTransactions = [];
  let pageNum = 1;
  const maxPages = opts.maxRecords > 0 ? Math.ceil(opts.maxRecords / 20) : 500;

  while (pageNum <= maxPages) {
    const pageTransactions = await page.evaluate(() => {
      const rows = document.querySelectorAll('.k-grid-content table tbody tr');
      const txns = [];
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 7) {
          txns.push({
            timestamp: cells[0]?.textContent?.trim() || '',
            transactionId: cells[1]?.textContent?.trim() || '',
            transactionType: cells[2]?.textContent?.trim() || '',
            memberName: cells[3]?.textContent?.trim() || '',
            initiatingOrgId: cells[4]?.textContent?.trim() || '',
            duration: cells[5]?.textContent?.trim() || '',
            status: cells[6]?.textContent?.trim() || '',
          });
        }
      });
      return txns;
    });

    log(`  Page ${pageNum}: ${pageTransactions.length} transactions`);
    allTransactions.push(...pageTransactions);

    if (opts.maxRecords > 0 && allTransactions.length >= opts.maxRecords) {
      log(`Max records (${opts.maxRecords}) reached. Stopping.`);
      break;
    }

    // Check for Next button
    const nextButton = page.getByRole('button', { name: 'Next' });
    const hasNext = await nextButton.count() > 0 && !(await nextButton.isDisabled());
    if (!hasNext) break;

    await nextButton.click();
    await page.waitForTimeout(2000);
    pageNum++;
  }

  return {
    records: allTransactions,
    columns: [
      { field: 'timestamp', title: 'Timestamp' },
      { field: 'transactionId', title: 'Transaction ID' },
      { field: 'transactionType', title: 'Transaction Type' },
      { field: 'memberName', title: 'Member Name' },
      { field: 'initiatingOrgId', title: 'Initiating Org ID' },
      { field: 'duration', title: 'Duration' },
      { field: 'status', title: 'Status' },
    ],
    total: allTransactions.length,
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

function applyFilters(records, opts) {
  let filtered = [...records];
  const before = filtered.length;

  if (opts.filterStatus) {
    const s = opts.filterStatus.toLowerCase();
    filtered = filtered.filter(r => {
      const status = (r.status || r.Status || '').toLowerCase();
      return status.includes(s);
    });
    log(`Filter status="${opts.filterStatus}": ${before} → ${filtered.length}`);
  }

  if (opts.filterType) {
    const t = opts.filterType.toLowerCase();
    filtered = filtered.filter(r => {
      const type = (r.transactionType || r.TransactionType || '').toLowerCase();
      return type.includes(t);
    });
    log(`Filter type="${opts.filterType}": ${before} → ${filtered.length}`);
  }

  if (opts.filterMember) {
    const m = opts.filterMember.toLowerCase();
    filtered = filtered.filter(r => {
      const member = (r.memberName || r.MemberName || '').toLowerCase();
      return member.includes(m);
    });
    log(`Filter member="${opts.filterMember}": ${before} → ${filtered.length}`);
  }

  if (opts.filterOrg) {
    const o = opts.filterOrg.toLowerCase();
    filtered = filtered.filter(r => {
      const org = (r.initiatingOrgId || r.InitiatingOrgId || '').toLowerCase();
      return org.includes(o);
    });
    log(`Filter org="${opts.filterOrg}": ${before} → ${filtered.length}`);
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Export Formats
// ---------------------------------------------------------------------------

function exportCSV(records, columns, filePath) {
  const header = columns.map(c => `"${c.title || c.field}"`).join(',');
  const rows = records.map(r =>
    columns.map(c => `"${(r[c.field] || '').replace(/"/g, '""')}"`).join(',')
  );
  fs.writeFileSync(filePath, [header, ...rows].join('\n'));
  log(`📄 CSV saved: ${filePath} (${records.length} rows)`);
}

function exportJSON(records, meta, filePath) {
  const output = {
    metadata: {
      generatedAt: new Date().toISOString(),
      totalRecords: records.length,
      ...meta,
    },
    records,
  };
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
  log(`📄 JSON saved: ${filePath} (${records.length} records)`);
}

function exportTXTSummary(records, columns, meta, filePath) {
  const divider = '═'.repeat(80);
  const thinDivider = '─'.repeat(80);
  const now = new Date().toLocaleString();

  // Auto-detect field names (handles both camelCase and PascalCase from Kendo)
  const getField = (record, ...candidates) => {
    for (const c of candidates) {
      if (record[c] != null && record[c] !== '') return record[c];
    }
    return '';
  };

  // Group by transaction type
  const byType = {};
  records.forEach(r => {
    const type = getField(r, 'transactionType', 'TransactionType') || 'Unknown';
    if (!byType[type]) byType[type] = [];
    byType[type].push(r);
  });

  // Group by status
  const byStatus = {};
  records.forEach(r => {
    const status = getField(r, 'status', 'Status') || 'Unknown';
    if (!byStatus[status]) byStatus[status] = 0;
    byStatus[status]++;
  });

  // Group by member
  const byMember = {};
  records.forEach(r => {
    const member = getField(r, 'memberName', 'MemberName') || 'Unknown';
    if (!byMember[member]) byMember[member] = 0;
    byMember[member]++;
  });

  // Avg duration per type
  const avgDurationByType = {};
  Object.entries(byType).forEach(([type, txns]) => {
    const durations = txns
      .map(t => parseFloat(getField(t, 'duration', 'Duration')))
      .filter(d => !isNaN(d));
    avgDurationByType[type] = durations.length > 0
      ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)
      : 'N/A';
  });

  let s = '';
  s += `${divider}\n`;
  s += `  COMMONWELL ${meta.module.toUpperCase()} SUMMARY\n`;
  s += `${divider}\n`;
  s += `  Report Generated  : ${now}\n`;
  s += `  Date Range        : ${meta.dateFrom} → ${meta.dateTo}\n`;
  s += `  Total Records     : ${records.length}`;
  if (meta.totalOnServer) s += ` (of ${meta.totalOnServer} on server)`;
  s += '\n';
  if (meta.filters) s += `  Active Filters    : ${meta.filters}\n`;
  s += `${divider}\n\n`;

  // Status overview
  s += `  STATUS OVERVIEW\n`;
  s += `  ${thinDivider.substring(0, 50)}\n`;
  Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .forEach(([status, count]) => {
      const icon = status.toLowerCase().includes('success') ? '✅' : '❌';
      const pct = ((count / records.length) * 100).toFixed(1);
      s += `  ${icon} ${status.padEnd(25)} : ${String(count).padStart(6)} (${pct}%)\n`;
    });
  s += '\n';

  // Member breakdown
  if (Object.keys(byMember).length > 1 || !byMember['Unknown']) {
    s += `  MEMBER BREAKDOWN\n`;
    s += `  ${thinDivider.substring(0, 50)}\n`;
    Object.entries(byMember)
      .sort((a, b) => b[1] - a[1])
      .forEach(([member, count]) => {
        s += `  ${member.padEnd(30)} : ${String(count).padStart(6)} transactions\n`;
      });
    s += '\n';
  }

  // Transaction type breakdown
  s += `  TRANSACTION TYPE BREAKDOWN\n`;
  s += `  ${thinDivider.substring(0, 60)}\n`;
  Object.entries(byType)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([type, txns]) => {
      const successCount = txns.filter(t => {
        const st = getField(t, 'status', 'Status').toLowerCase();
        return st.includes('success') || st.includes('ok');
      }).length;
      const failCount = txns.length - successCount;
      const avgDur = avgDurationByType[type];

      s += `\n  📋 ${type}\n`;
      s += `     Count     : ${txns.length}\n`;
      s += `     Success   : ${successCount}  |  Failed: ${failCount}\n`;
      s += `     Avg Dur   : ${avgDur}ms\n`;

      // Auto-describe known types
      const descriptions = {
        CreatePatient: 'Patient records created in CommonWell network.',
        GetPatientByPatientId: 'Patient lookups by ID — verifying patient existence.',
        GetPatientLinks: 'Patient link queries across connected organizations.',
        GetDocument_R4: 'FHIR R4 document queries — searching clinical documents.',
        GetBinary_R4: 'FHIR R4 binary retrieval — downloading document content.',
        DeletePatientByPatientId: 'Patient records removed from CommonWell network.',
        UpdatePatient: 'Patient record updates in CommonWell network.',
        SearchPatient: 'Patient searches across the CommonWell network.',
      };
      const desc = descriptions[type] || `${type} operations performed.`;
      s += `     Summary   : ${desc}\n`;
    });

  s += `\n${divider}\n`;

  // Detailed list (show first 200 rows max in TXT to keep it readable)
  const showMax = Math.min(records.length, 200);
  s += `  DETAILED RECORDS (showing ${showMax} of ${records.length})\n`;
  s += `${divider}\n`;

  // Dynamic column headers from actual data
  const displayCols = columns.slice(0, 7); // max 7 columns in TXT
  s += '  ' + displayCols.map(c => (c.title || c.field).substring(0, 20).padEnd(22)).join('') + '\n';
  s += `  ${thinDivider}\n`;

  records.slice(0, showMax).forEach(r => {
    s += '  ' + displayCols.map(c =>
      (r[c.field] || '').substring(0, 20).padEnd(22)
    ).join('') + '\n';
  });

  if (records.length > showMax) {
    s += `\n  ... and ${records.length - showMax} more records (see CSV/JSON for full data)\n`;
  }

  s += `\n${divider}\n`;
  s += `  END OF REPORT\n`;
  s += `${divider}\n`;

  fs.writeFileSync(filePath, s);
  log(`📄 TXT summary saved: ${filePath}`);

  // Also print to console
  console.log('\n' + s);
}

// ---------------------------------------------------------------------------
// Module Runners
// ---------------------------------------------------------------------------

async function runTransactionLogs(page, opts) {
  log('=== Transaction Logs ===');

  // Navigate
  await page.goto(`${CONFIG.url}${MODULE_URLS.transactions}`, {
    waitUntil: 'networkidle',
    timeout: CONFIG.timeout,
  });
  await page.waitForTimeout(2000);
  log(`Page loaded: ${page.url()}`);

  // Set date range
  const { fromDate, toDate } = computeDateRange(opts);
  log(`Setting date range: ${fromDate.toLocaleDateString()} → ${toDate.toLocaleDateString()}...`);

  const dateResult = await page.evaluate(({ fromTs, toTs }) => {
    const fromInput = document.getElementById('txtFromDate');
    const toInput = document.getElementById('txtToDate');
    const fromWidget = $(fromInput).data('kendoDateTimePicker');
    const toWidget = $(toInput).data('kendoDateTimePicker');

    const fromDate = new Date(fromTs);
    const toDate = new Date(toTs);

    fromWidget.value(fromDate);
    fromWidget.trigger('change');
    toWidget.value(toDate);
    toWidget.trigger('change');

    const fmt = (d) => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
    return { from: fmt(fromDate), to: fmt(toDate) };
  }, { fromTs: fromDate.getTime(), toTs: toDate.getTime() });

  log(`Date range set: ${dateResult.from} → ${dateResult.to}`);

  // Click Search
  log('Clicking Search...');
  await page.getByTitle('Search', { exact: true }).click();

  // Wait for data
  let dataLoaded = false;
  for (let attempt = 1; attempt <= 15; attempt++) {
    await page.waitForTimeout(2000);
    const hasData = await page.evaluate(() => {
      const grid = document.querySelector('.k-grid-content table tbody');
      if (!grid) return false;
      const rows = grid.querySelectorAll('tr');
      if (rows.length === 0) return false;
      const firstCell = rows[0].querySelector('td');
      if (firstCell && firstCell.textContent.trim() === 'No data found') return false;
      return true;
    });
    if (hasData) {
      dataLoaded = true;
      log(`Data loaded (attempt ${attempt}).`);
      break;
    }
    log(`Waiting for data... (${attempt}/15)`);
  }

  if (!dataLoaded) {
    log('⚠️  No data found for the given date range.');
    return null;
  }

  // FAST extraction via Kendo API, fallback to DOM pagination
  let extracted = await extractViaKendoDataSource(page, opts);
  if (!extracted) {
    extracted = await extractViaDOMPagination(page, opts);
  }

  // Apply filters
  extracted.records = applyFilters(extracted.records, opts);

  return {
    ...extracted,
    meta: {
      module: 'Transaction Logs',
      dateFrom: dateResult.from,
      dateTo: dateResult.to,
      totalOnServer: extracted.total,
      filters: [
        opts.filterStatus && `status=${opts.filterStatus}`,
        opts.filterType && `type=${opts.filterType}`,
        opts.filterMember && `member=${opts.filterMember}`,
        opts.filterOrg && `org=${opts.filterOrg}`,
      ].filter(Boolean).join(', ') || 'none',
    },
  };
}

async function runAuditLogs(page, opts) {
  log('=== Audit Logs ===');

  await page.goto(`${CONFIG.url}${MODULE_URLS.audit}`, {
    waitUntil: 'networkidle',
    timeout: CONFIG.timeout,
  });
  await page.waitForTimeout(2000);
  log(`Page loaded: ${page.url()}`);

  // Set date range if date pickers exist
  const { fromDate, toDate } = computeDateRange(opts);

  try {
    await page.evaluate(({ fromTs, toTs }) => {
      const fromInput = document.getElementById('txtFromDate');
      const toInput = document.getElementById('txtToDate');
      if (fromInput && toInput) {
        const fromWidget = $(fromInput).data('kendoDateTimePicker');
        const toWidget = $(toInput).data('kendoDateTimePicker');
        if (fromWidget && toWidget) {
          fromWidget.value(new Date(fromTs));
          fromWidget.trigger('change');
          toWidget.value(new Date(toTs));
          toWidget.trigger('change');
        }
      }
    }, { fromTs: fromDate.getTime(), toTs: toDate.getTime() });
  } catch {
    log('Date pickers not found on Audit Logs page — using defaults.');
  }

  // Try clicking Search if it exists
  try {
    await page.getByTitle('Search', { exact: true }).click();
    await page.waitForTimeout(3000);
  } catch {
    log('No Search button — data may load automatically.');
    await page.waitForTimeout(3000);
  }

  // Extract data
  let extracted = await extractViaKendoDataSource(page, opts);
  if (!extracted) {
    extracted = await extractViaDOMPagination(page, opts);
  }

  extracted.records = applyFilters(extracted.records, opts);

  return {
    ...extracted,
    meta: {
      module: 'Audit Logs',
      dateFrom: fromDate.toLocaleDateString(),
      dateTo: toDate.toLocaleDateString(),
      totalOnServer: extracted.total,
      filters: 'none',
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Validate credentials
  if (!CONFIG.username || !CONFIG.password) {
    console.error('ERROR: Missing credentials. Set CW_USERNAME and CW_PASSWORD in .env');
    process.exit(1);
  }

  log('╔══════════════════════════════════════════════════════════════╗');
  log('║        CommonWell Automation — Flexible E2E Runner          ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  log(`Module     : ${opts.module}`);
  log(`Date range : ${opts.from || `${opts.days} days back`} → ${opts.to || 'today'}`);
  log(`Format     : ${opts.format}`);
  log(`Max records: ${opts.maxRecords || 'unlimited'}`);
  if (opts.filterStatus) log(`Filter     : status=${opts.filterStatus}`);
  if (opts.filterType)   log(`Filter     : type=${opts.filterType}`);
  if (opts.filterMember) log(`Filter     : member=${opts.filterMember}`);
  if (opts.filterOrg)    log(`Filter     : org=${opts.filterOrg}`);
  log('');

  let browser, context, page;

  try {
    // Launch browser
    const launchOpts = {
      headless: false,  // Always visible for OTP
      executablePath: EDGE_PATH,
      args: ['--disable-gpu'],
    };
    browser = await chromium.launch(launchOpts);

    // Try to reuse session if --skip-login
    if (opts.skipLogin && fs.existsSync(CONFIG.sessionFile)) {
      log('Reusing saved session...');
      context = await browser.newContext({ storageState: CONFIG.sessionFile });
    } else {
      context = await browser.newContext();
    }

    page = await context.newPage();

    // Login if needed
    if (!opts.skipLogin) {
      await loginWithCredentials(page);
      await handleMFA(page);
      await context.storageState({ path: CONFIG.sessionFile });
      log('Session saved.');
    } else {
      // Test if session is valid by navigating to portal
      await page.goto(CONFIG.url, { waitUntil: 'networkidle', timeout: CONFIG.timeout });
      if (page.url().includes('Login')) {
        log('Saved session expired. Running full login...');
        await loginWithCredentials(page);
        await handleMFA(page);
        await context.storageState({ path: CONFIG.sessionFile });
      }
    }

    // Run the selected module
    let result;
    switch (opts.module) {
      case 'transactions':
        result = await runTransactionLogs(page, opts);
        break;
      case 'audit':
        result = await runAuditLogs(page, opts);
        break;
      case 'organizations':
        log('Organizations module: navigating...');
        await page.goto(`${CONFIG.url}${MODULE_URLS.organizations}`, {
          waitUntil: 'networkidle',
          timeout: CONFIG.timeout,
        });
        result = await extractViaKendoDataSource(page, opts);
        if (result) {
          result.meta = { module: 'Organizations', dateFrom: 'N/A', dateTo: 'N/A' };
        }
        break;
      default:
        log(`Unknown module: ${opts.module}`);
        process.exit(1);
    }

    if (!result || result.records.length === 0) {
      log('No records to export.');
    } else {
      // Ensure output directory exists
      ensureDir(opts.outputDir);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const baseName = `commonwell-${opts.module}-${timestamp}`;

      // Export in requested formats
      const formats = opts.format === 'all' ? ['csv', 'json', 'txt'] : [opts.format];

      for (const fmt of formats) {
        const filePath = path.join(opts.outputDir, `${baseName}.${fmt}`);
        switch (fmt) {
          case 'csv':
            exportCSV(result.records, result.columns, filePath);
            break;
          case 'json':
            exportJSON(result.records, result.meta, filePath);
            break;
          case 'txt':
            exportTXTSummary(result.records, result.columns, result.meta, filePath);
            break;
          default:
            log(`Unknown format: ${fmt}`);
        }
      }

      // Screenshot
      const screenshotPath = path.join(opts.outputDir, `${baseName}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      log(`📸 Screenshot saved: ${screenshotPath}`);
    }

    log('');
    log('✅ All done!');

  } catch (error) {
    console.error('ERROR:', error.message);
    try {
      if (page && !page.isClosed()) {
        const errPath = path.join(opts.outputDir || __dirname, `error-${Date.now()}.png`);
        ensureDir(path.dirname(errPath));
        await page.screenshot({ path: errPath, fullPage: true });
        console.error(`Error screenshot: ${errPath}`);
      }
    } catch { /* browser closed */ }
    process.exit(1);
  } finally {
    try {
      if (browser) {
        await browser.close();
        log('Browser closed.');
      }
    } catch { /* already closed */ }
  }
})();
