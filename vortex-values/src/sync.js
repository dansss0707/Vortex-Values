import { supabase } from './db.js';

const getItemUrl = (id) => `https://playvortex.io/api/catalog/item/${id}`;
const cookie = process.env.VORTEX_COOKIE || '';

// Fetch a single item with session cookies & polite rate handling
async function fetchVortexItem(itemId, attempt = 1) {
  const url = getItemUrl(itemId);
  try {
    const res = await fetch(url, {
      headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'cookie': cookie,
        'referer': `https://playvortex.io/catalog/${itemId}`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    if (res.status === 404) return null;

    if (res.status === 429) {
      if (attempt <= 3) {
        const waitTime = attempt * 3000;
        console.warn(`[429 Rate Limit] #${itemId} - cooling down for ${waitTime / 1000}s...`);
        await new Promise(r => setTimeout(r, waitTime));
        return fetchVortexItem(itemId, attempt + 1);
      }
      return null;
    }

    if (!res.ok) {
      console.warn(`[HTTP ${res.status}] Failed on #${itemId}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error(`Fetch error on #${itemId}:`, err.message);
    return null;
  }
}

// Process item and sync to Supabase
async function processItem(data) {
  const listings = Array.isArray(data.listings) ? data.listings : [];
  const validPrices = listings.map(l => l.price).filter(p => typeof p === 'number');
  const bestPrice = validPrices.length > 0 ? Math.min(...validPrices) : null;

  // 1. Upsert into items table
  const { error: itemErr } = await supabase.from('items').upsert({
    id: data.id,
    name: data.name,
    item_type: data.type,
    original_price: data.price,
    off_sale: Boolean(data.off_sale),
    limited: Boolean(data.limited),
    stock: data.stock || 0,
    total_stock: data.total_stock || 0,
    resellable: Boolean(data.resellable),
    description: data.description || '',
    best_price: bestPrice,
    listing_count: listings.length,
    updated_at: new Date().toISOString()
  }, { onConflict: 'id' });

  if (itemErr) {
    console.error(`Failed to upsert item #${data.id}:`, itemErr.message);
    return;
  }

  // 2. Log history record if limited
  if (data.limited && bestPrice !== null) {
    await supabase.from('item_history').insert({
      item_id: data.id,
      best_price: bestPrice,
      listing_count: listings.length,
      recorded_at: new Date().toISOString()
    });
  }

  // 3. Upsert active listings with serials & sellers
  if (listings.length > 0) {
    const listingRows = listings.map(l => ({
      id: l.id,
      item_id: data.id,
      copy_id: l.copy_id,
      serial: l.serial,
      seller_user_id: l.seller_user_id,
      seller_name: l.seller,
      price: l.price,
      created_at: l.created_at,
      last_seen: new Date().toISOString()
    }));

    const { error: listingErr } = await supabase
      .from('active_listings')
      .upsert(listingRows, { onConflict: 'id' });

    if (listingErr) {
      console.error(`Failed to upsert listings for #${data.id}:`, listingErr.message);
    }
  }

  console.log(`[Synced] #${data.id} - ${data.name} | Floor: ${bestPrice ?? 'None'} | Listings: ${listings.length}`);
}

// Main Batch Runner
async function runCatalogSync(startId = 1, endId = 260) {
  console.log(`=== Starting Vortex Catalog Sync (Range: #${startId} - #${endId}) ===`);
  
  for (let id = startId; id <= endId; id++) {
    const itemData = await fetchVortexItem(id);
    if (itemData) {
      await processItem(itemData);
    }
    // 700ms throttle to prevent 429 rate-limiting
    await new Promise(resolve => setTimeout(resolve, 700));
  }

  console.log('=== Sync Completed Successfully ===');
}

// Run
runCatalogSync(1, 260);
