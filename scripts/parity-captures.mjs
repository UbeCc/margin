#!/usr/bin/env node
// Record the parity ledger's verifier runs and package proofs as genuine REA process captures
// (`rea capture-process`, predicate rea.process-capture) into docs/parity/rea/evidence/, then
// regenerate the ledger with `node docs/parity/src/build.mjs`.
//   node scripts/parity-captures.mjs [name…]     names: build independence vitest playwright cargo-test clean-install
// Env: REA_BIN (default `rea`), E2E_PORT (default 5601). Run on a clean, committed tree:
// the clean-install proof clones HEAD, the other runs use this checkout.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const which = (b) => execFileSync('/usr/bin/which', [b], { encoding: 'utf8' }).trim();
const H = 3_600_000;
const SCENARIOS = {
  build: { executable: which('npm'), arguments: ['run', 'build'], environment: { NO_COLOR: '1' }, timeout_ms: 600_000 },
  independence: { executable: which('node'), arguments: ['docs/parity/src/independence.mjs'], timeout_ms: 60_000 },
  vitest: { executable: which('npx'), arguments: ['vitest', 'run'], timeout_ms: 900_000 },
  playwright: { executable: which('npx'), arguments: ['playwright', 'test', '--reporter=dot'], environment: { E2E_PORT: process.env.E2E_PORT ?? '5601', CI: '1', PW_BROWSERS: 'chromium,webkit' }, timeout_ms: 1_800_000 },
  'cargo-test': { executable: which('cargo'), arguments: ['test', '--quiet'], working_directory: join(repo, 'src-tauri'), timeout_ms: H },
  'clean-install': { executable: '/bin/bash', arguments: ['scripts/clean-install-proof.sh', 'HEAD'], timeout_ms: H },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
const out = join(repo, 'docs/parity/rea/evidence');
mkdirSync(out, { recursive: true });
const rea = process.env.REA_BIN ?? 'rea';
let failed = 0;
for (const name of names) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`unknown capture ${name}`);
  const scenario = {
    working_directory: repo,
    environment: {},
    terminal: { columns: 200, rows: 50, scrollback: 4000 },
    idle_timeout_ms: 600_000,
    limits: { output_bytes: 1_000_000, files: 10000, file_bytes: 10_000_000, processes: 1000, filesystem_depth: 16 },
    ...sc,
  };
  const path = join(tmpdir(), `margin-capture-${name}.json`);
  writeFileSync(path, JSON.stringify(scenario));
  const t0 = Date.now();
  const r = spawnSync(rea, ['capture-process', path, '--format', 'json'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`${name}: rea failed (${r.status}): ${r.stderr.slice(-2000)}`);
  const ev = JSON.parse(r.stdout);
  if (ev.predicate_type !== 'rea.process-capture') throw new Error(`${name}: unexpected predicate ${ev.predicate_type}`);
  const exit = ev.normalized_result.exit;
  writeFileSync(join(out, `capture-${name}.json.gz`), gzipSync(JSON.stringify(ev), { level: 9 }));
  console.log(`${name}: exit ${exit.code} (${exit.reason}) in ${Math.round((Date.now() - t0) / 1000)}s ${ev.evidence_id}`);
  if (exit.code !== 0) failed++;
}
process.exit(failed ? 1 : 0);
