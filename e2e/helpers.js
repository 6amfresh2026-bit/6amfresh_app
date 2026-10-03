import { expect } from '@playwright/test'

/**
 * Collects everything that should never happen while a page is in use: an
 * uncaught exception, a console error, an API call that answered 4xx/5xx.
 * Call `watch(page)` before navigating and `problems()` afterwards.
 *
 * This is the programmatic version of "open every screen and look at the
 * console", which is how most of the seller and admin bugs were first found.
 */
const NOISE = [
  // Realtime-database tracking is off unless VITE_FIREBASE_DATABASE_URL is set.
  /FIREBASE FATAL ERROR|Cannot parse Firebase url/i,
  // CI has no Google Maps key; a map that cannot load is expected there.
  /Google Maps|maps\.googleapis|ApiProjectMapError|InvalidKeyMapError|MissingKeyMapError|RefererNotAllowedMapError/i,
  // The HTTP failure itself is caught by the response listener, with its URL.
  /Failed to load resource/i,
  // Browser features the headless runner does not have.
  /Notification|serviceWorker|Service worker|vibrate|Autoplay|play\(\) failed/i,
  /ResizeObserver loop/i,
];

// API calls that legitimately answer an error for a fresh, empty database.
const EXPECTED_HTTP = [
  { status: 404, url: /\/(landing|notifications|my-offers).*/ },
];

export function watch(page) {
  const found = [];
  page.on('pageerror', (err) => found.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (NOISE.some((re) => re.test(text))) return;
    found.push(`console: ${text.slice(0, 200)}`);
  });
  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('/api/v1/')) return;
    const status = res.status();
    if (status < 400) return;
    if (EXPECTED_HTTP.some((e) => e.status === status && e.url.test(url))) return;
    found.push(`http ${status}: ${res.request().method()} ${url.replace(/^.*\/api\/v1/, '')}`);
  });
  return { problems: () => [...found], clear: () => (found.length = 0) };
}

/** Opens a route, lets it settle, and asserts it rendered something and broke nothing. */
export async function expectCleanPage(page, path, { minText = 20 } = {}) {
  const w = watch(page);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  expect(text.length, `${path} rendered almost nothing (blank page?)`).toBeGreaterThan(minText);
  expect(w.problems(), `${path} raised errors`).toEqual([]);
  return text;
}

/** Types an OTP into a row of single-digit boxes, which auto-advance. */
export async function typeOtp(page, otp) {
  const first = page.locator('input').first();
  await first.waitFor({ state: 'visible', timeout: 15_000 });
  await first.click();
  await page.keyboard.type(otp, { delay: 80 });
}
