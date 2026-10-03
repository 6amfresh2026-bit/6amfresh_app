import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config/env.js';
import { fetchDrivingRoute } from '../src/modules/food/orders/utils/googleMaps.js';
import { getDeliveryDistanceKm } from '../src/modules/food/orders/services/order-pricing.service.js';

/**
 * Google Directions, as the backend uses it.
 *
 * Every price a customer sees and every km a rider is shown comes from this one
 * call, and it runs on a billed key that can be revoked, restricted or out of
 * quota at any time. The contract that matters is not "it returns a route" but
 * "when it cannot, nothing throws and the caller falls back".
 */

const ORIGIN = { lat: 17.385, lng: 78.4867 };
const DEST = { lat: 17.4282, lng: 78.4137 };

const realFetch = globalThis.fetch;
let realKey;
let calls;

const stubFetch = (impl) => {
    calls = [];
    globalThis.fetch = async (url, opts) => {
        calls.push(String(url));
        return impl(url, opts);
    };
};
const jsonResponse = (body) => ({ ok: true, json: async () => body });

beforeEach(() => {
    realKey = config.googleMapsApiKey;
    config.googleMapsApiKey = 'test-key';
    calls = [];
});
afterEach(() => {
    config.googleMapsApiKey = realKey;
    globalThis.fetch = realFetch;
});

describe('fetchDrivingRoute', () => {
    it('sums every leg and rounds km to two places', async () => {
        stubFetch(() =>
            jsonResponse({
                status: 'OK',
                routes: [
                    {
                        overview_polyline: { points: 'abc' },
                        legs: [
                            { distance: { value: 6000 }, duration: { value: 600 }, steps: [] },
                            { distance: { value: 7090 }, duration: { value: 660 }, steps: [] }
                        ]
                    }
                ]
            })
        );

        const route = await fetchDrivingRoute(ORIGIN, DEST);

        assert.equal(route.distanceMeters, 13090);
        assert.equal(route.distanceKm, 13.09);
        assert.equal(route.durationSeconds, 1260);
        assert.equal(route.polyline, 'abc', 'falls back to the overview line when no step geometry exists');
    });

    it('asks for driving directions between the two points, with the configured key', async () => {
        stubFetch(() => jsonResponse({ status: 'OK', routes: [{ legs: [{ distance: { value: 1000 }, duration: { value: 60 } }] }] }));
        await fetchDrivingRoute(ORIGIN, DEST);

        assert.equal(calls.length, 1);
        assert.match(calls[0], /directions\/json/);
        assert.match(calls[0], /origin=17\.385,78\.4867/);
        assert.match(calls[0], /destination=17\.4282,78\.4137/);
        assert.match(calls[0], /mode=driving/);
        assert.match(calls[0], /key=test-key/);
    });

    it('returns an empty route, not an error, when Google finds no road', async () => {
        stubFetch(() => jsonResponse({ status: 'ZERO_RESULTS', routes: [] }));
        const route = await fetchDrivingRoute(ORIGIN, DEST);
        assert.deepEqual(route, { polyline: '', distanceMeters: null, durationSeconds: null, distanceKm: null });
    });

    it('returns an empty route when the key is rejected', async () => {
        stubFetch(() => jsonResponse({ status: 'REQUEST_DENIED', error_message: 'API key invalid', routes: [] }));
        const route = await fetchDrivingRoute(ORIGIN, DEST);
        assert.equal(route.distanceKm, null);
    });

    it('swallows a network failure', async () => {
        stubFetch(() => {
            throw new Error('socket hang up');
        });
        const route = await fetchDrivingRoute(ORIGIN, DEST);
        assert.equal(route.distanceKm, null);
    });

    it('does not call Google at all without a key', async () => {
        config.googleMapsApiKey = '';
        stubFetch(() => jsonResponse({}));
        const route = await fetchDrivingRoute(ORIGIN, DEST);
        assert.equal(calls.length, 0);
        assert.equal(route.distanceKm, null);
    });

    it('does not call Google for a point that is not a coordinate', async () => {
        stubFetch(() => jsonResponse({}));
        assert.equal((await fetchDrivingRoute({ lat: 'x', lng: 1 }, DEST)).distanceKm, null);
        assert.equal((await fetchDrivingRoute(null, DEST)).distanceKm, null);
        assert.equal(calls.length, 0);
    });
});

describe('getDeliveryDistanceKm', () => {
    const restaurant = { location: { type: 'Point', coordinates: [ORIGIN.lng, ORIGIN.lat] } };
    const address = { location: { type: 'Point', coordinates: [DEST.lng, DEST.lat] } };

    it('prefers the road distance Google reports', async () => {
        stubFetch(() => jsonResponse({ status: 'OK', routes: [{ legs: [{ distance: { value: 13090 }, duration: { value: 1 } }] }] }));
        assert.equal(await getDeliveryDistanceKm(restaurant, address), 13.09);
    });

    it('falls back to straight-line when Google cannot route, so a price is still quoted', async () => {
        stubFetch(() => jsonResponse({ status: 'REQUEST_DENIED', routes: [] }));
        const km = await getDeliveryDistanceKm(restaurant, address);
        assert.ok(Number.isFinite(km) && km > 8 && km < 11, `expected ~9.3 km straight-line, got ${km}`);
    });

    it('falls back to straight-line when the request throws', async () => {
        stubFetch(() => {
            throw new Error('ECONNRESET');
        });
        const km = await getDeliveryDistanceKm(restaurant, address);
        assert.ok(Number.isFinite(km) && km > 0);
    });
});
