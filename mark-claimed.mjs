// When someone Venmoes you, run this script to mark an item as claimed on the website.
// Usage:
//   node mark-claimed.mjs            → interactive: pick from a list
//   node mark-claimed.mjs zoo        → find item by name/id and increment by 1
//   node mark-claimed.mjs zoo 2      → increment by 2
//   node mark-claimed.mjs zoo -1     → undo a claimed (decrement)

import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, 'run-for-a-cause', 'data.json');

// Always pull the latest data.json from the live site first so we don't
// overwrite any changes the PHP Venmo sync has made directly on the server.
console.log('⬇️   Syncing latest data.json from server...');
try {
  const res = await fetch('https://doingitforacause.org/run-for-a-cause/data.json?v=' + Date.now());
  if (res.ok) {
    const serverData = await res.json();
    writeFileSync(DATA_PATH, JSON.stringify(serverData, null, 2));
    console.log('✓   Synced.\n');
  } else {
    console.log('⚠️   Server returned ' + res.status + ', using local copy.\n');
  }
} catch(e) {
  console.log('⚠️   Could not reach server, using local copy.\n');
}

const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));

// Flatten all items with their group name
const allItems = data.groups.flatMap(g =>
  g.items.map(item => ({ ...item, groupName: g.name }))
);

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

function findItem(query) {
  const q = normalize(query);
  // exact id match first
  let match = allItems.find(i => i.id === query);
  if (match) return match;
  // then partial name/id match
  match = allItems.find(i =>
    normalize(i.name).includes(q) || normalize(i.id).includes(q)
  );
  return match || null;
}

function applyChange(item, delta) {
  // Find the real item reference in data (not the flattened copy)
  for (const g of data.groups) {
    const real = g.items.find(i => i.id === item.id);
    if (real) {
      const before = real.claimed;
      real.claimed = Math.max(0, real.claimed + delta);
      return { before, after: real.claimed };
    }
  }
}

function save() {
  data.lastUpdated = new Date().toISOString();
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function deploy() {
  console.log('\n📤  Uploading data.json to server...');
  try {
    execSync('bash deploy.sh data', { stdio: 'inherit' });
  } catch (e) {
    console.error('Deploy failed — run "bash deploy.sh data" manually.');
  }
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function interactiveMode() {
  console.log('\n📋  Wish Tree Items\n');
  allItems.forEach((item, i) => {
    const avail = Math.max(0, item.needed - item.claimed);
    const status = avail <= 0 ? '✅ FULL' : `${item.claimed}/${item.needed} claimed`;
    console.log(`  ${String(i + 1).padStart(2)}. ${item.name.padEnd(42)} [${status}]  — ${item.groupName}`);
  });

  const pick = await prompt('\nEnter item # (or part of name): ');
  let item;
  if (/^\d+$/.test(pick)) {
    item = allItems[parseInt(pick) - 1];
  } else {
    item = findItem(pick);
  }

  if (!item) {
    console.log('❌  Item not found.');
    process.exit(1);
  }

  const deltaStr = await prompt(`\nHow many to add for "${item.name}"? (default 1, use -1 to undo): `);
  const delta = deltaStr === '' ? 1 : parseInt(deltaStr);
  if (isNaN(delta) || delta === 0) { console.log('No change.'); process.exit(0); }

  const { before, after } = applyChange(item, delta);
  save();
  console.log(`\n✅  "${item.name}": claimed ${before} → ${after} (of ${item.needed} needed)`);

  const doDeploy = await prompt('\nDeploy to website now? (y/n): ');
  if (doDeploy.toLowerCase() === 'y') deploy();
  else console.log('\n📝  data.json saved. Run "bash deploy.sh html" when ready.');
}

async function directMode(query, deltaArg) {
  const item = findItem(query);
  if (!item) {
    console.log(`❌  No item found matching "${query}"\n`);
    console.log('Available items:');
    allItems.forEach(i => console.log(`  ${i.id.padEnd(20)} ${i.name}`));
    process.exit(1);
  }

  const delta = deltaArg !== undefined ? parseInt(deltaArg) : 1;
  if (isNaN(delta) || delta === 0) { console.log('No change.'); process.exit(0); }

  const { before, after } = applyChange(item, delta);
  save();
  console.log(`\n✅  "${item.name}": claimed ${before} → ${after} (of ${item.needed} needed)`);

  const doDeploy = await prompt('\nDeploy to website now? (y/n): ');
  if (doDeploy.toLowerCase() === 'y') deploy();
  else console.log('\n📝  data.json saved. Run "bash deploy.sh html" when ready.');
}

// ── entry point ──
const [,, query, deltaArg] = process.argv;

if (!query) {
  await interactiveMode();
} else {
  await directMode(query, deltaArg);
}
