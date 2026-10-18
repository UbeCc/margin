// Load all surfaces, check them against the spec and Margin's source, and derive obligation records.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseSpec, norm } from './spec.mjs';
import { EPICS } from './dsl.mjs';
import a from './menus-file-edit.mjs';
import b from './menus-para-view.mjs';
import c from './context-tools-images.mjs';
import d from './prefs-sidebar-export.mjs';
import e from './syntax-behaviors.mjs';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const STATUSES = new Set(['owned', 'partial', 'missing', 'oos']);

export function loadInventory({ repo, specPath }) {
  const spec = parseSpec(specPath);
  const surfaces = [...a, ...b, ...c, ...d, ...e];
  const errors = [];
  const ids = new Set();
  const covered = { A: new Set(), B: new Set(), C: new Set() };
  for (const s of surfaces) {
    if (ids.has(s.id)) errors.push(`duplicate id ${s.id}`);
    ids.add(s.id);
    if (!STATUSES.has(s.status)) errors.push(`${s.id}: bad status ${s.status}`);
    if ((s.status === 'owned' || s.status === 'partial') && !s.owner) errors.push(`${s.id}: ${s.status} needs an owner`);
    if ((s.status === 'missing' || s.status === 'oos') && s.owner) errors.push(`${s.id}: ${s.status} must not have an owner`);
    if ((s.status === 'missing' || s.status === 'partial') && !EPICS[s.e]) errors.push(`${s.id}: needs an epic`);
    if (s.status === 'oos' && !s.why) errors.push(`${s.id}: out-of-scope needs a rationale`);
    for (const k of ['A', 'B', 'C'])
      for (const label of s[k] ?? []) {
        const n = norm(label);
        if (!spec[k].includes(n)) errors.push(`${s.id}: ${k} label not in spec: ${JSON.stringify(n)}`);
        covered[k].add(n);
      }
    if (s.owner) {
      const [file, anchor] = s.owner.split('#');
      const p = join(repo, file);
      if (!existsSync(p)) errors.push(`${s.id}: owner file missing ${file}`);
      else {
        const text = readFileSync(p);
        if (!text.toString('utf8').includes(anchor)) errors.push(`${s.id}: anchor ${JSON.stringify(anchor)} not in ${file}`);
        s.ownerFile = file;
        s.ownerAnchor = anchor;
        s.ownerSha256 = sha256(text);
      }
    }
    if (s.verifier) {
      const [file, title] = s.verifier.split('::');
      const p = join(repo, file);
      if (!existsSync(p) || !readFileSync(p, 'utf8').includes(title)) errors.push(`${s.id}: verifier not found ${s.verifier}`);
      s.verifierFile = file;
      s.verifierTitle = title;
      s.verifierKind = file.startsWith('tests/e2e/') ? 'e2e' : 'unit';
    }
    s.priority = s.status === 'owned' || s.status === 'oos' ? null : (s.p ?? EPICS[s.e]?.p ?? 2);
  }
  const uncovered = {};
  for (const k of ['A', 'B', 'C']) uncovered[k] = spec[k].filter((l) => !covered[k].has(l));
  return { spec, surfaces, errors, uncovered };
}

export function counts(surfaces) {
  const c = { total: surfaces.length, owned: 0, partial: 0, missing: 0, oos: 0, verified_by_test: 0 };
  for (const s of surfaces) {
    c[s.status]++;
    if (s.status === 'owned' && s.verifier) c.verified_by_test++;
  }
  return c;
}
