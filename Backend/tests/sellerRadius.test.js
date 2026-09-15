import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertWithinSellerRadius } from '../src/modules/food/orders/services/order.service.js';

/**
 * How far into its block a store will actually go.
 *
 * The zone says which block a store serves, and that was the whole of the
 * check: a zone can be several kilometres across, so a store at one edge was
 * accepting orders for the far side of it and promising ten minutes.
 *
 * Admin-set, and off until an admin sets it, so nothing changes for a store
 * nobody has configured.
 */

// Hyderabad, roughly. A degree of latitude is ~111 km, which makes the
// distances below easy to reason about.
const STORE = { location: { type: 'Point', coordinates: [78.4867, 17.385] } };
const near = { lat: 17.3895, lng: 78.4867 };   // ~0.5 km north
const far = { lat: 17.475, lng: 78.4867 };     // ~10 km north

const store = (radiusKm) => ({ ...STORE, deliveryRadiusKm: radiusKm });

const refusal = (restaurant, point) => {
    try {
        assertWithinSellerRadius(restaurant, point);
        return null;
    } catch (err) {
        return err.message;
    }
};

describe('a store with a delivery radius', () => {
    it('accepts an address inside it', () => {
        assert.equal(refusal(store(3), near), null);
    });

    it('refuses one beyond it, and says how far beyond', () => {
        // "Outside the delivery area" reads as a bug to somebody standing just
        // past the line, and tells support nothing they can act on.
        const message = refusal(store(3), far);
        assert.match(message, /delivers within 3 km/);
        assert.match(message, /about 10\.\d km away/);
    });

    it('accepts an address exactly on the line', () => {
        // A boundary that refuses the address it is drawn through would make the
        // configured figure mean something slightly smaller than it says.
        const onTheLine = { lat: 17.385 + 3 / 111, lng: 78.4867 };
        assert.equal(refusal(store(3.05), onTheLine), null);
    });
});

describe('a store with no radius set', () => {
    it('serves any address, which is what every store does today', () => {
        assert.equal(refusal(store(0), far), null);
        assert.equal(refusal({ ...STORE }, far), null);
        assert.equal(refusal({ ...STORE, deliveryRadiusKm: null }, far), null);
    });
});

describe('a store that cannot be measured from', () => {
    it('is not refused for its own missing coordinates', () => {
        // The customer would be the one punished, and the zone check has already
        // placed the address inside the store's block.
        assert.equal(refusal({ deliveryRadiusKm: 1 }, far), null);
        assert.equal(refusal({ location: {}, deliveryRadiusKm: 1 }, far), null);
    });
});
