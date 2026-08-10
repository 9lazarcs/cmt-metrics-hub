/**
 * src/automation/ibmAuth.ts
 *
 * IBM w3id SSO Authentication — shared module for CMT Metrics Hub.
 *
 * This is a self-contained copy of the Phase 1 battle-tested auth logic
 * (engagesupport-extractor/src/automation/auth.ts), adapted to:
 *   - Save the session to the configurable SESSION_SAVE_PATH (defaults to
 *     the Phase 1 extractor's session file so both apps share one session)
 *   - Not depend on Phase 1-specific types or EventEmitter wiring
 *   - Accept the target URL to navigate to for session validation
 *
 * IBM SSO NOTES (preserved from Phase 1):
 *   - IBM w3id Carbon SPA hides the username input via CSS animation in
 *     headless mode. waitFor({ state: 'visible' }) ALWAYS times out.
 *     Fix: wait for state: 'attached' then force-fill via page.evaluate()
 *     with the native React value setter + synthetic input/change events.
 *   - Submit/Next button MUST be clicked with { force: true } because the
 *     Carbon button may also be CSS-hidden during the animation frame.
 *   - MFA = IBM Verify push notification (passive wait — user approves on
 *     their phone). No TOTP, no SMS. Poll the URL every 2s until it returns
 *     to engage-support.ibm.com.
 */

import { BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const ENGAGE_SUPPORT_DOMAIN    = 'engage-support.ibm.com';
const ENGAGE_SUPPORT_URL       = 'https://engage-support.ibm.com';
// Validate against the grid URL (same page the extractor uses) — the root URL
// can return 200 with stale cookies while the actual app session has expired.
const ENGAGE_SUPPORT_GRID_URL  = 'https://engage-support.ibm.com/serviceRequestGrid';

const IBM_LOGIN_DOMAINS = [
  'login.w3.ibm.com',
  'w3id.sso.ibm.com',
  'w3.ibm.com',
  'idaas.iam.ibm.com',
];

function isIBMLoginPage(url: string): boolean {
  return IBM_LOGIN_DOMAINS.some((d) => url.includes(d));
}

// ─────────────────────────────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Restore cookies + localStorage from a saved Playwright storageState file.
 * Returns true if the session is still valid (browser lands on EngageSupport),
 * false if expired (browser redirects to IBM login page).
 */
export async function restoreAndValidateSession(
  context: BrowserContext,
  sessionPath: string
): Promise<boolean> {
  if (!fs.existsSync(sessionPath)) {
    logger.info(`[ibmAuth] No saved session at ${sessionPath}`);
    return false;
  }

  try {
    const raw          = fs.readFileSync(sessionPath, 'utf-8');
    const storageState = JSON.parse(raw) as {
      cookies?: unknown[];
      origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
    };

    await context.addCookies((storageState.cookies ?? []) as Parameters<BrowserContext['addCookies']>[0]);

    if (storageState.origins?.length) {
      await context.addInitScript(
        (origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>) => {
          for (const { origin, localStorage: items } of origins) {
            // @ts-ignore — runs in browser context at runtime
            if ((window as any).location.origin === origin) {
              for (const { name, value } of items) {
                // @ts-ignore
                (window as any).localStorage.setItem(name, value);
              }
            }
          }
        },
        storageState.origins
      );
    }

    logger.info(`[ibmAuth] Session restored from ${sessionPath} — validating...`);

    // Navigate to the grid URL — this is the first protected endpoint the
    // extractor hits, so it's the truest test of whether the session is alive.
    // The root URL can return 200 with a stale session; the grid forces a full
    // app-level token check and immediately redirects to IBM login if expired.
    const page = await context.newPage();
    await page.goto(ENGAGE_SUPPORT_GRID_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Allow up to 3s for any post-load redirects to settle before reading the URL
    await page.waitForTimeout(3_000);
    const finalUrl = page.url();
    await page.close();

    if (finalUrl.includes(ENGAGE_SUPPORT_DOMAIN)) {
      logger.info('[ibmAuth] Session is valid — skipping login.');
      return true;
    }

    logger.warn(`[ibmAuth] Session expired — grid redirected to: ${finalUrl}`);
    return false;
  } catch (err) {
    logger.error(`[ibmAuth] Session restore failed: ${(err as Error).message}`);
    return false;
  }
}

/** Persist the current context's cookies + localStorage to disk. */
export async function saveSession(context: BrowserContext, sessionPath: string): Promise<void> {
  const dir = path.dirname(sessionPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const state = await context.storageState();
  fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2), 'utf-8');
  logger.info(`[ibmAuth] Session saved → ${sessionPath}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core login flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reliably fills a (possibly CSS-hidden) input on the IBM Carbon login SPA.
 *
 * Tries three strategies in order:
 *   1. page.evaluate() with native HTMLInputElement value setter + React events
 *      — bypasses CSS visibility; works when Carbon hides inputs with transforms
 *   2. locator.fill({ force: true })
 *      — works if strategy 1 silently failed (e.g. selector found wrong element)
 *   3. locator.pressSequentially()
 *      — last resort; slow but always lands characters in the focused field
 *
 * After each strategy we verify the field is non-empty before moving on.
 */
async function forceFillInput(page: Page, selector: string, value: string): Promise<void> {
  const loc = page.locator(selector).first();

  // Strategy 1: native React setter via evaluate
  await page.evaluate(
    ({ sel, val }: { sel: string; val: string }) => {
      const el = document.querySelector<HTMLInputElement>(sel);
      if (!el) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, val);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { sel: selector, val: value }
  );

  // Verify the field actually has the value now
  const actual = await page.evaluate(
    (sel: string) => (document.querySelector<HTMLInputElement>(sel))?.value ?? '',
    selector
  );
  if (actual === value) return; // strategy 1 worked

  // Strategy 2: Playwright fill with force
  try {
    await loc.fill(value, { force: true } as Parameters<typeof loc.fill>[1]);
    const v2 = await page.evaluate(
      (sel: string) => (document.querySelector<HTMLInputElement>(sel))?.value ?? '',
      selector
    );
    if (v2 === value) return; // strategy 2 worked
  } catch { /* fall through */ }

  // Strategy 3: pressSequentially — clear then type char-by-char
  await loc.click({ force: true }).catch(() => {});
  await loc.selectText().catch(() => {});
  await page.keyboard.press('Control+a').catch(() => {});
  await page.keyboard.press('Delete').catch(() => {});
  await loc.pressSequentially(value, { delay: 30 });
}

/**
 * Performs a full IBM w3id SSO login on the given page.
 *
 * IBM SSO NOTE — input filling strategy:
 *   The IBM w3id Carbon SPA renders the email + password inputs in the DOM
 *   immediately but hides them with CSS transform/opacity animations.
 *   Playwright's .fill() and .click() both respect visibility by default and
 *   will time out. We must:
 *     1. Wait for state: 'attached' (element in DOM, not necessarily visible)
 *     2. Use page.evaluate() to call the native HTMLInputElement value setter,
 *        bypassing React's controlled-component interception
 *     3. Dispatch synthetic 'input' and 'change' events so React state updates
 *     4. Click buttons with { force: true } to bypass pointer-events: none
 */
async function performLogin(page: Page, sessionPath: string, context: BrowserContext): Promise<void> {
  const email    = process.env.IBM_EMAIL    ?? '';
  const password = process.env.IBM_PASSWORD ?? '';

  if (!email)    throw new Error('IBM_EMAIL is not set in .env — required for fresh IBM SSO login.');
  if (!password) throw new Error('IBM_PASSWORD is not set in .env — required for fresh IBM SSO login.');

  // IBM SSO NOTE: MFA_TIMEOUT_SECONDS controls two things:
  //   1. How long we poll for IBM Verify push approval (the user taps Approve on phone)
  //   2. Indirectly sets the patience for slow IBM SSO page loads (pre-login timeouts
  //      are derived from this value so everything scales together)
  // Default: 180s (3 minutes) — gives the user time to:
  //   - See the login page render fully
  //   - Enter password if needed (sometimes the Carbon SPA is slow)
  //   - Receive and approve the IBM Verify push notification
  const MFA_TIMEOUT_MS = parseInt(process.env.MFA_TIMEOUT_SECONDS ?? '180', 10) * 1000;

  // Pre-login step timeouts — scale with MFA_TIMEOUT_SECONDS so a single
  // env var controls all patience levels. Capped at sensible maximums.
  const PAGE_LOAD_MS   = Math.min(MFA_TIMEOUT_MS / 3, 60_000);  // max 60s for page loads
  const SELECTOR_MS    = Math.min(MFA_TIMEOUT_MS / 4, 45_000);  // max 45s for element waits
  const NETWORKIDLE_MS = Math.min(MFA_TIMEOUT_MS / 6, 30_000);  // max 30s for network idle

  // ── 1. Navigate to EngageSupport — IBM SSO will redirect to w3id ──────────
  logger.info('[ibmAuth] Navigating to EngageSupport to trigger IBM SSO redirect...');
  await page.goto(ENGAGE_SUPPORT_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_MS });

  // Wait for redirect to IBM login domain
  try {
    await page.waitForFunction(
      (domains: string[]) => domains.some((d) => window.location.href.includes(d)),
      IBM_LOGIN_DOMAINS,
      { timeout: SELECTOR_MS }
    );
  } catch {
    // May already be on EngageSupport (edge case: session became valid mid-flight)
    if (page.url().includes(ENGAGE_SUPPORT_DOMAIN)) {
      logger.info('[ibmAuth] Already on EngageSupport — no login needed.');
      return;
    }
    throw new Error(`IBM SSO redirect did not occur. Current URL: ${page.url()}`);
  }

  // Wait for the Carbon SPA login form to finish rendering.
  // IBM SSO NOTE: networkidle can take 15–25s on a slow VPN/intranet connection.
  // We wait the full NETWORKIDLE_MS before proceeding so the form inputs are
  // guaranteed to be in the DOM when we start searching for them.
  await page.waitForLoadState('networkidle', { timeout: NETWORKIDLE_MS }).catch(() => {
    logger.warn('[ibmAuth] networkidle not reached — proceeding anyway (form may still be loading)');
  });
  logger.info(`[ibmAuth] On IBM login page: ${page.url()}`);

  // ── 2. Fill email ──────────────────────────────────────────────────────────
  // IBM SSO NOTE: Try selectors in priority order. Use 'attached' state (not
  // 'visible') because Carbon hides the input during its entry animation.
  const emailSelectors = [
    '#user-name-input',
    'input[name="username"]',
    'input[name="j_username"]',
    'input[id="j_username"]',
    'input[type="email"]',
    'input[id="username"]',
    '#username',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'form input:not([type="hidden"]):not([type="password"]):not([type="submit"])',
  ];

  let emailSelector = '';
  // First pass: quick scan (5s each) to find whichever selector is present
  for (const sel of emailSelectors) {
    try {
      await page.locator(sel).first().waitFor({ state: 'attached', timeout: 5_000 });
      emailSelector = sel;
      logger.info(`[ibmAuth] Found email input: ${sel}`);
      break;
    } catch { /* try next */ }
  }
  // Second pass: if nothing found yet, give the page more time then try once more
  if (!emailSelector) {
    logger.warn('[ibmAuth] Email input not found on quick scan — waiting for page to settle...');
    await page.waitForTimeout(5_000);
    for (const sel of emailSelectors) {
      try {
        await page.locator(sel).first().waitFor({ state: 'attached', timeout: SELECTOR_MS });
        emailSelector = sel;
        logger.info(`[ibmAuth] Found email input (slow): ${sel}`);
        break;
      } catch { /* try next */ }
    }
  }

  if (!emailSelector) {
    // Dump visible inputs to help diagnose
    const inputs = await page.$$eval('input', (els) =>
      els.map((el) => ({ type: el.type, name: el.name, id: el.id }))
    );
    throw new Error(`Could not find IBM login email input. Inputs found: ${JSON.stringify(inputs)}`);
  }

  // Force-fill the email — try three strategies in order so changes to the
  // IBM Carbon SPA structure don't silently leave the field empty.
  await forceFillInput(page, emailSelector, email);
  logger.info('[ibmAuth] Email entered.');
  await page.waitForTimeout(800);

  // ── 3. Check if password field is already on this page ────────────────────
  const passwordSelectors = [
    '#password',
    'input[name="j_password"]',
    'input[id="j_password"]',
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
  ];

  let passwordSelector = '';
  for (const sel of passwordSelectors) {
    const exists = await page.locator(sel).first().count().then((c) => c > 0).catch(() => false);
    if (exists) { passwordSelector = sel; logger.info(`[ibmAuth] Password field on same page: ${sel}`); break; }
  }

  if (!passwordSelector) {
    // ── 4. Click Next/Continue to advance to password page ──────────────────
    // IBM SSO NOTE: Force: true is REQUIRED — the Carbon button is often behind
    // a CSS overlay during the animation and clicks are rejected without it.
    logger.info('[ibmAuth] Password not on same page — clicking Next/Continue...');
    const nextSelectors = [
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Next")',
      'button:has-text("Continue")',
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      '.ds-btn',
      '[class*="ds-btn"]',
    ];
    for (const sel of nextSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0) {
          await btn.click({ force: true });
          logger.info(`[ibmAuth] Clicked Next via: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }

    // Wait for password field to appear — quick scan first
    for (const sel of passwordSelectors) {
      try {
        await page.locator(sel).first().waitFor({ state: 'attached', timeout: 5_000 });
        passwordSelector = sel;
        logger.info(`[ibmAuth] Password field appeared after Next: ${sel}`);
        break;
      } catch { /* try next */ }
    }
    if (!passwordSelector) {
      await page.waitForTimeout(3_000);
      for (const sel of passwordSelectors) {
        try {
          await page.locator(sel).first().waitFor({ state: 'attached', timeout: SELECTOR_MS });
          passwordSelector = sel;
          logger.info(`[ibmAuth] Password field appeared after Next (slow): ${sel}`);
          break;
        } catch { /* try next */ }
      }
    }
  }

  if (!passwordSelector) throw new Error('Could not find password input after clicking Next.');

  // ── 5. Fill password ───────────────────────────────────────────────────────
  logger.info('[ibmAuth] Entering password... (value never logged)');
  await forceFillInput(page, passwordSelector, password);
  await page.waitForTimeout(500);

  // ── 6. Submit credentials ──────────────────────────────────────────────────
  // IBM SSO NOTE: force: true required for the same CSS visibility reasons.
  const submitSelectors = [
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
    'button:has-text("Continue")',
    '.ds-btn[type="submit"]',
    '[class*="ds-btn"]',
  ];
  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0) {
        await btn.click({ force: true });
        logger.info(`[ibmAuth] Submitted via: ${sel}`);
        submitted = true;
        break;
      }
    } catch { /* try next */ }
  }
  if (!submitted) {
    logger.info('[ibmAuth] No submit button matched — pressing Enter on password field.');
    await page.locator(passwordSelector).first().press('Enter');
  }

  logger.info('[ibmAuth] Credentials submitted — waiting for post-login state...');
  // Give extra time here — IBM SSO does multiple redirects after submit and
  // the final landing page can take 10–20s on a slow VPN connection.
  await page.waitForLoadState('domcontentloaded', { timeout: PAGE_LOAD_MS }).catch(() => {});
  await page.waitForTimeout(2_000);

  const postUrl  = page.url();
  const bodyText = ((await page.textContent('body').catch(() => '')) ?? '').toLowerCase();
  logger.info(`[ibmAuth] Post-submit URL: ${postUrl}`);

  // Check for credential errors
  const credErrors = ['incorrect password','invalid password','invalid credentials',
    'account locked','too many failed','authentication failed','we couldn\'t sign you in'];
  if (credErrors.some((e) => bodyText.includes(e))) {
    throw new Error('IBM w3id login failed: incorrect credentials or account locked. Check IBM_PASSWORD in .env.');
  }

  // Already back on EngageSupport (MFA-less auth)
  if (postUrl.includes(ENGAGE_SUPPORT_DOMAIN)) {
    logger.info('[ibmAuth] Login succeeded without MFA push — waiting for post-login redirects to settle...');
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    await saveSession(context, sessionPath);
    return;
  }

  // ── 7. IBM Verify MFA — passive poll ──────────────────────────────────────
  // IBM SSO NOTE: IBM Verify sends a push notification to the user's registered
  // mobile device. The automation waits passively — the user taps "Approve"
  // and the browser redirects automatically. No code entry required.
  logger.info(`[ibmAuth] IBM Verify push expected — polling for approval (up to ${MFA_TIMEOUT_MS / 1000}s)...`);

  const pollIntervalMs = 2_000;
  const maxAttempts    = Math.ceil(MFA_TIMEOUT_MS / pollIntervalMs);

  logger.info(
    `[ibmAuth] 📱 ACTION REQUIRED: Open IBM Verify on your phone and tap "Approve". ` +
    `Waiting up to ${MFA_TIMEOUT_MS / 1000}s...`
  );

  for (let i = 0; i < maxAttempts; i++) {
    await page.waitForTimeout(pollIntervalMs);
    const currentUrl = page.url();

    if (currentUrl.includes(ENGAGE_SUPPORT_DOMAIN)) {
      logger.info(`[ibmAuth] ✅ IBM Verify approved after ${Math.round(((i + 1) * pollIntervalMs) / 1000)}s — waiting for post-MFA redirects to settle...`);

      // IBM SSO NOTE: After the MFA push is approved, IBM's IdP performs several
      // additional token-exchange redirects (SAML assertion, cookie writes, etc.)
      // even after the URL first shows engage-support.ibm.com.  Closing the page
      // or saving the session too early captures incomplete cookies, which causes
      // the very next navigation to get kicked back to the IBM login page.
      //
      // Fix: wait for the page to reach network-idle (all redirects + XHR done)
      // then give an extra 2 s for cookie writes before saving the session.
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {
        logger.warn('[ibmAuth] networkidle not reached after MFA approval — proceeding anyway.');
      });
      // Extra settle time for IBM token-exchange cookie writes
      await page.waitForTimeout(2_000);
      logger.info(`[ibmAuth] Post-MFA settle complete. Final URL: ${page.url()}`);

      await saveSession(context, sessionPath);
      return;
    }

    // Log countdown every 15 seconds so user can see time remaining
    const elapsedS   = Math.round(((i + 1) * pollIntervalMs) / 1000);
    const remainingS = Math.round((MFA_TIMEOUT_MS - (i + 1) * pollIntervalMs) / 1000);
    if (elapsedS % 15 === 0) {
      logger.info(`[ibmAuth] ⏳ Waiting for IBM Verify approval... ${elapsedS}s elapsed, ${remainingS}s remaining.`);
    }
  }

  throw new Error(
    `IBM Verify MFA timed out after ${MFA_TIMEOUT_MS / 1000}s. ` +
    `Make sure you approved the push notification on your IBM Verify app, then try again.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure the browser context is authenticated to IBM EngageSupport.
 *
 * Flow:
 *   1. Try to restore + validate the saved session from sessionPath
 *   2. If expired → perform full IBM w3id SSO login with MFA polling
 *   3. Save the new session to sessionPath on success
 *
 * Throws on credential error or MFA timeout.
 */
export async function ensureAuthenticated(
  context: BrowserContext,
  sessionPath: string
): Promise<void> {
  // Fast path: reuse saved session
  const sessionValid = await restoreAndValidateSession(context, sessionPath);
  if (sessionValid) return;

  // Session expired or not found — perform fresh login
  logger.info('[ibmAuth] Performing fresh IBM w3id SSO login...');

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    logger.info(`[ibmAuth] Login attempt ${attempt}/${MAX_RETRIES}`);
    const page = await context.newPage();
    try {
      await performLogin(page, sessionPath, context);
      // Wait a moment after closing the login page so the context's cookie jar
      // is fully written before the caller opens its first real navigation page.
      await page.waitForTimeout(1_000);
      await page.close();
      logger.info('[ibmAuth] Login page closed — context cookies ready.');
      return; // success
    } catch (err) {
      const msg = (err as Error).message;
      logger.error(`[ibmAuth] Attempt ${attempt} failed: ${msg}`);
      try { await page.close(); } catch { /* ignore */ }

      // Don't retry credential errors or MFA timeouts — user action required
      if (msg.includes('incorrect credentials') || msg.includes('not set in .env') || msg.includes('MFA timed out')) {
        throw err;
      }
      if (attempt === MAX_RETRIES) throw err;

      logger.info('[ibmAuth] Retrying in 3s...');
      await new Promise<void>((r) => setTimeout(r, 3_000));
    }
  }
}
