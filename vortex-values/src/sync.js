import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';

// Environment credentials
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const VORTEX_USERNAME = process.env.VORTEX_USERNAME;
const VORTEX_PASSWORD = process.env.VORTEX_PASSWORD;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Missing Supabase environment variables.');
  process.exit(1);
}

if (!VORTEX_USERNAME || !VORTEX_PASSWORD) {
  console.error('[FATAL] Missing VORTEX_USERNAME or VORTEX_PASSWORD in GitHub Secrets.');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: null }
});

const START_ID = 1;
const END_ID = 260;
const BASE_DELAY_MS = 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sessionCookieHeader = '';

async function loginAndGetCookies() {
  console.log('[Auth] Launching headless browser to authenticate...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    console.log('[Auth] Navigating to login page...');
    await page.goto('https://playvortex.io/login', { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('[Auth] Entering credentials...');
    await page.waitForSelector('input[name="username"], input[type="text"], input[name="email"]', { timeout: 15000 });
    
    const userInput = await page.$('input[name="username"], input[name="email"], input[type="text"]');
    await userInput.type(VORTEX_USERNAME, { delay: 30 });

    const passInput = await page.$('input[name="password"], input[type="password"]');
    await passInput.type(VORTEX_PASSWORD, { delay: 30 });

    console.log('[Auth] Submitting login form...');
    const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
    if (submitBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
        submitBtn.click()
      ]);
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
        passInput.press('Enter')
      ]);
    }

    const cookies = await page.cookies();
    if (!cookies || cookies.length === 0) {
      throw new Error('No cookies returned after login attempt.');
    }

    sessionCookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`[Auth] Authentication successful! Retrieved ${cookies.length} session cookies.`);
  } finally {
    await browser.close();
  }
}

async function fetchItemDataWithRetry(itemId, maxRetries = 3) {
  const url = `https://playvortex.io/api/catalog/item/${itemId}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Cookie': sessionCookieHeader
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      const waitTime = attempt * 3500;
      console.warn(`[Rate Limited] 429 hit on item #${itemId}. Pausing ${waitTime}ms before retry (Attempt ${attempt}/${maxRetries})...`);
      await sleep(waitTime);
      continue;
    }

    if (response.status === 401) {
      throw new Error('AUTH_EXPIRED');
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }

    return await response.json();
  }

  throw new Error('HTTP_429_EXCEEDED_RETRIES');
}

async function runSync() {
  await loginAndGetCookies();

  console.log(`\n=== Starting Vortex Catalog Sync [IDs ${START_ID} - ${END_ID}] ===`);
  const timestamp = new Date().toISOString();

  let successCount = 0;
  let skipCount = 0;

  for (let id = START_ID; id <= END_ID; id++) {
    try {
      const data = await fetchItemDataWithRetry(id);

      if (!data) {
        skipCount++;
        await sleep(BASE_DELAY_MS);
        continue;
      }

      // Diagnostic logging for schema inspection
      if (id === 1 || id === 243) {
        console.log(`[DEBUG #${id} Keys]:`, Object.keys(data));
        console.log(`[DEBUG #${id} Sample]:`, JSON.stringify(data).slice(0, 250));
      }

      // Support nested (data.item) or root-level item properties
      const item = data.item || (data.name || data.id ? data : null);

      if (!item) {
        console.log(`[Warning] No identifiable item fields found for #${id}`);
        skipCount++;
        await sleep(BASE_DELAY_MS);
        continue;
      }

      // Support nested or top-level listings array
      const listings = Array.isArray(data.listings) 
        ? data.listings 
        : (Array.isArray(item.listings) ? item.listings : []);

      // Calculate lowest active floor price
      let bestPrice = null;
      if (listings.length > 0) {
        const validPrices = listings
          .map(l => Number(l.price))
          .filter(p => !isNaN(p) && p > 0);
        
        if (validPrices.length > 0) {
          bestPrice = Math.min(...validPrices);
        }
      }

      // 1. Upsert Catalog Metadata
      const { error: itemErr } = await db
        .from('items')
        .upsert({
          id: item.id || id,
          name: item.name,
          description: item.description || null,
          item_type: item.item_type || 'Item',
          original_price: item.price != null ? item.price : 0,
          best_price: bestPrice,
          listing_count: listings.length,
          stock: item.stock != null ? item.stock : null,
          total_stock: item.total_stock != null ? item.total_stock : null,
          limited: Boolean(item.limited),
          off_sale: Boolean(item.off_sale),
          updated_at: timestamp
        }, { onConflict: 'id' });

      if (itemErr) {
        console.error(`[Error] Failed to upsert #${id}:`, itemErr.message);
      }

      // 2. Append Price Trend Record
      const { error: histErr } = await db
        .from('item_history')
        .insert({
          item_id: item.id || id,
          best_price: bestPrice,
          listing_count: listings.length,
          recorded_at: timestamp
        });

      if (histErr) {
        console.error(`[Error] Failed to record history for #${id}:`, histErr.message);
      }

      // 3. Refresh Active Serial Copies
      await db
        .from('active_listings')
        .delete()
        .eq('item_id', item.id || id);

      if (listings.length > 0) {
        const rows = listings.map(l => ({
          item_id: item.id || id,
          serial: l.serial || null,
          price: l.price || 0,
          seller_name: l.seller_username || l.seller_name || 'Anonymous',
          created_at: timestamp
        }));

        const { error: listErr } = await db.from('active_listings').insert(rows);
        if (listErr) {
          console.error(`[Error] Failed to insert active listings for #${id}:`, listErr.message);
        }
      }

      console.log(`[Synced] #${item.id || id} - ${item.name} | Floor: ${bestPrice ?? 'None'} | Copies: ${listings.length}`);
      successCount++;

    } catch (err) {
      console.warn(`[Skip] Item #${id}: ${err.message}`);
      skipCount++;
    }

    await sleep(BASE_DELAY_MS);
  }

  console.log(`\n=== Sync Complete ===`);
  console.log(`Successfully Synced: ${successCount}`);
  console.log(`Skipped / Not Found: ${skipCount}`);
  console.log(`Recorded at: ${timestamp}`);
}

runSync();
