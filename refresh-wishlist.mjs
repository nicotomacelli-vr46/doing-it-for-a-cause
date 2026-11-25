// Run this script to re-scrape Amazon wishlists and update quantities in data.json.
// Usage: node refresh-wishlist.mjs
// Then run: bash deploy.sh html  — to publish the updated data to the live site.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, 'run-for-a-cause', 'data.json');

const LISTS = [
  'https://www.amazon.com/hz/wishlist/ls/LSDF80CD25PE',
  'https://www.amazon.com/hz/wishlist/ls/IOGHMJJL6JQW',
  'https://www.amazon.com/hz/wishlist/ls/2X7C8B7AAYIZ2'
];

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function findMatch(data, amazonName) {
  const normAmazon = normalize(amazonName).substring(0, 35);
  for (const group of data.groups) {
    for (const item of group.items) {
      const normKey = normalize(item.amazonKey || item.name).substring(0, 35);
      if (normAmazon.startsWith(normKey.substring(0, 20)) || normKey.startsWith(normAmazon.substring(0, 20))) {
        return item;
      }
    }
  }
  return null;
}

console.log('🔄  Refreshing wish list quantities...\n');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
});

const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
const changes = [];
const notMatched = [];

for (const url of LISTS) {
  console.log(`  Scraping ${url} ...`);
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    const scraped = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('[data-id]').forEach(card => {
        const name = card.querySelector('[id^="itemName"]')?.innerText?.trim();
        const qtyText = card.querySelector('[id^="itemRequested_"]')?.innerText?.trim();
        const qty = parseInt(qtyText) || null;
        const cardText = card.innerText || '';
        const available = cardText.includes('Add to Cart') || cardText.includes('Add to cart');
        if (name) results.push({ name, qty, available });
      });
      return results;
    });

    for (const s of scraped) {
      if (!s.available || !s.qty) continue;
      const match = findMatch(data, s.name);
      if (match) {
        if (match.needed !== s.qty) {
          changes.push(`  ✏️  "${match.name}": ${match.needed} → ${s.qty} needed`);
          match.needed = s.qty;
        }
      } else {
        notMatched.push(`  ⚠️  No match for: "${s.name.substring(0, 60)}"`);
      }
    }
    console.log(`  ✓  ${scraped.length} items found`);
  } catch (e) {
    console.warn(`  ✗  Failed: ${e.message}`);
  }
  await page.close();
}

await browser.close();

data.lastUpdated = new Date().toISOString();
writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

console.log('\n─────────────────────────────────');
if (changes.length) {
  console.log('Changes:');
  changes.forEach(c => console.log(c));
} else {
  console.log('No quantity changes detected.');
}
if (notMatched.length) {
  console.log('\nUnmatched Amazon items (new additions?):');
  notMatched.forEach(n => console.log(n));
}
console.log(`\n✅  data.json updated — ${data.lastUpdated}`);
console.log('📤  To publish: bash deploy.sh html');
