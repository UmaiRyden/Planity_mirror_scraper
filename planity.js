/**
 * planity.js — Planity Pro scraping module
 * Handles login and appointment extraction from pro.planity.com
 *
 * Based on observed UI:
 *   - Login: email placeholder "Adresse email", password placeholder "Mot de passe", button "Se connecter"
 *   - Diary: 3 columns headed "Seventy", "Brayan", "Maely"
 *   - Column headers have stable DOM IDs: header-calendar-0, header-calendar-1, header-calendar-2
 *   - Appointment text format: "HH:MM - HH:MM  ClientName  ServiceName"
 */

const fs = require('fs');
const { DateTime } = require('luxon');

const PLANITY_URL = 'https://pro.planity.com';

// Canonical barber names — must match exactly what the frontend expects.
// Used to normalise column header text regardless of case or surrounding words
// (e.g. "SEVENTY" → "Seventy", "BARCOLA (Maely)" → "Maely").
const KNOWN_BARBERS = ['Seventy', 'Brayan', 'Maely'];

// ── Timezone helper (Node.js / luxon — DST-aware) ─────────────────────────────

/**
 * Convert a Paris-local "HH:mm" string on a given date to a UTC ISO string.
 * Uses luxon so DST transitions (e.g. March 30 = UTC+2, not UTC+1) are correct.
 *
 * @param {string} dateStr  YYYY-MM-DD (Europe/Paris date)
 * @param {string} timeStr  HH:mm exactly as shown on Planity (e.g. "09:30")
 * @returns {string}        ISO 8601 UTC string
 */
