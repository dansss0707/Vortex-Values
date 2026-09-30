import { createClient } from '@supabase/supabase-js';

// Environment credentials
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const VORTEX_COOKIE = process.env.VORTEX_COOKIE || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[FATAL] Missing Supabase environment variables.');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// Configure scan range
const START_ID = 1;
const END_ID = 260;
const DELAY_MS = 250; // Polite delay between item requests

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchItemData(itemId) {
  const url = `https://playvortex.io/api/catalog/item/${itemId}`;
  
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  };

  if (VORTEX_COOKIE) {
    headers['Cookie'] = VORTEX_COOKIE;
  }

  const response = await fetch(url, { headers });

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

async function runSync() {
  console.log(`=== Starting Vortex Catalog Sync [IDs ${START_ID} - ${END_ID}] ===`);
  const timestamp = new Date().toISOString();

  let successCount = 0;
  let skipCount = 0;

  for (let id = START_ID; id <= END_ID; id++) {
    try {
      const data = await fetchItemData(id);

      if (!data || !data.item) {
        skipCount++;
        await sleep(DELAY_MS);
        continue;
      }

      const item = data.item;
      const listings = Array.isArray(data.listings) ? data.listings : [];

      // Calculate lowest floor price among active listings
      let bestPrice = null;
      if (listings.length > 0) {
        const validPrices = listings
          .map(l => Number(l.price))
          .filter(p => !isNaN(p) && p > 0);
        
        if (validPrices.length > 0) {
          bestPrice = Math.min(...validPrices);
        }
      }

      // 1. Upsert Item into Catalog Table
      const { error: itemErr } = await db
        .from('items')
        .upsert({
          id: item.id,
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
        console.error(`[Error] Failed to upsert item #${id}:`, itemErr.message);
      }

      // 2. Insert Price History Point (Creates the Chart.js Trend Every 30 mins)
      const { error: histErr } = await db
        .from('item_history')
        .insert({
          item_id: item.id,
          best_price: bestPrice,
          listing_count: listings.length,
          recorded_at: timestamp
        });

      if (histErr) {
        console.error(`[Error] Failed to log history for #${id}:`, histErr.message);
      }

      // 3. Refresh Active Serial Copies for Item
      // Purge stale listings first so removed/bought copies don't linger
      await db
        .from('active_listings')
        .delete()
        .eq('item_id', item.id);

      if (listings.length > 0) {
        const rows = listings.map(l => ({
          item_id: item.id,
          serial: l.serial || null,
          price: l.price || 0,
          seller_name: l.seller_username || l.seller_name || 'Anonymous',
          created_at: timestamp
        }));

        const { error: listErr } = await db
          .from('active_listings')
          .insert(rows);

        if (listErr) {
          console.error(`[Error] Failed to insert active listings for #${id}:`, listErr.message);
        }
      }

      console.log(`[Synced] #${id} - ${item.name} | Floor: ${bestPrice ?? 'None'} | Copies: ${listings.length}`);
      successCount++;

    } catch (err) {
      if (err.message === 'AUTH_EXPIRED') {
        console.error('\n🚨 [FATAL ERROR] 401 Unauthorized: Your VORTEX_COOKIE has expired.');
        console.error('Please grab a fresh cookie from DevTools and update the GitHub Secret.\n');
        process.exit(1);
      } else {
        console.warn(`[Skip] Item #${id}: ${err.message}`);
        skipCount++;
      }
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n=== Sync Complete ===`);
  console.log(`Successfully Synced: ${successCount}`);
  console.log(`Skipped / Not Found: ${skipCount}`);
  console.log(`Recorded at: ${timestamp}`);
}

runSync();
