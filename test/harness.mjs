/* Minimal test harness — same shape as the shipped magnet-pick suite:
   plain Node, no framework, `node test/<file>` runs it. */

let passed = 0;
let failed = 0;
const failures = [];
let currentSuite = '';

export function suite(name) {
  currentSuite = name;
  console.log(`\n${name}`);
}

export async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ suite: currentSuite, name, error: e });
    console.log(`  ✗ ${name}\n      ${e && e.message}`);
  }
}

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}

export function eq(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

export function deepEq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(msg || `expected ${sb}, got ${sa}`);
}

export function throws(fn, msg = 'expected a throw') {
  try { fn(); } catch { return; }
  throw new Error(msg);
}

export function report(label) {
  console.log(`\n${label}\n  passed: ${passed}\n  failed: ${failed}`);
  if (failed) {
    console.log('  FAILURES:');
    for (const f of failures) console.log(`   - ${f.suite} › ${f.name}: ${f.error.message}`);
    process.exitCode = 1;
  } else {
    console.log('  ALL GREEN ✓');
  }
}