function parisTimeToUTC(dateStr, timeStr) {
  return DateTime.fromFormat(
    `${dateStr} ${timeStr}`,
    'yyyy-MM-dd HH:mm',
    { zone: 'Europe/Paris' }
  ).toUTC().toISO();
}

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

  await page.goto(PLANITY_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });

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
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      ).set;
      nativeSetter.call(el, value);
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
  await page.focus('[data-testid="sign-in-submit"]');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    page.keyboard.press('Enter'),
  ]);
  console.log('[planity] Submitted login form.');

  await new Promise((r) => setTimeout(r, 4000));

  const currentUrl = page.url();
  console.log('[planity] Post-login URL:', currentUrl);
  await page.screenshot({ path: 'debug_post_login.png', fullPage: true });

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

  const currentUrl = page.url();
  if (!currentUrl.startsWith(PLANITY_URL) || await isSessionExpired(page)) {
    throw new Error('SESSION_EXPIRED');
  }

  if (!currentUrl.startsWith(PLANITY_URL)) {
    await page.goto(PLANITY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Click the "Diary" tab if visible
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('a, button, [role="tab"]'));
    const diaryTab = tabs.find((t) => /diary|agenda|journal/i.test(t.textContent));
    if (diaryTab) diaryTab.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // Navigate to TODAY in the diary — Planity may still be showing a previous date
  // if the barber was browsing another day, or if the scraper restarted mid-week.
  // Try clicking the "Aujourd'hui" / "Today" button to reset the calendar view.
  const clickedToday = await page.evaluate(() => {
    // Planity renders the "Aujourd'hui" button as a plain div, not a <button>
    const all = Array.from(document.querySelectorAll('div, button, a, [role="button"]'));
    const todayBtn = all.find((el) =>
      el.textContent.trim() === "Aujourd'hui"
    );
    if (todayBtn) { todayBtn.click(); return true; }
    return false;
  });
  if (clickedToday) {
    console.log('[planity] Clicked "today" button to reset diary to current date.');
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    console.warn('[planity] "Today" button not found — diary may be showing a different date.');
  }

  if (await isSessionExpired(page)) {
    throw new Error('SESSION_EXPIRED');
  }

  // Wait for BOTH column headers AND appointment time spans to be present.
  // Previously only waited for a time span — if header-calendar-0 wasn't loaded
  // yet, buildColumnBounds returned [] and every appointment got barberName='Unknown',
  // producing a different planity_id hash each run → DELETE+INSERT every 30 s.
  await page.waitForFunction(
    () => {
      const headersReady = document.getElementById('header-calendar-0') !== null;
      const timesReady   = Array.from(document.querySelectorAll('*')).some((el) =>
        el.children.length === 0 &&
        /\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/.test(el.textContent)
      );
      return headersReady && timesReady;
    },
    { timeout: 20000 }
  ).catch(() => {
    console.warn('[planity] Timed out waiting for diary to fully load — proceeding anyway.');
  });

  // Extra settle time: React may still be rendering late appointments
  await new Promise((r) => setTimeout(r, 1500));

  // Always save a debug snapshot so missing-appointment issues can be diagnosed
  await page.screenshot({ path: 'debug_diary.png', fullPage: true });
  fs.writeFileSync('debug_diary.html', await page.content());
  console.log('[planity] Diary snapshot saved (debug_diary.png / debug_diary.html).');

  // Today in Europe/Paris — computed in Node.js (luxon) so DST is handled correctly.
  // Passed into page.evaluate as a parameter (page context has no access to luxon).
  const todayStr = DateTime.now().setZone('Europe/Paris').toISODate();

  // ── Extract raw appointment data from the page ────────────────────────────
  //
  // Key findings from the real Planity DOM (debug_diary.html):
  //
  //  1. Column headers have stable IDs: header-calendar-0, header-calendar-1, …
  //     Their text content is the barber name ("Seventy", "Brayan", "Maely").
  //
  //  2. Each appointment div contains:
  //       span.css-17xliyc  → "09:30 - 10:00 "  (time range)
  //       span.css-8g9poh   → "Yohan Thomas "    (client name)
  //       span.css-8g9poh   → " Coupe étudiant " (service)
  //       span.css-8g9poh   → "Seventy choisi(e)"  (ONLINE bookings only)
  //     Manual bookings have only 2 css-8g9poh spans (no barber span).
  //
  //  3. Because most appointments are manual (no choisi span), column position
  //     is the only reliable barber signal. getBoundingClientRect() on the
  //     appointment element returns its absolute screen X, which maps to a column.
  //
  // Time strings are returned as-is from the page; UTC conversion uses luxon
  // outside evaluate so DST is handled correctly.

  const rawAppointments = await page.evaluate((todayStr, knownBarbers) => {
    const results = [];
    const TIME_RANGE_RE = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/;

    // barberName is intentionally excluded from the hash.
    // If column detection changes between runs (e.g. headers load late), the
    // planity_id stays the same and we do an UPDATE instead of DELETE+INSERT,
    // so the card refreshes in-place rather than disappearing from the mirror.
    function stableId(dateStr, startTime, clientName) {
      const raw = `${dateStr}|${startTime}|${clientName}`;
      let hash = 0;
      for (let i = 0; i < raw.length; i++) {
        hash = (hash << 5) - hash + raw.charCodeAt(i);
        hash |= 0;
      }
      return `p_${Math.abs(hash).toString(16)}_${dateStr}`;
    }

    // ── Column detection via header-calendar-N IDs ────────────────────────────
    // Planity renders column headers with id="header-calendar-0", "…-1", "…-2".
    // Each header is a <span> inside a positioned div that spans exactly one
    // column. getBoundingClientRect on that div gives the true column boundaries.
    //
    // The header text may be all-caps ("SEVENTY") or contain extra words
    // ("BARCOLA (Maely)"). We normalise against knownBarbers so the stored
    // barber_name always matches the canonical casing the frontend expects.
    function buildColumnBounds(knownBarbers) {
      const columns = [];
      for (let i = 0; i < 10; i++) {
        const header = document.getElementById(`header-calendar-${i}`);
        if (!header) break;
        const raw = header.textContent.trim();
        const lower = raw.toLowerCase();
        // 1. Exact case-insensitive match ("SEVENTY" → "Seventy")
        // 2. Substring match ("BARCOLA (Maely)" contains "maely" → "Maely")
        const canonical =
          knownBarbers.find((b) => b.toLowerCase() === lower) ||
          knownBarbers.find((b) => lower.includes(b.toLowerCase())) ||
          raw; // unknown barber — use raw text as fallback
        // header.parentElement is the positioned div with the column's width/left
        const rect = header.parentElement.getBoundingClientRect();
        columns.push({
          name:    canonical,
          left:    rect.left,
          right:   rect.right,
          centerX: rect.left + rect.width / 2,
        });
      }
      return columns;
    }

    function getBarberByPosition(el, columns) {
      if (columns.length === 0) return 'Unknown';
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      // First try: appointment center falls within a column's bounds
      for (const col of columns) {
        if (cx >= col.left && cx <= col.right) return col.name;
      }
      // Fallback: nearest column centre (handles edge/overlap cases)
      return columns.reduce((best, col) =>
        Math.abs(cx - col.centerX) < Math.abs(cx - best.centerX) ? col : best
      ).name;
    }

    const columns = buildColumnBounds(knownBarbers);
    console.log('[planity/page] Columns detected:', JSON.stringify(columns.map(c => ({
      name: c.name, left: Math.round(c.left), right: Math.round(c.right)
    }))));

    if (columns.length === 0) {
      console.warn('[planity/page] No header-calendar-N elements found — barber detection will fail.');
    }

    // ── Scrape all appointment blocks ─────────────────────────────────────────
    // Use text-based detection instead of a hardcoded CSS class — Planity uses
    // different classes for different appointment types (e.g. css-17xliyc for
    // online bookings, css-8ud9t2 for manual ones). Any leaf span whose text
    // matches a time range is a valid time span.
    const timeSpans = Array.from(document.querySelectorAll('span')).filter((el) =>
      el.children.length === 0 && TIME_RANGE_RE.test(el.textContent.trim())
    );
    const seen = new Set();

    for (const timeSpan of timeSpans) {
      const timeText = timeSpan.textContent.trim();
      const match = timeText.match(TIME_RANGE_RE);
      if (!match) continue;

      const [, startTime, endTime] = match; // e.g. "09:30", "10:00"

      const parent = timeSpan.parentElement;
      if (!parent) continue;

      const contentSpans = Array.from(parent.querySelectorAll('span.css-8g9poh'))
        .map((s) => s.textContent.trim())
        .filter(Boolean);

      if (contentSpans.length === 0) continue;

      let clientName = contentSpans[0];

      // Skip internal calendar blocks: lunch breaks, blocked slots
      if (!clientName || /pause|midi/i.test(clientName)) continue;

      const service = contentSpans[1] || '';

      // "CLIENT" with no service = internal placeholder slot → skip
      // "CLIENT" with a real service = walk-in where barber skipped the name → keep, display as "Walk-in"
      if (clientName === 'CLIENT') {
        if (!service) continue;
        clientName = 'Walk-in';
      }

      // Price is not shown on diary cards — scraped separately by clicking each appointment

      // Barber: use column position as primary source (reliable for all booking types).
      // The header-calendar-N IDs give us exact column boundaries.
      const barberName = getBarberByPosition(timeSpan, columns);

      // Dedup: same client at the same start time is the same appointment
      const key = `${startTime}|${clientName}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        planity_id:       stableId(todayStr, startTime, clientName),
        client_name:      clientName,
        service:          (service || 'Unknown').replace(/&amp;/g, '&'),
        start_time_str:   startTime,   // Paris local — converted to UTC below
        end_time_str:     endTime,
        barber_name:      barberName,
        appointment_date: todayStr,
      });
    }

    return results;
  }, todayStr, KNOWN_BARBERS);

  // ── Convert Paris local times → UTC (DST-aware, via luxon) ────────────────
  // Done here in Node.js because page.evaluate cannot use luxon.
  // On March 30 Paris is UTC+2 (DST), so "09:30" → "07:30Z", not "08:30Z".
  const appointments = rawAppointments.map((appt) => ({
    planity_id:       appt.planity_id,
    client_name:      appt.client_name,
    service:          appt.service,
    price:            null,            // filled in by scrapeAppointmentPrice after diary scrape
    start_time_local: appt.start_time_str, // Paris HH:mm — used for price scraping clicks
    start_time:       parisTimeToUTC(appt.appointment_date, appt.start_time_str),
    end_time:         parisTimeToUTC(appt.appointment_date, appt.end_time_str),
    barber_name:      appt.barber_name,
    appointment_date: appt.appointment_date,
  }));

  console.log(`[planity] Scraped ${appointments.length} appointment(s) for today.`);
  rawAppointments.forEach((a, i) => {
    console.log(`[planity]   ${a.barber_name} | ${a.client_name} | ${a.start_time_str} Paris → ${appointments[i].start_time}`);
  });

  return appointments;
}

// ── Price scraping (requires clicking each appointment to open its modal) ─────

/**
 * Click an appointment, read the price from the modal, then close it.
 * The price field ("18,00" + "€") appears in the service row of the modal.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} startTimeStr  Paris local HH:mm
 * @param {string} clientName    As scraped from diary
 * @returns {Promise<string|null>}  e.g. "18,00€" or null
 */
async function scrapeAppointmentPrice(page, startTimeStr, clientName, barberName) {
  try {
    await ensureDiary(page);

    const found = await clickAppointmentCard(page, startTimeStr, clientName, barberName);
    if (!found) {
      console.warn(`[planity] scrapeAppointmentPrice: card not found (${startTimeStr} / ${clientName})`);
      return null;
    }

    // Wait for modal to open — same signal as markNotAttended (proven to work)
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('*')).some(
        (el) => el.children.length === 0 && el.textContent.trim() === 'Pas venu'
      ),
      { timeout: 6000 }
    ).catch(() => {});

    await new Promise((r) => setTimeout(r, 400));

    const price = await page.evaluate(() => {
      // Scope ALL searches to the modal — not the diary behind it.
      // The modal is the smallest element that contains both "Rendez-vous" (title)
      // and "Pas venu" (bottom action link).
      const modalCandidates = Array.from(document.querySelectorAll('*')).filter(
        (el) => el.textContent.includes('Rendez-vous') && el.textContent.includes('Pas venu')
      );
      // Pick the candidate with the least text (most specific / deepest container)
      const modal = modalCandidates.reduce((best, el) => {
        if (!best) return el;
        return el.textContent.length < best.textContent.length ? el : best;
      }, null);

      if (!modal) return null;

      // Strategy 1: find "€" leaf inside modal, read previous sibling (the price input/text)
      const euroLeaves = Array.from(modal.querySelectorAll('*')).filter(
        (el) => el.children.length === 0 && el.textContent.trim() === '€'
      );
      for (const euroEl of euroLeaves) {
        // Direct previous sibling
        const prev = euroEl.previousElementSibling;
        if (prev) {
          const val = (prev.tagName === 'INPUT' ? prev.value : prev.textContent || '').trim();
          if (/^\d+([,.]\d+)?$/.test(val)) {
            const num = parseFloat(val.replace(',', '.'));
            if (num > 0 && num < 10000) return val + '€';
          }
        }
        // One level up — parent's previous sibling may contain the input
        const parentPrev = euroEl.parentElement?.previousElementSibling;
        if (parentPrev) {
          const inp = parentPrev.querySelector('input');
          const val = (inp?.value || parentPrev.textContent || '').trim();
          if (/^\d+([,.]\d+)?$/.test(val)) {
            const num = parseFloat(val.replace(',', '.'));
            if (num > 0 && num < 10000) return val + '€';
          }
        }
      }

      // Strategy 2: fallback — any input inside modal with comma-decimal value.
      // French price format always uses comma: "18,00", "16,00".
      // Duration is a plain integer ("30", "45") — /^\d+,\d+$/ won't match it.
      for (const inp of modal.querySelectorAll('input')) {
        const val = inp.value?.trim();
        if (val && /^\d+,\d+$/.test(val)) {
          const num = parseFloat(val.replace(',', '.'));
          if (num > 0 && num < 10000) return val + '€';
        }
      }

      return null;
    });

    // Close modal
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 800));

    return price;
  } catch (err) {
    console.error(`[planity] scrapeAppointmentPrice failed (${startTimeStr} / ${clientName}): ${err.message}`);
    try { await page.keyboard.press('Escape'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
    return null;
  }
}

// ── Puppeteer write-back helpers ──────────────────────────────────────────────
// These functions reuse the existing logged-in browser page.
// All Planity-side actions are wrapped in try/catch — if the UI action fails,
// we log the error but let the caller still update the local DB.

/**
 * Ensure the page is showing today's diary view.
 */
async function ensureDiary(page) {
  const url = page.url();
  if (!url.startsWith(PLANITY_URL)) {
    await page.goto(PLANITY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
  }
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('a, button, [role="tab"]'));
    const diaryTab = tabs.find((t) => /diary|agenda|journal/i.test(t.textContent));
    if (diaryTab) diaryTab.click();
  });
  await new Promise((r) => setTimeout(r, 1000));
}

/**
 * Click an appointment card in the diary by its Paris start time and client name.
 * Walk-in appointments are stored as "Walk-in" but appear as "CLIENT" on Planity.
 */
async function clickAppointmentCard(page, startTimeStr, clientName, barberName) {
  const planityClientName = clientName === 'Walk-in' ? 'CLIENT' : clientName;
  const found = await page.evaluate((time, client, barber) => {
    // Match only spans whose text STARTS with the time — avoids matching "10:00 - 10:30"
    // when we're looking for the appointment that starts at "10:30"
    const timeSpans = Array.from(document.querySelectorAll('span')).filter(
      (el) => el.children.length === 0 && el.textContent.trim().startsWith(time)
    );

    // Strategy 1: full client name match
    for (const sp of timeSpans) {
      const card = sp.parentElement;
      if (card && card.textContent.includes(client)) {
        card.click();
        return { found: true };
      }
    }

    // Strategy 2: partial name match — first word only (handles truncated diary names)
    const firstWord = client.split(' ')[0];
    if (firstWord && firstWord.length >= 3) {
      for (const sp of timeSpans) {
        const card = sp.parentElement;
        if (card && card.textContent.includes(firstWord)) {
          card.click();
          return { found: true, partial: true };
        }
      }
    }

    // Strategy 3: barber column X-position (disambiguates same-time slots across barbers)
    if (barber && timeSpans.length > 1) {
      const barberLeafs = Array.from(document.querySelectorAll('*')).filter(
        (el) => el.children.length === 0 && el.textContent.trim() === barber
      );
      if (barberLeafs.length > 0) {
        const headerCenterX = barberLeafs[0].getBoundingClientRect().left +
                              barberLeafs[0].getBoundingClientRect().width / 2;
        let bestSp = null, bestDist = Infinity;
        for (const sp of timeSpans) {
          const r = sp.getBoundingClientRect();
          const dist = Math.abs((r.left + r.width / 2) - headerCenterX);
          if (dist < bestDist) { bestDist = dist; bestSp = sp; }
        }
        if (bestSp && bestDist < 300) {
          bestSp.parentElement?.click();
          return { found: true, byBarber: true };
        }
      }
    }

    // Fallback: time only — first span in DOM order
    if (timeSpans.length > 0) {
      timeSpans[0].parentElement.click();
      return { found: true, fallback: true };
    }
    return { found: false };
  }, startTimeStr, planityClientName, barberName);

  if (found.partial)   console.warn(`[planity] clickAppointmentCard: partial name match for ${startTimeStr} / ${clientName}`);
  if (found.byBarber)  console.log(`[planity] clickAppointmentCard: barber-column match for ${startTimeStr} / ${clientName}`);
  if (found.fallback)  console.warn(`[planity] clickAppointmentCard: time-only fallback for ${startTimeStr} / ${clientName}`);
  return found.found;
}

/**
 * Mark an appointment as "client non présenté" (no-show) on Planity.
 * Tries to find the no-show button in the appointment modal.
 * Logs a warning but does NOT throw if the Planity action fails.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} startTimeStr  Paris local HH:mm, e.g. "09:30"
 * @param {string} clientName    As stored in DB (may be "Walk-in")
 */
async function markNotAttended(page, startTimeStr, clientName, barberName) {
  try {
    await ensureDiary(page);
    const found = await clickAppointmentCard(page, startTimeStr, clientName, barberName);
    if (!found) {
      console.warn(`[planity] markNotAttended: appointment not found on diary (${startTimeStr} / ${clientName})`);
      return;
    }
    // Wait for the appointment modal to open (title "Rendez-vous" appears)
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('*')).some(
        (el) => el.children.length === 0 && el.textContent.trim() === 'Pas venu'
      ),
      { timeout: 6000 }
    ).catch(() => {});

    await new Promise((r) => setTimeout(r, 500));

    // "Pas venu" is a text link at the bottom of the modal — not a <button>
    const clicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const btn = all.find(
        (el) => el.children.length === 0 && el.textContent.trim() === 'Pas venu'
      );
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (clicked) {
      await new Promise((r) => setTimeout(r, 1000));
      console.log(`[planity] Marked as "Pas venu" on Planity: ${startTimeStr} / ${clientName}`);
    } else {
      console.warn('[planity] markNotAttended: "Pas venu" element not found in modal — DB updated only');
    }
  } catch (err) {
    console.error(`[planity] markNotAttended Planity action failed: ${err.message}`);
  }
}

/**
 * Delete an appointment on Planity (used for Supprimer and Encaisser actions).
 * Logs a warning but does NOT throw if the Planity action fails.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} startTimeStr  Paris local HH:mm
 * @param {string} clientName    As stored in DB
 */
async function deleteOnPlanity(page, startTimeStr, clientName, barberName) {
  try {
    await ensureDiary(page);
    const found = await clickAppointmentCard(page, startTimeStr, clientName, barberName);
    if (!found) {
      console.warn(`[planity] deleteOnPlanity: appointment not found on diary (${startTimeStr} / ${clientName})`);
      return;
    }

    // Wait for modal to open (same signal used everywhere)
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('*')).some(
        (el) => el.children.length === 0 && el.textContent.trim() === 'Pas venu'
      ),
      { timeout: 6000 }
    ).catch(() => {});

    await new Promise((r) => setTimeout(r, 400));

    // "Supprimer" is a plain text leaf in the modal footer — same pattern as "Pas venu"
    const clicked = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const btn = all.find(
        (el) => el.children.length === 0 && el.textContent.trim() === 'Supprimer'
      );
      if (btn) { btn.click(); return true; }
      return false;
    });

    if (!clicked) {
      console.warn('[planity] deleteOnPlanity: "Supprimer" not found in modal — DB updated only');
      return;
    }

    // "Confirmer la suppression" appears immediately after clicking Supprimer
    await new Promise((r) => setTimeout(r, 600));

    const confirmed = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('*'));
      const confirmBtn = all.find(
        (el) => el.children.length === 0 && el.textContent.trim() === 'Confirmer la suppression'
      );
      if (confirmBtn) { confirmBtn.click(); return true; }
      return false;
    });

    if (confirmed) {
      await new Promise((r) => setTimeout(r, 800));
      console.log(`[planity] Deleted on Planity: ${startTimeStr} / ${clientName}`);
    } else {
      console.warn(`[planity] deleteOnPlanity: "Confirmer la suppression" not found — DB deleted only`);
    }
  } catch (err) {
    console.error(`[planity] deleteOnPlanity action failed: ${err.message}`);
  }
}

module.exports = {
  login,
  getTodayAppointments,
  isSessionExpired,
  markNotAttended,
  deleteOnPlanity,
  scrapeAppointmentPrice,
};
