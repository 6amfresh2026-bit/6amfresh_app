/**
 * Gives every category and brand in the admin Category/Brand screen a real
 * photo instead of the placeholder icon.
 *
 * Categories are a concept ("Dairy", "Cleaning Supplies"), not a product, so
 * Open Food Facts' packshot search is the wrong tool here -- it wants a
 * specific item, not a department. Wikimedia Commons, searched with a
 * concrete phrase per category, is what actually returns a photo a shopper
 * would recognise as that aisle. Brands get their logo, same source.
 *
 *   node scripts/seed-category-brand-images.mjs
 *   node scripts/seed-category-brand-images.mjs --force   (re-fetch images already set)
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { FoodCategory } from '../src/modules/food/admin/models/category.model.js';
import { FoodBrand } from '../src/modules/food/admin/models/brand.model.js';
import { uploadRestaurantAttachment } from '../src/modules/food/restaurant/services/restaurant.service.js';

// Exact search phrase per category name. Generic enough to hit a clean,
// recognisable photo on Commons rather than an unrelated diagram or map --
// the failure mode a bare category name runs into (searched "Dairy" once
// and got a photo of a dairy farm building, not a shelf of dairy products).
const CATEGORY_TERMS = {
  Pizza: 'pizza food',
  Burgers: 'burger food',
  Beverages: 'soft drinks bottles',
  Desserts: 'dessert food',
  'Dairy & Eggs': 'dairy products eggs',
  'Milk & Curd': 'milk bottles',
  'Milk & CurdMilk & Curd': 'milk bottles',
  Snacks: 'snacks food',
  'Frozen Foods': 'frozen food package',
  Dairy: 'dairy products',
  Milk: 'milk bottle',
  'Curd & Yogurt': 'yogurt bowl',
  'Butter & Cheese': 'butter and cheese',
  'Fruits & Vegetables': 'fruits and vegetables market',
  'Fresh Fruits': 'fresh fruits basket',
  'Fresh Vegetables': 'fresh vegetables',
  Staples: 'grains and pulses',
  'Atta & Flour': 'wheat flour',
  'Rice & Pulses': 'basmati rice grains',
  Oils: 'cooking oil bottle',
  Biscuits: 'biscuits cookies',
  'Chips & Namkeen': 'potato chips snacks',
  'Tea & Coffee': 'tea and coffee',
  'Soft Drinks': 'soft drink bottles',
  'Household & Personal Care': 'household cleaning products',
  'Bath & Body': 'liquid soap bottle',
  'Cleaning Supplies': 'cleaning supplies products',
  'Personal Hygiene': 'toothpaste and toiletries',
  'Home & Baby Care': 'baby care products',
};

const BRAND_TERMS = {
  Amul: 'Amul logo',
  'Amul Gold': 'Amul logo',
};

const FORCE = process.argv.includes('--force');
const ONLY_ARG = process.argv.find((a) => a.startsWith('--only='));
const ONLY = ONLY_ARG ? new Set(ONLY_ARG.slice('--only='.length).split(',')) : null;
const UA = { 'User-Agent': 'SuvioQuickCommerce/1.0 (https://quick.appzeto.com; catalogue seeding)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
async function politeFetch(url) {
  const wait = 400 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fetch(url, { headers: UA });
}

async function searchCommons(query) {
  const api =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
    '&generator=search&gsrnamespace=6&gsrlimit=6&prop=imageinfo' +
    '&iiprop=url|mime&iiurlwidth=800&gsrsearch=' +
    encodeURIComponent(query);
  const res = await politeFetch(api);
  if (!res.ok) {
    if (res.status === 429) await sleep(5000);
    return [];
  }
  try {
    return Object.values((await res.json())?.query?.pages || {});
  } catch {
    return [];
  }
}

async function fetchPhoto(term) {
  const attempts = [term, term.split(' ').slice(0, 2).join(' '), term.split(' ')[0]];
  for (const query of [...new Set(attempts)]) {
    for (const page of await searchCommons(query)) {
      const url = page?.imageinfo?.[0]?.thumburl;
      // Commons now appends "?utm_source=..." to thumburl, so the extension no
      // longer sits at the end of the string -- match it before an optional
      // query string instead of anchoring to the end.
      if (!url || !/\.(jpe?g|png|webp)(\?|$)/i.test(url)) continue;
      const img = await politeFetch(url);
      if (!img.ok) continue;
      const buffer = Buffer.from(await img.arrayBuffer());
      if (buffer.length > 3000) return { buffer, source: page.title };
    }
  }
  return null;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
  console.log(`connected -> ${mongoose.connection.name}\n`);

  const categories = await FoodCategory.find({}).select('_id name image').lean();
  let catWith = 0;
  let catWithout = 0;
  for (const cat of categories) {
    if (ONLY && !ONLY.has(cat.name)) continue;
    if (cat.image && !FORCE && !ONLY) { catWith++; continue; }
    const term = CATEGORY_TERMS[cat.name] || `${cat.name} food`;
    const photo = await fetchPhoto(term);
    if (!photo) { console.log(`  no photo  ${cat.name}`); catWithout++; continue; }
    const stored = await uploadRestaurantAttachment(
      { buffer: photo.buffer, originalname: `${cat.name}.jpg`, mimetype: 'image/jpeg' },
      'categories',
    );
    if (!stored?.url) { catWithout++; continue; }
    await FoodCategory.updateOne({ _id: cat._id }, { $set: { image: stored.url } });
    console.log(`  photo  ${cat.name.padEnd(28)} <- ${photo.source}`);
    catWith++;
  }
  console.log(`\ncategories: ${catWith} with image, ${catWithout} without (of ${categories.length})\n`);

  const brands = await FoodBrand.find({}).select('_id name image').lean();
  let brandWith = 0;
  let brandWithout = 0;
  for (const brand of brands) {
    if (ONLY) continue;
    if (brand.image && !FORCE) { brandWith++; continue; }
    const term = BRAND_TERMS[brand.name] || `${brand.name} logo`;
    const photo = await fetchPhoto(term);
    if (!photo) { console.log(`  no photo  ${brand.name}`); brandWithout++; continue; }
    const stored = await uploadRestaurantAttachment(
      { buffer: photo.buffer, originalname: `${brand.name}.jpg`, mimetype: 'image/jpeg' },
      'brands',
    );
    if (!stored?.url) { brandWithout++; continue; }
    await FoodBrand.updateOne({ _id: brand._id }, { $set: { image: stored.url } });
    console.log(`  photo  ${brand.name.padEnd(28)} <- ${photo.source}`);
    brandWith++;
  }
  console.log(`\nbrands: ${brandWith} with image, ${brandWithout} without (of ${brands.length})`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
