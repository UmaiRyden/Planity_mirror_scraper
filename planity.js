/**
 * planity.js — Planity Pro scraping module
 * Handles login and appointment extraction from pro.planity.com
 *
 * Based on observed UI:
 *   - Login: email placeholder "Adresse email", password placeholder "Mot de passe", button "Se connecter"
 *   - Diary: 3 columns headed "Seventy", "Brayan", "Maely"
 *   - Appointment text format: "HH:MM - HH:MM  ClientName  ServiceName"
 */

const fs = require('fs');

const PLANITY_URL = 'https://pro.planity.com';

// Known barber column headers — must match exactly what Planity shows
const KNOWN_BARBERS = ['Seventy', 'Brayan', 'Maely'];

// ── Login ─────────────────────────────────────────────────────────────────────

/**
 * Login to Planity Pro.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} email
 * @param {string} password
 */
async function login(page, email, password) {
  console.log('[planity] Navigating to pro.planity.com...');

  await page.goto(PLANITY_URL, { waitUntil: 'networkidle2', timeout: 40000 });

  // ── Step 1: Dismiss Didomi cookie popup BEFORE touching the form ────────────
  try {
    await page.waitForSelector('#didomi-notice-agree-button', { visible: true, timeout: 6000 });
    await page.click('#didomi-notice-agree-button');
    console.log('[planity] Cookie consent dismissed.');
    await new Promise((r) => setTimeout(r, 1000));
  } catch (_) {
    console.log('[planity] No cookie popup found.');
  }

  // Screenshot after cookie dismissal
  await page.screenshot({ path: 'debug_login.png', fullPage: true });
  fs.writeFileSync('debug_login.html', await page.content());
  console.log('[planity] Login page snapshot saved.');

  // ── Step 2: Wait for the login form ────────────────────────────────────────
  await page.waitForSelector('[data-testid="sign-in-email-input"]', { timeout: 15000 });

  // ── Step 3: Fill inputs using React's native value setter ──────────────────
  // Planity uses React controlled inputs. Plain keyboard events work, but we
  // must ensure React's onChange fires. We use the native InputValueSetter trick.
  await page.evaluate((emailVal, passwordVal) => {
    function fillInput(testId, value) {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      if (!el) return false;
      // Use native setter to bypass React's controlled-value guard
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeSetter.call(el, value);
      // Dispatch input + change events so React updates its state
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    fillInput('sign-in-email-input',    emailVal);
    fillInput('sign-in-password-input', passwordVal);
  }, email, password);

  console.log('[planity] Email + password filled via React setter.');
  await page.screenshot({ path: 'debug_login_filled.png' });

  // ── Step 4: Submit — focus the Pressable div and press Enter ───────────────
  // The submit is a <div tabindex="0" data-testid="sign-in-submit">.
  // Pressing Enter on a focused tabindex="0" div triggers its click handler.
  await page.focus('[data-testid="sign-in-submit"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    page.keyboard.press('Enter'),
  ]);
  console.log('[planity] Submitted login form.');

  // Give the SPA time to render the dashboard
  await new Promise((r) => setTimeout(r, 4000));

  const currentUrl = page.url();
  console.log('[planity] Post-login URL:', currentUrl);
  await page.screenshot({ path: 'debug_post_login.png', fullPage: true });

  // If still showing the login form, login failed
  const stillOnLogin = await page.$('[data-testid="sign-in-submit"]').then(
    (el) => !!el, () => false
  );
  if (stillOnLogin) {
    fs.writeFileSync('debug_post_login.html', await page.content());
    throw new Error('[planity] Login failed — sign-in form still visible. Check debug_post_login.png');
  }

  console.log('[planity] Login successful.');
}

// ── Session check ─────────────────────────────────────────────────────────────

async function isSessionExpired(page) {
  // Only use URL — Planity SPA keeps the login form in the DOM even when logged in
  const url = page.url();
  return url.includes('/login') || url.includes('/sign-in');
}

// ── Diary scraping ────────────────────────────────────────────────────────────

/**
 * Navigate to today's Diary view and scrape all visible appointments.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array>}
 */
