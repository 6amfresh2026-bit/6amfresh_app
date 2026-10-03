#!/usr/bin/env node
/**
 * Fails the build when a credential is committed.
 *
 *   node .github/scripts/scan-secrets.mjs            # scan every tracked file
 *   node .github/scripts/scan-secrets.mjs --selftest # prove the rules still fire
 *
 * Why this exists: Backend/seed_users.js carried a MongoDB Atlas connection
 * string, username and password included, from the very first commit. Nothing
 * noticed for a month. The fix for a leaked secret is rotation, not deletion, so
 * the point of this check is to stop the *next* one reaching the history at all.
 *
 * It reads tracked files only (`git ls-files`), so a developer's gitignored
 * .env never trips it and nothing in node_modules is scanned.
 *
 * Deliberately dependency-free, like the build-config guard next to it: a CI
 * check that needs an action from the marketplace is a check an attacker can
 * swap out.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Placeholders that look like a credential but are documentation.
const PLACEHOLDER = /(<[^>]+>|\*{3,}|x{4,}|your[-_ ]?|example|changeme|password|passwd|secret|user:pass|username|\$\{|%s|\{\{)/i;

const RULES = [
  {
    id: 'database-uri-with-password',
    // scheme://user:password@host -- for mongodb, postgres, mysql, redis, amqp
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|rediss?|amqps?):\/\/([^\s'"`:@/]+):([^\s'"`@]{3,})@[^\s'"`/]+/g,
    // The password alone decides: a host or user that happens to contain a word
    // like "example" must not excuse a real password.
    allow: (m) => PLACEHOLDER.test(m[2]),
  },
  {
    id: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    id: 'razorpay-live-key',
    re: /\brzp_live_[0-9A-Za-z]{10,}\b/g,
  },
  {
    id: 'razorpay-live-secret-assignment',
    re: /RAZORPAY_(?:KEY_)?SECRET\s*[=:]\s*['"]?([0-9A-Za-z]{20,})['"]?/g,
    allow: (m) => PLACEHOLDER.test(m[1]),
  },
  {
    id: 'github-token',
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[0-9A-Za-z_]{30,}\b/g,
  },
  {
    id: 'aws-access-key',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'slack-token',
    re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g,
  },
  {
    id: 'stripe-live-key',
    re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g,
  },
  {
    id: 'google-api-key',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
];

// Known, intentional, and public by design. Each needs a reason; none is a
// wildcard. A Firebase *web* config key identifies the project to the browser and
// is protected by Firebase rules and HTTP-referrer restrictions, not by secrecy.
const ALLOW = [
  {
    file: 'Frontend/src/modules/Food/pages/admin/system/FirebaseNotification.jsx',
    rule: 'google-api-key',
    why: 'Firebase web config shown as the form default; public by design',
  },
];

const SKIP_PATH = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.github\/scripts\/scan-secrets\.mjs)$/;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|svg|mp3|wav|mp4|woff2?|ttf|eot|pdf|zip|gz|docx|xlsx|lock)$/i;
const MAX_BYTES = 2_000_000;

export function scanText(text, file = '<text>') {
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      if (rule.allow?.(m)) continue;
      if (ALLOW.some((a) => a.file === file && a.rule === rule.id)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ file, line, rule: rule.id });
    }
  }
  return hits;
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

function scanTree() {
  const hits = [];
  for (const file of trackedFiles()) {
    if (SKIP_PATH.test(file) || SKIP_EXT.test(file)) continue;
    let size;
    try {
      size = statSync(file).size;
    } catch {
      continue; // deleted in the working tree
    }
    if (size > MAX_BYTES) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    hits.push(...scanText(text, file));
  }
  return hits;
}

// Fixtures are assembled at run time so this file never contains a literal that
// would match its own rules.
function selftest() {
  const j = (...p) => p.join('');
  const cases = [
    { name: 'a database URI with a real-looking password is caught', text: j('mongodb+srv://app_user:', 'Zk3', 'pQ9vT1xW@cluster0.example.mongodb.net/db'), expect: 1 },
    { name: 'a plain mongodb URI with a password is caught', text: j('mongodb://admin:', 'hunter', '22@10.0.0.5:27017/x'), expect: 1 },
    { name: 'a credential-less URI is not flagged', text: 'mongodb://127.0.0.1:27018/switcheats_dev', expect: 0 },
    { name: 'a placeholder password is not flagged', text: 'mongodb://user:<password>@host/db and mongodb://user:password@host/db', expect: 0 },
    { name: 'a templated URI is not flagged', text: 'mongodb://u:${DB_PASSWORD}@host/db', expect: 0 },
    { name: 'a private key header is caught', text: j('-----BEGIN ', 'RSA PRIVATE KEY-----'), expect: 1 },
    { name: 'a razorpay live key is caught', text: j('rzp_', 'live_', 'AbCdEf1234567890'), expect: 1 },
    { name: 'a razorpay test key id is allowed', text: j('rzp_', 'test_', 'AbCdEf1234567890'), expect: 0 },
    { name: 'a github token is caught', text: j('ghp_', 'a'.repeat(36)), expect: 1 },
    { name: 'an aws access key is caught', text: j('AKIA', 'ABCDEFGHIJKLMNOP'), expect: 1 },
    { name: 'a google api key is caught', text: j('AIza', 'Sy', 'A'.repeat(33)), expect: 1 },
    { name: 'ordinary code is not flagged', text: "const uri = process.env.MONGO_URI; fetch('https://api.example.com')", expect: 0 },
  ];

  let failed = 0;
  for (const c of cases) {
    const got = scanText(c.text, 'fixture.js').length;
    const ok = got === c.expect;
    if (!ok) failed += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${c.name} (expected ${c.expect}, got ${got})`);
  }

  const allowed = scanText(
    j('AIza', 'Sy', 'A'.repeat(33)),
    'Frontend/src/modules/Food/pages/admin/system/FirebaseNotification.jsx',
  ).length;
  const allowedOk = allowed === 0;
  if (!allowedOk) failed += 1;
  console.log(`  ${allowedOk ? 'ok  ' : 'FAIL'}  the documented Firebase web key is allowed in its own file (expected 0, got ${allowed})`);

  const elsewhere = scanText(j('AIza', 'Sy', 'A'.repeat(33)), 'Backend/src/config/anything.js').length;
  const elseOk = elsewhere === 1;
  if (!elseOk) failed += 1;
  console.log(`  ${elseOk ? 'ok  ' : 'FAIL'}  the same key anywhere else is still caught (expected 1, got ${elsewhere})`);

  if (failed) {
    console.error(`\n${failed} self-check(s) failed: the scanner has stopped detecting things.`);
    process.exit(1);
  }
  console.log('\nself-checks passed');
}

if (process.argv.includes('--selftest')) {
  selftest();
} else if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const hits = scanTree();
  if (hits.length) {
    console.error('Committed credentials found (values are not printed):\n');
    for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.rule}`);
    console.error(
      '\nRemoving the line is not enough: anything that reached the history must be rotated.\n' +
        'Move the value to an environment variable, rotate the credential, and re-run.',
    );
    process.exit(1);
  }
  console.log('No committed credentials found.');
}
