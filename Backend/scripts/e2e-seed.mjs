/**
 * Seeds the minimum a browser run needs: one admin, one approved seller, one
 * approved rider, one customer, a zone and a product. Idempotent.
 *
 *   MONGO_URI=mongodb://127.0.0.1:27017/switcheats_e2e node scripts/e2e-seed.mjs   (from Backend/)
 *
 * It refuses to run unless the database name contains "e2e" or "test": this
 * creates accounts with known credentials, which must never land in a database
 * anyone uses for real.
 */
import mongoose from 'mongoose';
import { FoodAdmin } from '../src/core/admin/admin.model.js';
import { FoodUser } from '../src/core/users/user.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';

export const ACCOUNTS = {
  admin: { email: 'admin@6am.com', password: 'password123' },
  seller: { phone: '9999900001' },
  rider: { phone: '9800000001' },
  customer: { phone: '7777777777' },
  otp: '1234',
};

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.error('Set MONGO_URI to the e2e database.');
  process.exit(1);
}
const dbName = uri.split('?')[0].split('/').pop();
if (!/e2e|test/i.test(dbName || '')) {
  console.error(`Refusing to seed "${dbName}": its name must contain "e2e" or "test".`);
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });

const upsert = async (Model, filter, create) => (await Model.findOne(filter)) || Model.create(create);

await upsert(FoodAdmin, { email: ACCOUNTS.admin.email }, {
  email: ACCOUNTS.admin.email,
  password: ACCOUNTS.admin.password,
  name: 'E2E Admin',
  role: 'ADMIN',
  adminType: 'super_admin',
});

const zone = await upsert(FoodZone, { name: 'E2E Zone' }, {
  name: 'E2E Zone',
  zoneName: 'E2E',
  country: 'India',
  isActive: true,
  coordinates: [
    { latitude: 17.2, longitude: 78.2 },
    { latitude: 17.2, longitude: 78.8 },
    { latitude: 17.6, longitude: 78.8 },
    { latitude: 17.6, longitude: 78.2 },
  ],
});

const store = await upsert(FoodRestaurant, { ownerPhone: ACCOUNTS.seller.phone }, {
  restaurantName: 'E2E Store',
  ownerName: 'E2E Owner',
  ownerPhone: ACCOUNTS.seller.phone,
  phone: ACCOUNTS.seller.phone,
  status: 'approved',
  isAcceptingOrders: true,
  storeType: 'grocery',
  zoneId: zone._id,
  location: { type: 'Point', coordinates: [78.4867, 17.385], formattedAddress: 'E2E Store, Hyderabad', city: 'Hyderabad' },
});

await upsert(FoodItem, { restaurantId: store._id, name: 'E2E Milk' }, {
  restaurantId: store._id,
  name: 'E2E Milk',
  price: 50,
  mrp: 55,
  foodType: 'Veg',
  isAvailable: true,
  stockQty: 100,
  approvalStatus: 'approved',
});

await upsert(FoodDeliveryPartner, { phone: ACCOUNTS.rider.phone }, {
  name: 'E2E Rider',
  phone: ACCOUNTS.rider.phone,
  status: 'approved',
  availabilityStatus: 'online',
  lastLat: 17.386,
  lastLng: 78.4875,
  lastLocationAt: new Date(),
});

await upsert(FoodUser, { phone: ACCOUNTS.customer.phone }, {
  phone: ACCOUNTS.customer.phone,
  name: 'E2E Customer',
  isVerified: true,
});

console.log(`Seeded ${dbName}.`);
await mongoose.disconnect();
