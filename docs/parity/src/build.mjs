#!/usr/bin/env node
// Regenerate docs/parity/{obligations.json,typora-parity.md} and docs/parity/rea/* .
//   PARITY_SPEC=…/typora-re/parity-spec.md PARITY_SECTIONS=…/typora-re/sections REA_DIST=…/rea/dist \
//   node docs/parity/src/build.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadInventory, counts, sha256 } from './inventory.mjs';
import { buildReaInputs } from './rea.mjs';
import { renderMarkdown } from './render.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const home = process.env.HOME;
const specPath = process.env.PARITY_SPEC ?? `${home}/workspace/claudedesktop/typora-re/parity-spec.md`;
const sectionsDir = process.env.PARITY_SECTIONS ?? `${home}/workspace/claudedesktop/typora-re/sections`;
const reaDist = process.env.REA_DIST ?? '/tmp/rea/dist';
const reaBin = process.env.REA_BIN ?? 'rea';
const out = join(repo, 'docs/parity');
const reaOut = join(out, 'rea');

const inv = loadInventory({ repo, specPath });
const uncovered = Object.values(inv.uncovered).flat();
if (inv.errors.length || uncovered.length) {
  console.error([...inv.errors, ...uncovered.map((u) => `uncovered spec label: ${u}`)].join('\n'));
  process.exit(1);
}

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const headSha = git('rev-parse', 'HEAD');
const tracked = ['src', 'src-tauri/src', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'tests', 'package.json', 'package-lock.json', 'index.html', 'vite.config.ts'];
const artifactSha256 = sha256(git('ls-tree', '-r', 'HEAD', '--', ...tracked));

const { ledgerInput, coverageInput, captures } = await buildReaInputs({ repo, inv, reaDist, specPath, sectionsDir, artifactSha256, headSha });
mkdirSync(reaOut, { recursive: true });
const write = (p, v) => writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 1) + '\n');
// Inputs embed the bundle; keep inputs without it small and reviewable, plus the bundle once.
writeFileSync(join(reaOut, 'evidence-bundle.json.gz'), gzipSync(JSON.stringify(ledgerInput.evidence_bundle), { level: 9 }));
write(join(reaOut, 'ledger-input.json'), { ...ledgerInput, evidence_bundle: '<see evidence-bundle.json.gz>' });
write(join(reaOut, 'coverage-input.json'), { ...coverageInput, coverage: { ...coverageInput.coverage, evidence_bundle: '<see evidence-bundle.json.gz>' } });

const runRea = (cmd, input, name) => {
  const tmp = join(reaOut, `.${name}.full.json`);
  write(tmp, input);
  const res = execFileSync(reaBin, [cmd, tmp, '--format', 'json'], { encoding: 'utf8', maxBuffer: 512 << 20 });
  execFileSync('rm', [tmp]);
  return JSON.parse(res);
};
const ledger = runRea('build-reconstruction-obligation-ledger', ledgerInput, 'ledger');
const coverage = runRea('evaluate-reconstruction-coverage', coverageInput, 'coverage');
write(join(reaOut, 'ledger-output.json'), ledger);
write(join(reaOut, 'coverage-output.json'), coverage);

// Summaries.
const L = ledger.normalized_result;
const C = coverage.normalized_result ?? coverage;
const reasonsBy = {};
for (const r of C.reasons ?? []) (reasonsBy[r.code] ??= []).push(r.subject_id);
const claimProblems = new Set((C.reasons ?? []).filter((r) => r.subject_id.startsWith('claim.')).map((r) => r.subject_id));
const qualified = coverageInput.coverage.claims.filter((c) => !claimProblems.has(c.claim_id)).map((c) => c.claim_id);
const runs = Object.fromEntries(Object.entries(captures).map(([k, v]) => [k, { evidence_id: v.evidence_id, exit: v.normalized_result.exit.code, completed_at: v.normalized_result.manifest.completed_at }]));
const summary = {
  head: headSha,
  artifact_sha256: artifactSha256,
  inventory: counts(inv.surfaces),
  ledger: { ledger_id: L.ledger_id, closure_digest: L.closure_digest, status: L.status, summary: L.summary, evidence_id: ledger.evidence_id },
  coverage: { status: C.status, reason_counts: Object.fromEntries(Object.entries(reasonsBy).map(([k, v]) => [k, v.length])), claims_total: coverageInput.coverage.claims.length, claims_qualified_by_controlled_replay: qualified.length, evidence_ids_cited: (C.evidence_ids ?? []).length },
  verifier_runs: runs,
};
write(join(reaOut, 'summary.json'), summary);
const obligations = inv.surfaces.map((s) => {
  const ob = L.obligations.find((o) => o.obligation_id === `typora.${s.id}`);
  return { obligation_id: `typora.${s.id}`, id: s.id, title: s.title, status: s.status, priority: s.priority === null ? null : `P${s.priority}`, epic: s.e ?? null, owner: s.ownerFile ? { path: s.ownerFile, anchor: s.ownerAnchor, sha256: s.ownerSha256 } : null, verifier: s.verifier ? { file: s.verifierFile, test: s.verifierTitle, kind: s.verifierKind } : null, spec: { menu: s.A ?? [], panel: s.B ?? [], bridge: s.C ?? [], prose: s.sec ?? [] }, note: s.note ?? null, out_of_scope_rationale: s.why ?? null, rea_ledger_status: ob?.status ?? null, rea_diagnostics: (ob?.diagnostics ?? []).map((d) => d.code), coverage_claim_qualified: qualified.includes(`claim.${s.id}`) };
});
write(join(out, 'obligations.json'), { generated_from: { spec: 'typora-re/parity-spec.md', prose: 'typora-re/sections/*.md', margin_head: headSha }, summary, obligations });
write(join(out, 'typora-parity.md'), renderMarkdown({ inv, summary, obligations }));
console.log(JSON.stringify(summary, null, 1));
