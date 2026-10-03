import mongoose from 'mongoose';
import { FoodAdmin } from './src/core/admin/admin.model.js';
import { FoodUser } from './src/core/users/user.model.js';
import { FoodRestaurant } from './src/modules/food/restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from './src/modules/food/delivery/models/deliveryPartner.model.js';

// Never hard-code this: a connection string with a password was committed here
// once and has to be treated as leaked. Point it at the database you mean to seed.
const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('Set MONGO_URI to the database to seed, e.g. MONGO_URI=mongodb://127.0.0.1:27018/switcheats_dev');
    process.exit(1);
}

async function seed() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB');

        // Seed Admin
        const adminEmail = 'admin@6am.com';
        const adminPassword = 'password123';
        let admin = await FoodAdmin.findOne({ email: adminEmail });
        if (!admin) {
            admin = new FoodAdmin({
                email: adminEmail,
                password: adminPassword,
                name: 'Super Admin',
                role: 'ADMIN',
                adminType: 'super_admin'
            });
            await admin.save();
            console.log(`Admin seeded: ${adminEmail} / ${adminPassword}`);
        } else {
            console.log(`Admin already exists: ${adminEmail}`);
        }

        // Seed User
        const userPhone = '7777777777';
        let user = await FoodUser.findOne({ phone: userPhone });
        if (!user) {
            user = new FoodUser({
                phone: userPhone,
                name: 'Test User',
                isVerified: true
            });
            await user.save();
            console.log(`User seeded: ${userPhone}`);
        } else {
            console.log(`User already exists: ${userPhone}`);
        }

        // Seed Restaurant
        const restPhone = '9999999999';
        let rest = await FoodRestaurant.findOne({ ownerPhone: restPhone });
        if (!rest) {
            rest = new FoodRestaurant({
                restaurantName: 'Test Restaurant',
                ownerName: 'Test Owner',
                ownerPhone: restPhone,
                primaryContactNumber: restPhone,
                status: 'approved',
                pureVegRestaurant: false,
                isAcceptingOrders: true
            });
            await rest.save();
            console.log(`Restaurant seeded: ${restPhone}`);
        } else {
            console.log(`Restaurant already exists: ${restPhone}`);
        }

        // Seed Delivery Partner
        const dpPhone = '8888888888';
        let dp = await FoodDeliveryPartner.findOne({ phone: dpPhone });
        if (!dp) {
            dp = new FoodDeliveryPartner({
                name: 'Test Delivery Boy',
                phone: dpPhone,
                status: 'approved',
                availabilityStatus: 'online'
            });
            await dp.save();
            console.log(`Delivery Partner seeded: ${dpPhone}`);
        } else {
            console.log(`Delivery Partner already exists: ${dpPhone}`);
        }

        console.log('Seeding complete.');
    } catch (e) {
        console.error('Error seeding data:', e);
    } finally {
        await mongoose.disconnect();
    }
}

seed();
