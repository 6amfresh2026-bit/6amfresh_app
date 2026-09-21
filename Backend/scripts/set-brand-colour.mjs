/**
 * Sets a module's brand colour in business settings.
 *
 * The colour lives in the database, not in the code. Changing the schema
 * default only affects a settings document that does not exist yet, and
 * buildPowerScanningPayload feeds the stored value in as both the payload and
 * its own fallback -- so a deployment already carrying the old colour keeps it
 * forever, however many times the code is redeployed. That is the whole reason
 * a brand change can look like it "did not deploy".
 *
 * Idempotent: running it twice is a no-op the second time. It touches exactly
 * one field per module named and leaves fonts, logos and every other setting
 * alone.
 *
 *   node scripts/set-brand-colour.mjs --check
 *   node scripts/set-brand-colour.mjs --user=#47B8AE
 *   node scripts/set-brand-colour.mjs --user=#47B8AE --restaurant=#2563EB
 *
 * --check reads and prints without writing anything. Run it first.
 *
 * After it writes, the panels pick the colour up on their next load; a browser
 * with the old settings cached clears it on a reload, because the cache is
 * refreshed from this same document.
 */
import 'dotenv/config';

import { connectDB, disconnectDB } from '../src/config/db.js';
import { FoodBusinessSettings } from '../src/modules/food/admin/models/businessSettings.model.js';

const MODULES = ['user', 'restaurant', 'delivery'];

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

const wanted = {};
for (const arg of args) {
    const match = /^--(user|restaurant|delivery)=(.+)$/.exec(arg);
    if (!match) continue;
    const [, moduleName, rawColour] = match;
    const colour = rawColour.trim().toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(colour)) {
        console.error(`Not a 6-digit hex colour: ${rawColour}`);
        process.exit(2);
    }
    wanted[moduleName] = colour;
}

if (!checkOnly && Object.keys(wanted).length === 0) {
    console.error('Nothing to do. Pass --check, or --user=#RRGGBB (and/or --restaurant=, --delivery=).');
    process.exit(2);
}

const run = async () => {
    await connectDB();

    const settings = await FoodBusinessSettings.findOne();
    if (!settings) {
        // Nothing stored means the defaults in the model are already in force,
        // and those are whatever the code says. There is nothing to correct.
        console.log('No business settings document exists yet; the schema defaults apply as-is.');
        return 0;
    }

    const current = settings.powerScanning || {};
    console.log('Current brand colours:');
    for (const moduleName of MODULES) {
        console.log(`  ${moduleName.padEnd(11)} ${current?.[moduleName]?.themeColor || '(unset)'}`);
    }

    if (checkOnly) return 0;

    const changes = [];
    for (const [moduleName, colour] of Object.entries(wanted)) {
        const existing = current?.[moduleName]?.themeColor || null;
        if (existing === colour) continue;
        settings.set(`powerScanning.${moduleName}.themeColor`, colour);
        changes.push(`${moduleName}: ${existing || '(unset)'} -> ${colour}`);
    }

    if (changes.length === 0) {
        console.log('\nAlready set to those colours; nothing written.');
        return 0;
    }

    await settings.save();
    console.log('\nWritten:');
    changes.forEach((line) => console.log(`  ${line}`));
    console.log('\nReload an admin/seller/rider page to see it.');
    return 0;
};

let exitCode = 1;
try {
    exitCode = await run();
} catch (error) {
    console.error(`Failed: ${error.message}`);
    exitCode = 1;
} finally {
    await disconnectDB();
}
process.exit(exitCode);
