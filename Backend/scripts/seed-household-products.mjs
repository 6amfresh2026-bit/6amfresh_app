/**
 * Adds a second quick-commerce department -- household & personal care -- on
 * top of the grocery catalogue seed-quick-commerce.js already created.
 *
 * Twelve non-food items, real product photography fetched the same way
 * seed-product-images.js does (Open Food Facts packshot first, Wikimedia
 * Commons as a fallback), stocked across the same two sellers.
 *
 *   node scripts/seed-household-products.mjs
 *
 * Safe to re-run: categories and products are matched by name/seller and
 * updated in place, not duplicated.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodCategory } from '../src/modules/food/admin/models/category.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { uploadRestaurantAttachment } from '../src/modules/food/restaurant/services/restaurant.service.js';

const CATEGORIES = {
  'Household & Personal Care': ['Bath & Body', 'Cleaning Supplies', 'Personal Hygiene', 'Home & Baby Care'],
};

/**
 * sub, name, brand, packSize, price, mrp, gstRate, stock, image search term
 */
const CATALOGUE = [
  ['Bath & Body', 'Bathing Soap Bar', 'Dove', '75 g', 55, 60, 18, 80, 'dove soap bar'],
  ['Bath & Body', 'Body Wash', 'Dettol', '250 ml', 189, 210, 18, 40, 'dettol body wash'],
  ['Bath & Body', 'Shampoo Bottle', 'Head & Shoulders', '340 ml', 299, 330, 18, 35, 'head and shoulders shampoo'],
  ['Personal Hygiene', 'Toothpaste', 'Colgate', '150 g', 95, 105, 18, 70, 'colgate toothpaste'],
  ['Personal Hygiene', 'Toothbrush Pack', 'Oral-B', '2 pcs', 79, 90, 18, 50, 'oral b toothbrush'],
  ['Personal Hygiene', 'Hand Sanitizer', 'Dettol', '200 ml', 99, 110, 18, 45, 'dettol hand sanitizer'],
  ['Personal Hygiene', 'Sanitary Pads', 'Whisper', '30 pcs', 210, 230, 12, 30, 'whisper sanitary pads'],
  ['Cleaning Supplies', 'Detergent Powder', 'Surf Excel', '1 kg', 135, 150, 18, 42, 'surf excel detergent powder'],
  ['Cleaning Supplies', 'Dishwash Liquid', 'Vim', '500 ml', 105, 115, 18, 38, 'vim dishwash liquid'],
  ['Cleaning Supplies', 'Floor Cleaner', 'Lizol', '975 ml', 199, 220, 18, 28, 'lizol floor cleaner'],
  ['Cleaning Supplies', 'Toilet Cleaner', 'Harpic', '500 ml', 109, 120, 18, 33, 'harpic toilet cleaner'],
  ['Home & Baby Care', 'Baby Diapers', 'Pampers', '"M" 34 pcs', 499, 550, 12, 20, 'pampers diapers pack'],
];

