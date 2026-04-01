/**
 * index.js — Planity scraper entry point
 *
 * Sync logic (append-only):
 *   - INSERT new appointments found on Planity
 *   - UPDATE changed appointments (time, service, barber, price)
 *   - Never DELETE during sync — cancellations are handled by barbers via the panel
 *   - At the start of each new Paris day, clean up rows from previous days
 *
 * HTTP server on PORT (Railway) / 3001 (local):
 *   - GET  /              → health check "OK"
 *   - POST /actions/not-attended  → Puppeteer: mark no-show on Planity + update DB
 *   - POST /actions/delete        → Puppeteer: delete on Planity + set hidden=true in DB
 *   - POST /actions/encaisser     → Puppeteer: delete on Planity + set status=paid in DB
 *
 * Action requests must carry: Authorization: Bearer <SCRAPER_SECRET>
 */

require('dotenv').config();

const http       = require('http');
const puppeteer  = require('puppeteer');
const { DateTime } = require('luxon');
const { createClient } = require('@supabase/supabase-js');
const {
  login,
  getTodayAppointments,
  isSessionExpired,
  markNotAttended,
  deleteOnPlanity,
  scrapeAppointmentPrice,
} = require('./planity');

// ── Environment ──────────────────────────────────────────────────────────────
const {
  PLANITY_EMAIL,
  PLANITY_PASSWORD,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  SCRAPER_SECRET,
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
let isRunning  = false;   // guard: scrape cycle in progress
let actionLock = false;   // guard: Puppeteer write-back action in progress

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTodayParis() {
  return DateTime.now().setZone('Europe/Paris').toISODate(); // YYYY-MM-DD, always Paris date
}

/**
 * Convert a UTC ISO string to Paris local HH:mm (for Puppeteer lookups).
 */
function utcToParisHHmm(isoString) {
  return new Intl.DateTimeFormat('en-GB', {
    hour:     '2-digit',
    minute:   '2-digit',
    timeZone: 'Europe/Paris',
    hour12:   false,
  }).format(new Date(isoString));
}

/**
 * Delete all mirror_appointments rows that are NOT from today (Paris).
 * Runs at the start of every scrape cycle — safe to call repeatedly.
 */
async function cleanupOldAppointments(todayParis) {
  const { error } = await supabase
    .from('mirror_appointments')
    .delete()
    .neq('appointment_date', todayParis);

  if (error) {
    console.error('[scraper] Cleanup failed:', error.message);
  } else {
    console.log(`[scraper] Cleaned up old appointments. Today is ${todayParis}`);
  }
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function getStoredAppointments(today) {
  const { data, error } = await supabase
    .from('mirror_appointments')
    .select('id, planity_id, client_name, service, price, start_time, end_time, barber_name')
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

async function upsertAppointment(appt) {
  const { error } = await supabase
    .from('mirror_appointments')
    .upsert(
      {
        planity_id:       appt.planity_id,
        client_name:      appt.client_name,
        service:          appt.service,
        price:            appt.price,
        start_time:       appt.start_time,
        end_time:         appt.end_time,
        barber_name:      appt.barber_name,
        appointment_date: appt.appointment_date,
      },
      { onConflict: 'planity_id' }
    );

  if (error) {
    throw new Error(`[supabase] upsertAppointment failed: ${error.message}`);
  }
}

async function updateAppointment(id, appt, resetPrice = false) {
  // price is managed separately by scrapeAppointmentPrice — never overwrite with null
  // unless the service itself changed (resetPrice=true), which forces a re-scrape
  const data = {
    client_name: appt.client_name,
    service:     appt.service,
    start_time:  appt.start_time,
    end_time:    appt.end_time,
    barber_name: appt.barber_name,
  };
  if (resetPrice) data.price = null;

  const { error } = await supabase
    .from('mirror_appointments')
    .update(data)
    .eq('id', id);

  if (error) {
    throw new Error(`[supabase] updateAppointment failed: ${error.message}`);
  }
}

// ── Main scrape cycle (append-only) ──────────────────────────────────────────

async function runScrape() {
  if (isRunning || actionLock) {
    console.log('[scraper] Busy (scrape or action in progress) — skipping tick.');
    return;
  }

  isRunning = true;
  console.log(`\n[scraper] ── Scrape cycle at ${new Date().toISOString()} ──`);

  try {
    const today = getTodayParis();
    await cleanupOldAppointments(today);

    await ensureLoggedIn();

    const scraped   = await getTodayAppointments(page);
    const storedMap = await getStoredAppointments(today);

    const scrapedMap = new Map();
    for (const appt of scraped) {
      scrapedMap.set(appt.planity_id, appt);
    }

    let inserted = 0;
    let updated  = 0;

    for (const [planityId, appt] of scrapedMap) {
      const stored = storedMap.get(planityId);

      if (!stored) {
        await upsertAppointment(appt);
        inserted++;
        console.log(
          `[scraper] INSERT → ${appt.barber_name} | ${appt.client_name} | ` +
          `${appt.service} | ${appt.start_time}`
        );
      } else {
        // Compare meaningful fields; use getTime() for timestamps (format differs)
        const serviceChanged = stored.service !== appt.service;
        const changed =
          stored.client_name !== appt.client_name ||
          serviceChanged     ||
          new Date(stored.start_time).getTime() !== new Date(appt.start_time).getTime() ||
          new Date(stored.end_time).getTime()   !== new Date(appt.end_time).getTime()   ||
          stored.barber_name !== appt.barber_name;

        if (changed) {
          // resetPrice=true only when service changed — forces price re-scrape
          await updateAppointment(stored.id, appt, serviceChanged);
          updated++;
          console.log(
            `[scraper] UPDATE → ${appt.barber_name} | ${appt.client_name} | ` +
            `${appt.service} | ${appt.start_time}`
          );
        }
      }
    }

    // NOTE: No delete loop — scraper is append-only.
    // Barbers remove appointments via the panel (Supprimer / Encaisser buttons).

    // ── Scrape prices for appointments that don't have one yet ────────────────
    const needsPrices = scraped.filter((appt) => {
      const stored = storedMap.get(appt.planity_id);
      // New appointment (stored is undefined) OR existing row with no price
      return !stored || !stored.price;
    });

    console.log(`[scraper] Price queue: ${needsPrices.length} appointment(s) need price scraping.`);
    if (needsPrices.length > 0) {
      console.log(`[scraper] Scraping prices for ${needsPrices.length} appointment(s)...`);
      for (const appt of needsPrices) {
        const price = await scrapeAppointmentPrice(page, appt.start_time_local, appt.client_name, appt.barber_name);
        if (price) {
          const { error: priceErr } = await supabase
            .from('mirror_appointments')
            .update({ price })
            .eq('planity_id', appt.planity_id);
          if (priceErr) {
            console.error(`[scraper] Price update failed for ${appt.client_name}:`, priceErr.message);
          } else {
            console.log(`[scraper] Price: ${appt.client_name} (${appt.start_time_local}) → ${price}`);
          }
        } else {
          console.log(`[scraper] No price found for ${appt.client_name} (${appt.start_time_local})`);
        }
      }
    }

    console.log(`[scraper] Done. inserted=${inserted}, updated=${updated}`);

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

// ── HTTP server — health check + Puppeteer action endpoints ──────────────────

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  // All POST routes require the shared secret
  const auth = req.headers['authorization'];
  const expectedAuth = SCRAPER_SECRET ? `Bearer ${SCRAPER_SECRET}` : null;
  if (expectedAuth && auth !== expectedAuth) {
    jsonResponse(res, 401, { error: 'Unauthorized' });
    return;
  }

  // Block if scrape or another action is running
  if (isRunning || actionLock) {
    jsonResponse(res, 503, { error: 'Scraper busy — try again shortly' });
    return;
  }

  const body = await parseBody(req);
  const { start_time_local, client_name, barber_name } = body;

  if (!start_time_local || !client_name) {
    jsonResponse(res, 400, { error: 'start_time_local and client_name are required' });
    return;
  }

  actionLock = true;
  try {
    await ensureLoggedIn();

    if (req.url === '/actions/not-attended') {
      await markNotAttended(page, start_time_local, client_name, barber_name);
      jsonResponse(res, 200, { ok: true });

    } else if (req.url === '/actions/delete' || req.url === '/actions/encaisser') {
      await deleteOnPlanity(page, start_time_local, client_name, barber_name);
      jsonResponse(res, 200, { ok: true });

    } else {
      jsonResponse(res, 404, { error: 'Unknown action' });
    }
  } catch (err) {
    console.error('[scraper] Action handler error:', err.message);
    jsonResponse(res, 500, { error: err.message });
  } finally {
    actionLock = false;
  }
});

server.listen(8080, () => {
  console.log('[scraper] HTTP server listening on port 8080');
});

// ── Startup ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('[scraper] Starting Planity scraper (live sync mode)...');
  console.log(`[scraper] Sync interval: ${INTERVAL_MS / 1000}s`);

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
