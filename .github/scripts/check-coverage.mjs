#!/usr/bin/env node
/**
 * Reads the coverage table `node --test --experimental-test-coverage` prints and
 * fails when total line coverage drops below a floor.
 *
 *   node .github/scripts/check-coverage.mjs <test-output.txt> [minLinePercent]
 *
 * A ratchet, not a target: the floor sits just under where coverage is today and
 * is raised when it climbs, so new code cannot quietly arrive untested. It also
 * writes a short table to the job summary so the number is visible on every run.
 */
import { readFileSync, appendFileSync } from 'node:fs';

const [file, minArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: check-coverage.mjs <test-output.txt> [minLinePercent]');
  process.exit(2);
}
const min = Number(minArg ?? process.env.COVERAGE_MIN_LINES ?? 50);

const text = readFileSync(file, 'utf8');
const row = text.split('\n').find((l) => /^ℹ\s*all files\s*\|/.test(l));
if (!row) {
  console.error('No "all files" coverage row found. Was the run started with --experimental-test-coverage?');
  process.exit(2);
}
const [, line, branch, funcs] = row.replace(/^ℹ\s*/, '').split('|').map((c) => c.trim());
const lines = Number(line);

const summary = [
  '### Backend coverage',
  '',
  '| Lines | Branches | Functions | Floor |',
  '|---|---|---|---|',
  `| ${line}% | ${branch}% | ${funcs}% | ${min}% |`,
  '',
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

if (!Number.isFinite(lines) || lines < min) {
  console.error(`Line coverage ${line}% is below the ${min}% floor.`);
  process.exit(1);
}
console.log(`Line coverage ${line}% meets the ${min}% floor.`);