const FORCE = process.argv.includes('--force');
const UA = { 'User-Agent': 'SuvioQuickCommerce/1.0 (https://quick.appzeto.com; catalogue seeding)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
async function politeFetch(url) {
  const wait = 400 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fetch(url, { headers: UA });
}

// Open Food Facts only carries food. Soap, shampoo and detergent live in its
// sister databases -- same Product Opener API, different domain -- so a soap
// search against the food one returns nothing, not a bad match.
const PACKSHOT_HOSTS = ['world.openbeautyfacts.org', 'world.openproductsfacts.org', 'world.openfoodfacts.org'];

async function fetchPackshotFrom(host, term) {
  const api =
    `https://${host}/cgi/search.pl?search_simple=1` +
    '&action=process&json=1&page_size=8' +
    '&fields=product_name,brands,image_front_url&search_terms=' +
    encodeURIComponent(term);
  let res = await politeFetch(api);
  for (let attempt = 1; attempt <= 3 && (res.status === 503 || res.status === 429); attempt++) {
    await sleep(2000 * attempt);
    res = await politeFetch(api);
  }
  if (!res.ok) return null;
  let products;
  try {
    products = (await res.json())?.products || [];
  } catch {
    return null;
  }
  for (const product of products) {
    const url = product?.image_front_url;
    if (!url) continue;
    const img = await politeFetch(url);
    if (!img.ok) continue;
    const buffer = Buffer.from(await img.arrayBuffer());
    if (buffer.length > 5000) return { buffer, source: product.product_name || term };
  }
  return null;
}

async function fetchPackshot(term) {
  for (const host of PACKSHOT_HOSTS) {
    const found = await fetchPackshotFrom(host, term);
    if (found) return found;
  }
  return null;
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
      // longer sits at the end of the string.
      if (!url || !/\.(jpe?g|png|webp)(\?|$)/i.test(url)) continue;
      const img = await politeFetch(url);
      if (!img.ok) continue;
      const buffer = Buffer.from(await img.arrayBuffer());
      if (buffer.length > 5000) return { buffer, source: page.title, query };
    }
  }
  return null;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
  console.log(`connected -> ${mongoose.connection.name}\n`);

  const sellers = await FoodRestaurant.find({
    status: 'approved',
    restaurantName: { $in: ['FreshMart Express', 'DailyNeeds Store'] },
  })
    .select('_id restaurantName')
    .lean();
  if (!sellers.length) {
    console.error('no seeded grocery seller; run seed-quick-commerce.js first');
    process.exit(1);
  }

  // --- categories ---
  const subByName = new Map();
  const existingParents = await FoodCategory.find({ restaurantId: { $exists: false } })
    .select('sortOrder')
    .sort({ sortOrder: -1 })
    .limit(1)
    .lean();
  let order = (existingParents[0]?.sortOrder || 0) + 1;

  for (const [parentName, children] of Object.entries(CATEGORIES)) {
    const parent = await FoodCategory.findOneAndUpdate(
      { name: parentName, restaurantId: { $exists: false } },
      {
        $set: {
          name: parentName,
          type: 'seed:quick-commerce',
          foodTypeScope: 'Both',
          approvalStatus: 'approved',
          isApproved: true,
          isActive: true,
          sortOrder: order++,
        },
        $unset: { parentId: 1 },
      },
      { upsert: true, new: true },
    );

    for (const childName of children) {
      const child = await FoodCategory.findOneAndUpdate(
        { name: childName, restaurantId: { $exists: false } },
        {
          $set: {
            name: childName,
            type: 'seed:quick-commerce',
            parentId: parent._id,
            foodTypeScope: 'Both',
            approvalStatus: 'approved',
            isApproved: true,
            isActive: true,
            sortOrder: order++,
          },
        },
        { upsert: true, new: true },
      );
      subByName.set(childName, child);
    }
  }
  console.log(`categories: ${Object.keys(CATEGORIES).length} parent, ${subByName.size} sub\n`);

  // --- products + images ---
  let created = 0;
  let withImage = 0;
  let noImage = 0;

  for (const [subName, name, brand, packSize, price, mrp, gstRate, stockQty, term] of CATALOGUE) {
    const category = subByName.get(subName);

    for (const [index, seller] of sellers.entries()) {
      const sellerPrice = index > 0 ? Math.min(Math.round(price * 1.05), mrp || price) : price;

      const existing = await FoodItem.findOne({ restaurantId: seller._id, name }).select('_id image').lean();
      let image = existing?.image || '';
      if (!image || FORCE) {
        const shared = await FoodItem.findOne({ name, image: { $nin: ['', null] } }).select('image').lean();
        if (shared?.image && !FORCE) {
          image = shared.image;
        } else {
          const photo = (await fetchPackshot(term)) ?? (await fetchPhoto(term));
          if (photo) {
            const stored = await uploadRestaurantAttachment(
              { buffer: photo.buffer, originalname: `${name}.jpg`, mimetype: 'image/jpeg' },
              'products',
            );
            image = stored?.url || '';
            if (image) console.log(`  photo  ${name.padEnd(28)} <- ${photo.source}`);
          }
        }
      }

      await FoodItem.findOneAndUpdate(
        { restaurantId: seller._id, name },
        {
          $set: {
            restaurantId: seller._id,
            ...(category ? { categoryId: category._id, categoryName: category.name } : {}),
            name,
            brand,
            packSize,
            description: `${brand ? `${brand} ` : ''}${name}${packSize ? ` - ${packSize}` : ''}`,
            price: sellerPrice,
            mrp: mrp || null,
            otherPrice: 0,
            gstRate,
            stockQty: index > 0 ? Math.ceil(stockQty / 2) : stockQty,
            lowStockThreshold: 10,
            maxQtyPerOrder: 10,
            isAvailable: stockQty > 0,
            foodType: 'Veg',
            image,
            images: image ? [image] : [],
            approvalStatus: 'approved',
            approvedAt: new Date(),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      created++;
      image ? withImage++ : noImage++;
    }
  }

  console.log(`\nlistings: ${created} across ${sellers.length} sellers`);
  console.log(`  with image: ${withImage} | without: ${noImage}`);
  console.log(`  distinct products: ${CATALOGUE.length}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
