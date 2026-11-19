#!/usr/bin/env node
/**
 * Apply ONE footgun patch on top of the clean baseline, run the suite, then revert the patch.
 *
 * A suite is only worth trusting if it goes red when the code makes the mistakes real systems
 * make. Each footgun reintroduces one of them with a one-line change; the manifest names the
 * tests that must catch it. The verdict is strict:
 *
 *   PASS (exit 0)  exactly the documented tests failed, every other test stayed green
 *   FAIL (exit 1)  a documented test stayed green, an undocumented test failed, or the runner broke
 *
 * Usage: npm run footgun <name> | npm run footgun -- --all
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'footguns', 'manifest.json'), 'utf8'));

const arg = process.argv[2];
if (arg === '--all') {
  let bad = 0;
  for (const name of Object.keys(manifest)) bad += runFootgun(name) ? 0 : 1;
  console.log(`\n${Object.keys(manifest).length - bad}/${Object.keys(manifest).length} footguns caught exactly as documented`);
  process.exit(bad ? 1 : 0);
}
if (!arg || !manifest[arg]) {
  console.error('Usage: npm run footgun <name> | npm run footgun -- --all\n\nAvailable footguns:');
  for (const [key, value] of Object.entries(manifest)) console.error(`  ${key}\n      ${value.description}`);
  process.exit(1);
}
process.exit(runFootgun(arg) ? 0 : 1);

function runFootgun(name) {
  const entry = manifest[name];
  const patch = join('footguns', `${name}.patch`);
  git(['apply', '--check', patch], `checking that ${patch} applies to the baseline`);
  git(['apply', patch], `applying footgun ${name}`);
  let failed;
  try {
    console.log(`\n--- footgun applied: ${name} -- ${entry.description}`);
    failed = failedTests();
  } finally {
    git(['apply', '-R', patch], `reverting footgun ${name}`);
  }
  if (failed === undefined) {
    console.error('the test runner produced no TAP report -- infrastructure failure, not a verdict.');
    return false;
  }
  const missing = entry.expectedFailures.filter((e) => !failed.some((f) => f.includes(e)));
  const unexpected = failed.filter((f) => !entry.expectedFailures.some((e) => f.includes(e)));
  for (const f of failed) console.log(`  x ${f}`);
  for (const m of missing) console.error(`  documented test stayed GREEN: ${m}`);
  for (const u of unexpected) console.error(`  undocumented test FAILED: ${u}`);
  const ok = !missing.length && !unexpected.length;
  console.log(ok ? `PASS: ${name}` : `FAIL: ${name}`);
  return ok;
}

/** Names of the failed tests (not suites), from the TAP stream of `node --test`. */
function failedTests() {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', 'test/**/*.test.ts'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = r.stdout ?? '';
  if (!/^# tests \d+/m.test(out)) return undefined;
  const lines = out.split(/\r?\n/);
  const failed = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i]);
    if (!m) continue;
    let type = 'test';
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
      const t = /^\s*type: '(\w+)'/.exec(lines[j]);
      if (t) {
        type = t[1];
        break;
      }
      if (/^\s*(not )?ok \d+ - /.test(lines[j])) break;
    }
    if (type !== 'suite') failed.push(m[1].replace(/\\#/g, '#'));
  }
  return failed;
}

function git(args, what) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`git ${args.join(' ')} failed while ${what}:\n${r.stderr}`);
    process.exit(1);
  }
}
