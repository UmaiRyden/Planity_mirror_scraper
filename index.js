/**
 * index.js — Planity scraper entry point
 * Runs every 30 seconds via setInterval, full live sync with Planity Pro.
 * Inserts new appointments, updates changed ones, deletes removed ones.
 */

require('dotenv').config();

const puppeteer  = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const { login, getTodayAppointments, isSessionExpired } = require('./planity');

// ── Environment ──────────────────────────────────────────────────────────────
const {
  PLANITY_EMAIL,
  PLANITY_PASSWORD,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

if (!PLANITY_EMAIL || !PLANITY_PASSWORD) {
  console.error('[scraper] PLANITY_EMAIL and PLANITY_PASSWORD must be set in .env');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[scraper] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env');
  process.exit(1);
}

const INTERVAL_MS = 30_000; // 30 seconds

// ── Supabase client (service role — bypasses RLS) ─────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Shared browser state ──────────────────────────────────────────────────────
let browser    = null;
let page       = null;
let isLoggedIn = false;
let isRunning  = false; // guard against overlapping runs

// ── Browser / page lifecycle ──────────────────────────────────────────────────

async function launchBrowser() {
  console.log('[scraper] Launching Puppeteer...');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  page = await browser.newPage();

  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  console.log('[scraper] Browser launched.');
}

async function ensureLoggedIn() {
  if (!browser || !page) {
    await launchBrowser();
  }

  if (!isLoggedIn || (await isSessionExpired(page))) {
    console.log('[scraper] (Re-)authenticating with Planity Pro...');
    await login(page, PLANITY_EMAIL, PLANITY_PASSWORD);
    isLoggedIn = true;
  }
}

// ── Today's date in Paris timezone (YYYY-MM-DD) ───────────────────────────────

function getTodayParis() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date());
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

/**
 * Fetch all rows for today from mirror_appointments.
 * Returns a Map keyed by planity_id.
 */
async function getStoredAppointments(today) {
  const { data, error } = await supabase
    .from('mirror_appointments')
    .select('id, planity_id, client_name, service, start_time, end_time, barber_name')
    .eq('appointment_date', today);

  if (error) {
    throw new Error(`[supabase] getStoredAppointments failed: ${error.message}`);
  }

  const map = new Map();
  for (const row of data || []) {
    map.set(row.planity_id, row);
  }
  return map;
}

async function insertAppointment(appt) {
  const { error } = await supabase.from('mirror_appointments').insert({
    planity_id:       appt.planity_id,
    client_name:      appt.client_name,
    service:          appt.service,
    start_time:       appt.start_time,
    end_time:         appt.end_time,
    barber_name:      appt.barber_name,
    appointment_date: appt.appointment_date,
  });

  if (error) {
    if (error.code === '23505') {
      // Race condition — already inserted, ignore
      return;
    }
    throw new Error(`[supabase] insertAppointment failed: ${error.message}`);
  }
}

async function updateAppointment(id, appt) {
  const { error } = await supabase
    .from('mirror_appointments')
    .update({
      client_name:  appt.client_name,
      service:      appt.service,
      start_time:   appt.start_time,
      end_time:     appt.end_time,
      barber_name:  appt.barber_name,
    })
    .eq('id', id);

  if (error) {
    throw new Error(`[supabase] updateAppointment failed: ${error.message}`);
  }
}

async function deleteAppointment(id) {
  const { error } = await supabase
    .from('mirror_appointments')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`[supabase] deleteAppointment failed: ${error.message}`);
  }
}

// ── Main scrape cycle ─────────────────────────────────────────────────────────

async function runScrape() {
  if (isRunning) {
    console.log('[scraper] Previous scrape still running — skipping tick.');
    return;
  }

  isRunning = true;
  console.log(`\n[scraper] ── Scrape cycle at ${new Date().toISOString()} ──`);

  try {
    await ensureLoggedIn();

    const today        = getTodayParis();
    const scraped      = await getTodayAppointments(page);
    const storedMap    = await getStoredAppointments(today);

    // Build a set of planity_ids currently on Planity
    const scrapedMap = new Map();
    for (const appt of scraped) {
      scrapedMap.set(appt.planity_id, appt);
    }

    let inserted = 0;
    let updated  = 0;
    let deleted  = 0;

    // INSERT new / UPDATE changed
    for (const [planityId, appt] of scrapedMap) {
      const stored = storedMap.get(planityId);

      if (!stored) {
        await insertAppointment(appt);
        inserted++;
        console.log(
          `[scraper] INSERT → ${appt.barber_name} | ${appt.client_name} | ` +
          `${appt.service} | ${appt.start_time}`
        );
      } else {
        // Check if anything meaningful changed
        const changed =
          stored.client_name !== appt.client_name ||
          stored.service     !== appt.service     ||
          stored.start_time  !== appt.start_time  ||
          stored.end_time    !== appt.end_time     ||
          stored.barber_name !== appt.barber_name;

        if (changed) {
          await updateAppointment(stored.id, appt);
          updated++;
          console.log(
            `[scraper] UPDATE → ${appt.barber_name} | ${appt.client_name} | ` +
            `${appt.service} | ${appt.start_time}`
          );
        }
      }
    }

    // DELETE appointments no longer on Planity (cancelled / removed)
    for (const [planityId, stored] of storedMap) {
      if (!scrapedMap.has(planityId)) {
        await deleteAppointment(stored.id);
        deleted++;
        console.log(
          `[scraper] DELETE → planity_id=${planityId} (no longer on Planity)`
        );
      }
    }

    console.log(
      `[scraper] Done. inserted=${inserted}, updated=${updated}, deleted=${deleted}`
    );

  } catch (err) {
    if (err.message === 'SESSION_EXPIRED') {
      console.warn('[scraper] Session expired — will re-login on next tick.');
      isLoggedIn = false;
      return;
    }

    console.error('[scraper] Error during scrape cycle:', err.message);

    if (err.message.includes('Target closed') || err.message.includes('Protocol error')) {
      console.warn('[scraper] Browser appears dead — recreating on next tick.');
      try { await browser.close(); } catch (_) {}
      browser    = null;
      page       = null;
      isLoggedIn = false;
    }
  } finally {
    isRunning = false;
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('[scraper] Starting Planity scraper (live sync mode)...');
  console.log(`[scraper] Sync interval: ${INTERVAL_MS / 1000}s`);

  // Run immediately on startup, then on interval
  await runScrape();

  setInterval(runScrape, INTERVAL_MS);
  console.log('[scraper] Interval started. Waiting for next tick...');
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[scraper] SIGTERM received — shutting down.');
  if (browser) await browser.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[scraper] SIGINT received — shutting down.');
  if (browser) await browser.close();
  process.exit(0);
});
