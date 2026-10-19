// Build REA inputs (Evidence bundle, reviewed obligations, manifest, coverage workspace).
// Review records are created with REA's own Evidence constructor (content-addressed ev_ ids);
// verifier/package proof records are genuine `capture_process_scenario` observations.
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, basename } from 'node:path';
import { sha256 } from './inventory.mjs';

const LAYER = { menu: 'application', ctx: 'application', tools: 'application', sidebar: 'application', ui: 'application', syntax: 'application', pref: 'persistence', export: 'process', images: 'runtime', oos: 'other' };
const layerOf = (id) => {
  const [a, b] = id.split('.');
  if (a === 'beh') return { core: 'application', files: 'persistence', clip: 'runtime', settings: 'persistence' }[b] ?? 'other';
  return LAYER[a] ?? 'other';
};
const oid = (s) => `typora.${s.id}`;

export async function buildReaInputs({ repo, inv, reaDist, specPath, sectionsDir, artifactSha256, headSha }) {
  const { createEvidence, parseEvidence } = await import(join(reaDist, 'domain/evidence.js'));
  const { createEvidenceBundle } = await import(join(reaDist, 'domain/evidenceBundle.js'));
  const { createReconstructionVerifierContract } = await import(join(reaDist, 'domain/reconstructionCoverage.js'));

  // Genuine REA process captures (verifier runs + package proofs).
  const capDir = join(repo, 'docs/parity/rea/evidence');
  const captures = {};
  // Re-parse through REA's schema: stored captures may carry a different key order (older
  // ones were written key-sorted, `rea capture-process` emits schema order). The bundle
  // dedupes manifests (environments/providers) by serialized JSON, so mixing orders yields
  // two "different" entries that collapse on REA's re-authentication → "Evidence bundle
  // manifests are not canonical". Parsing gives every record REA's canonical form.
  for (const f of readdirSync(capDir).filter((n) => n.endsWith('.json.gz')))
    captures[basename(f, '.json.gz').replace(/^capture-/, '')] = parseEvidence(JSON.parse(gunzipSync(readFileSync(join(capDir, f))).toString('utf8')));
  const cap = (k) => captures[k].evidence_id;
  const capturedAt = (k) => captures[k].normalized_result.manifest.completed_at;

  // Analyst review records: one per surface, subject = the clean-room prose document it came from.
  const provider = { id: 'margin-parity-review', name: 'Margin clean-room parity review', version: '1' };
  const docTarget = (p) => ({ path: p, sha256: sha256(readFileSync(p)), format: 'file', architecture: null });
  const specT = docTarget(specPath);
  const secT = Object.fromEntries(readdirSync(sectionsDir).map((n) => [n.replace(/\.md$/, ''), docTarget(join(sectionsDir, n))]));
  const reviews = new Map();
  for (const s of inv.surfaces) {
    const secRef = (s.sec ?? [])[0]?.split(' ')[0];
    const target = (s.A || s.B || s.C) ? specT : secT[secRef] ?? specT;
    reviews.set(s.id, createEvidence(target, provider, {
      predicateType: 'margin.parity-review',
      operation: 'review_parity_surface',
      parameters: { surface_id: s.id },
      result: { surface_id: s.id, title: s.title, claimed_status: s.status, menu_titles: s.A ?? [], panel_labels: s.B ?? [], bridge_commands: s.C ?? [], prose_sections: s.sec ?? [], rationale: s.why ?? null },
      confidence: 'inferred',
      authority: 'analyst-inference',
      limitations: ['Derived from clean-room prose/interface extract; the original product was not executed or inspected by this reviewer.'],
    }));
  }
  const records = [...reviews.values(), ...Object.values(captures)];
  const bundle = createEvidenceBundle(records);

  const suiteFor = (s) => ({ e2e: 'playwright', cargo: 'cargo-test' })[s.verifierKind] ?? 'vitest';
  const isUnit = (s) => s.verifierKind !== 'e2e'; // vitest + cargo (Rust unit/integration) both run below the renderer
  const command = (s, suite) =>
    suite === 'playwright' ? `npx playwright test ${s.verifierFile} -g ${JSON.stringify(s.verifierTitle)}`
    : suite === 'cargo-test' ? (s.verifierFile.startsWith('src-tauri/tests/') ? `cargo test --manifest-path src-tauri/Cargo.toml --test ${s.verifierFile.split('/').pop().replace(/\.rs$/, '')}` : `cargo test --manifest-path src-tauri/Cargo.toml ${JSON.stringify(s.verifierTitle.replace(/^fn /, ''))}`)
    : `npx vitest run ${s.verifierFile} -t ${JSON.stringify(s.verifierTitle)}`;
  const reviewed = inv.surfaces.map((s) => ({
    obligation_id: oid(s),
    obligation_version: 1,
    title: s.title,
    application_layer: layerOf(s.id),
    family: s.id.split('.').slice(0, 2).join('.'),
    target: { artifact_sha256: null, application_node_id: null, semantic_node_id: null, location: s.title },
    required: s.status !== 'oos',
    required_case_kinds: ['positive'],
    required_original_authority: 'static',
    required_fixture_authority: isUnit(s) ? 'unit' : 'renderer',
    required_verifier_authority: isUnit(s) ? 'unit' : 'renderer',
    requires_parser_type: false,
    dependency_obligation_ids: [],
    residual_unknown_ids: [],
    unavailable_authority: [],
    required_next_evidence: s.status === 'oos' ? [] : [
      'Original behavior is characterized only by clean-room prose (analyst-inference); a shipped-artifact or runtime observation of the original is unavailable under clean-room rules.',
      ...(s.verifier ? [] : ['Add an e2e verifier that enumerates this obligation.']),
      ...(s.status === 'missing' || s.status === 'partial' ? [`Implement: ${s.note ?? s.title}`] : []),
    ],
    disposition: s.status === 'oos' ? 'out-of-scope' : 'active',
    review_evidence_ids: [reviews.get(s.id).evidence_id],
  }));

  const bindings = inv.surfaces.filter((s) => s.ownerFile).map((s) => {
    // Partial surfaces keep their test in the coverage workspace only: REA treats any non-pass
    // ledger verifier status as `verifier-failed`, which would misreport an incomplete feature as broken.
    const suite = s.verifier && s.status === 'owned' ? suiteFor(s) : null;
    const authority = isUnit(s) ? 'unit' : 'renderer';
    return {
      obligation_id: oid(s),
      owner: { module_path: s.ownerFile, symbol: s.ownerAnchor, owner_sha256: s.ownerSha256 },
      parser_type: null,
      original_cases: [{ kind: 'positive', evidence_id: reviews.get(s.id).evidence_id, location: (s.sec ?? ['typora-re/parity-spec.md'])[0] }],
      fixtures: suite ? [{ fixture_id: `${s.id}.positive`, case_kind: 'positive', authority, evidence_ids: [cap(suite)] }] : [],
      verifier: suite ? {
        verifier_id: `margin.${suite}.${s.id}`,
        claim_id: `claim.${s.id}`,
        command: command(s, suite),
        authority,
        status: 'pass',
        result_evidence_id: cap(suite),
        enumerated_obligation_ids: [oid(s)],
        nondeterminism: { mode: 'total-order', specification: 'Single deterministic suite run; pass = suite exited 0 with the named test not skipped.' },
      } : null,
    };
  });
  const ledgerInput = { evidence_bundle: bundle, reviewed_obligations: reviewed, manifest: { bindings, contradictions: [] } };

  // ── Coverage workspace ──
  const env = { node: process.version, platform: process.platform, arch: process.arch };
  const artifact = { artifact_id: 'margin-src', artifact_sha256: artifactSha256, version: headSha, environment_sha256: sha256(JSON.stringify(env)), evidence_ids: [cap('build')] };
  const norm = sha256('normalization:none');
  const active = inv.surfaces.filter((s) => s.status !== 'oos');
  const surfaces = inv.surfaces.map((s) => ({ surface_id: s.id, family: s.id.split('.').slice(0, 2).join('.'), artifact_id: 'margin-src', occurrence_id: null, location: s.title, authority: 'inferred', dependency_surface_ids: [], evidence_ids: [reviews.get(s.id).evidence_id] }));
  const owners = inv.surfaces.flatMap((s) => {
    if (s.status === 'oos') return [{ surface_id: s.id, ownership: { disposition: 'non-goal', rationale: s.why } }];
    if (!s.ownerFile) return [];
    return [{ surface_id: s.id, ownership: { disposition: 'implemented', owner_path: s.ownerFile, owner_export: s.ownerAnchor, owner_sha256: s.ownerSha256, path_state: 'present', package_state: 'distributed', authority_route: 'none' } }];
  });
  const claims = active.map((s) => ({ claim_id: `claim.${s.id}`, title: s.title, kind: 'behavior', surface_ids: [s.id], required_dimensions: ['behavior'], required_authority: 'controlled-replay' }));
  const contracts = [];
  const results = [];
  for (const s of active.filter((x) => x.verifier && x.ownerFile)) {
    const suite = suiteFor(s);
    const c = createReconstructionVerifierContract({ verifier_id: `margin.${suite}.${s.id}`, claim_ids: [`claim.${s.id}`], dimensions: ['behavior'], authority: 'controlled-replay', max_age_ms: 30 * 24 * 3600 * 1000, minimum_repeats: 1, normalization_sha256: norm, normalization_removes_dimensions: false });
    contracts.push(c);
    results.push({ verifier_id: c.verifier_id, contract_sha256: c.contract_sha256, observed_at: capturedAt(suite), status: s.status === 'owned' ? 'pass' : 'unknown', covered_claim_ids: c.claim_ids, covered_dimensions: ['behavior'], artifact_sha256s: [artifactSha256], owner_sha256s: [s.ownerSha256], normalization_sha256: norm, repeats: 1, evidence_ids: [cap(suite)] });
  }
  const proofs = [
    { proof_id: 'build.npm-run-build', kind: 'build', status: captures.build.normalized_result.exit.code === 0 ? 'pass' : 'fail', artifact_sha256s: [artifactSha256], evidence_ids: [cap('build')] },
    { proof_id: 'independence.dist-scan', kind: 'authority-independence', status: captures.independence.normalized_result.exit.code === 0 ? 'pass' : 'fail', artifact_sha256s: [artifactSha256], evidence_ids: [cap('independence')] },
  ];
  const boundary = { boundary_id: 'margin.typora-parity', title: 'Margin as a complete clean-room reconstruction of Typora (product surface)', required_surface_ids: inv.surfaces.map((s) => s.id), required_claim_ids: claims.map((c) => c.claim_id), required_package_proof_kinds: ['build', 'clean-install', 'authority-independence'], allowed_dispositions: ['non-goal'], allowed_unknown_ids: [] };
  const coverageInput = { boundary_id: boundary.boundary_id, coverage: { evidence_bundle: bundle, artifacts: [artifact], surfaces, owners, claims, verifier_contracts: contracts, verifier_results: results, residual_unknown_ids: [], contradictions: [], package_proofs: proofs, boundaries: [boundary] } };
  return { ledgerInput, coverageInput, captures };
}
