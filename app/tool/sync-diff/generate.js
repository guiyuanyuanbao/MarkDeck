// Differential fixture generator: drives the REAL TS engine
// (extension/src/reconcile.ts, transpiled by the extension's own tsc) over
// the shared scenario file in scenarios/engine_scenarios.json and writes
// plan snapshots to test/fixtures/engine_cases/. The Dart test
// (test/sync/engine_cases_test.dart) replays the same scenarios through the
// Dart port and asserts plan equality — a regression net spanning both
// engine implementations.
//
// Usage:
//   node generate.js            regenerate all fixtures
//   node generate.js --check    fail if fixtures would change (CI gate)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = resolve(import.meta.dirname, '../../..');
const extensionRoot = resolve(repoRoot, 'extension');
const tscBin = resolve(extensionRoot, 'node_modules/.bin/tsc');
const scenariosDir = resolve(import.meta.dirname, 'scenarios');
const outDir = resolve(import.meta.dirname, '../../test/fixtures/engine_cases');
const tmpOut = resolve(import.meta.dirname, '.ts-build');

// transpile the TS engine once with the extension's own tsc
mkdirSync(tmpOut, { recursive: true });
execFileSync('cmd.exe', ['/c', resolve(extensionRoot, 'node_modules/.bin/tsc.cmd'),
  '--ignoreConfig', '--module', 'es2022', '--target', 'es2022',
  '--outDir', tmpOut, resolve(extensionRoot, 'src/reconcile.ts'),
], { cwd: extensionRoot });
const engine = await import(pathToFileURL(join(tmpOut, 'reconcile.js')).href);

const check = process.argv.includes('--check');
mkdirSync(outDir, { recursive: true });

let failures = 0;
let count = 0;
for (const file of readdirSync(scenariosDir).filter((f) => f.endsWith('.json'))) {
  const scenarios = JSON.parse(readFileSync(join(scenariosDir, file), 'utf8'));
  for (const scenario of scenarios) {
    count++;
    const input = {
      server: scenario.server,
      local: scenario.local,
      base: scenario.base ?? null,
      touch: scenario.touch ?? {},
      deviceId: scenario.deviceId ?? 'dev-1',
      now: scenario.now ?? 2000,
      othersId: scenario.othersId ?? 'md-others',
    };
    const plan = engine.planSync(input);

    // canonical snapshot: server ops carry their wire fields verbatim
    const snapshot = {
      scenario: scenario.name,
      chromeOps: plan.chromeOps,
      serverOps: plan.serverOps.map((o) => ({
        op: o.op,
        id: o.id,
        ...(o.parentId !== undefined ? { parentId: o.parentId } : {}),
        ...(o.type !== undefined ? { type: o.type } : {}),
        ...(o.title !== undefined ? { title: o.title } : {}),
        ...(o.url !== undefined ? { url: o.url } : {}),
        ...(o.position !== undefined ? { position: o.position } : {}),
        ...(o.tags !== undefined ? { tags: o.tags } : {}),
        ...(o.undelete ? { undelete: true } : {}),
        updatedAt: o.updatedAt,
        deviceId: o.deviceId,
        ...(o.observedRevision ? { observedRevision: o.observedRevision } : {}),
      })),
      newBase: Object.fromEntries(
        Object.entries(plan.newBaseEntries).map(([sid, e]) => [
          sid,
          { server: e.server, localId: e.localId },
        ]),
      ),
      stats: plan.stats,
    };
    const json = JSON.stringify(snapshot, null, 2) + '\n';
    const outFile = join(outDir, file.replace(/\.json$/, `-${slug(scenario.name)}.json`));
    if (check) {
      const existing = readFileSync(outFile, 'utf8');
      if (existing !== json) {
        console.error(`MISMATCH: ${outFile} — TS engine output diverged from the committed fixture`);
        failures++;
      } else {
        console.log(`ok   ${basename(outFile)}`);
      }
    } else {
      writeFileSync(outFile, json);
      console.log(`wrote ${basename(outFile)}`);
    }
  }
}

try {
  rmSync(tmpOut, { recursive: true, force: true });
} catch { /* best-effort cleanup */ }

if (failures > 0) {
  console.error(`${failures} fixture(s) diverged — regenerate with: node generate.js`);
  process.exit(1);
}
console.log(`${count} scenario(s) consistent with the TS engine`);

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}