async function getTodayAppointments(page) {
  console.log('[planity] Loading diary...');

  // The diary is the default view after login. Navigate to root which redirects to diary.
  const currentUrl = page.url();
  if (!currentUrl.startsWith(PLANITY_URL) || await isSessionExpired(page)) {
    throw new Error('SESSION_EXPIRED');
  }

  // If not already on the main app, navigate there
  if (!currentUrl.startsWith(PLANITY_URL)) {
    await page.goto(PLANITY_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Click the "Diary" tab if it's visible (sometimes we land on another tab)
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('a, button, [role="tab"]'));
    const diaryTab = tabs.find((t) => /diary|agenda|journal/i.test(t.textContent));
    if (diaryTab) diaryTab.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // Re-check session
  if (await isSessionExpired(page)) {
    throw new Error('SESSION_EXPIRED');
  }

  // Wait for appointment blocks to appear (up to 20s)
  await page.waitForFunction(
    () => {
      const all = Array.from(document.querySelectorAll('*'));
      return all.some((el) =>
        el.children.length === 0 &&
        /\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/.test(el.textContent)
      );
    },
    { timeout: 20000 }
  ).catch(() => {
    console.warn('[planity] Timed out waiting for time patterns — proceeding anyway.');
  });

  // Debug snapshot — taken AFTER content loads
  if (process.env.PLANITY_DEBUG === 'true') {
    await page.screenshot({ path: 'debug_diary.png', fullPage: true });
    fs.writeFileSync('debug_diary.html', await page.content());
    console.log('[planity] Diary snapshot saved (debug_diary.png / debug_diary.html).');
  }

  // ── Extract all data from the page ──────────────────────────────────────────
  const appointments = await page.evaluate((knownBarbers) => {
    const results = [];

    // Today in Paris timezone (YYYY-MM-DD)
    const now = new Date();
    const month = now.getMonth() + 1;
    const parisOffset = (month >= 4 && month <= 10) ? 2 : 1;
    const parisNow = new Date(now.getTime() + parisOffset * 3600 * 1000);
    const todayStr = parisNow.toISOString().slice(0, 10);

    // ── Helpers ───────────────────────────────────────────────────────────────

    const TIME_RANGE_RE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;

    function buildISO(dateStr, h, m) {
      const mo = parseInt(dateStr.slice(5, 7), 10);
      const off = (mo >= 4 && mo <= 10) ? 2 : 1;
      const d = new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`);
      return new Date(d.getTime() - off * 3600 * 1000).toISOString();
    }

    function stableId(dateStr, sh, sm, clientName, barberName) {
      const raw = `${dateStr}|${sh}:${sm}|${clientName}|${barberName}`;
      let hash = 0;
      for (let i = 0; i < raw.length; i++) {
        hash = (hash << 5) - hash + raw.charCodeAt(i);
        hash |= 0;
      }
      return `p_${Math.abs(hash).toString(16)}_${dateStr}`;
    }

    // ── Column index detection (no getBoundingClientRect needed) ─────────────
    // The calendar renders 3 column bodies as flex siblings of a time ruler.
    // The time ruler has inline style width:52px.
    // Walk up from an appointment element until we find a parent whose parent
    // also contains the time ruler — that parent IS the column body.
    // Return its 0-based index among the non-ruler siblings → maps to barber.
    function getColumnIndex(el) {
      let current = el;
      for (let depth = 0; depth < 25; depth++) {
        const parent = current.parentElement;
        if (!parent) return -1;
        const siblings = Array.from(parent.children);
        // Check if any sibling (not current) is the time-ruler (width:52px)
        const hasRuler = siblings.some(s =>
          s !== current &&
          s.style && s.style.width === '52px'
        );
        if (hasRuler) {
          // parent is the flex grid; current is one column body
          const columns = siblings.filter(s => !(s.style && s.style.width === '52px'));
          return columns.indexOf(current);
        }
        current = parent;
      }
      return -1;
    }

    // ── 1. Find all time spans (class css-17xliyc) ────────────────────────────
    // Each time span has sibling css-8g9poh spans: [clientName, service, optBarber]
    const timeSpans = Array.from(document.querySelectorAll('span.css-17xliyc'));
    const seen = new Set();

    for (const timeSpan of timeSpans) {
      const timeText = timeSpan.textContent.trim();
      const match = timeText.match(TIME_RANGE_RE);
      if (!match) continue;

      const [, sh, sm, eh, em] = match;

      // Collect sibling css-8g9poh spans
      const parent = timeSpan.parentElement;
      if (!parent) continue;

      const contentSpans = Array.from(parent.querySelectorAll('span.css-8g9poh'))
        .map(s => s.textContent.trim())
        .filter(Boolean);

      if (contentSpans.length === 0) continue; // skip blocked-time slots

      const clientName = contentSpans[0];
      if (!clientName || clientName === 'pause midi') continue; // skip lunch breaks

      const service = contentSpans[1] || 'Unknown';

      // ── Barber detection ──────────────────────────────────────────────────
      // 1. Check for "X choisi(e)" pattern in spans (online bookings)
      let barberName = null;
      const choisiSpan = contentSpans.find(s => s.includes('choisi'));
      if (choisiSpan) {
        barberName = knownBarbers.find(b => choisiSpan.startsWith(b)) || null;
      }

      // 2. Fall back to column position (manual bookings)
      if (!barberName) {
        const colIdx = getColumnIndex(timeSpan);
        barberName = knownBarbers[colIdx] || 'Unknown';
      }

      // ── Dedup by clientName + time ────────────────────────────────────────
      const key = `${sh}:${sm}|${clientName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const planityId = stableId(todayStr, sh, sm, clientName, barberName);

      results.push({
        planity_id:       planityId,
        client_name:      clientName,
        service:          service.replace(/&amp;/g, '&'),
        start_time:       buildISO(todayStr, parseInt(sh), parseInt(sm)),
        end_time:         buildISO(todayStr, parseInt(eh), parseInt(em)),
        barber_name:      barberName,
        appointment_date: todayStr,
      });
    }

    return results;
  }, KNOWN_BARBERS);

  console.log(`[planity] Scraped ${appointments.length} appointment(s) for today.`);
  return appointments;
}

module.exports = { login, getTodayAppointments, isSessionExpired };
