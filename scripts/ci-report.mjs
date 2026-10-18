#!/usr/bin/env node
// Build ci-out/summary.md + summary.json from ci-out/<stage>.res|.log and the
// vitest / playwright JSON reports. Exit code: 0 iff no stage failed.
//   node scripts/ci-report.mjs ci-out
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'ci-out';
const STAGES = ['npm_ci', 'typecheck', 'vitest', 'e2e', 'cargo_test', 'clippy', 'bundle', 'smoke', 'native_qa'];
const read = (f) => (existsSync(join(out, f)) ? readFileSync(join(out, f), 'utf8') : '');
const json = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
const ICON = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭️', blocked: '⛔' };

function notes(stage, log) {
  if (stage === 'vitest') {
    const j = json('vitest.json');
    if (j) return `${j.numPassedTests}/${j.numTotalTests} tests` +
      (j.numFailedTests ? `, **${j.numFailedTests} failed**` : '');
  }
  if (stage === 'e2e') {
    const j = json('e2e.json');
    if (j?.stats) {
      const per = {};
      const walk = (s) => { for (const sp of s.specs ?? []) for (const t of sp.tests) {
        const p = (per[t.projectName] ??= { ok: 0, n: 0 }); p.n++; if (t.status === 'expected' || t.status === 'flaky') p.ok++; }
        for (const c of s.suites ?? []) walk(c); };
      for (const s of j.suites ?? []) walk(s);
      const s = j.stats;
      return Object.entries(per).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(', ') +
        (s.unexpected ? `, **${s.unexpected} failed**` : '') + (s.flaky ? `, ${s.flaky} flaky` : '');
    }
  }
  if (stage === 'cargo_test') {
    const m = [...log.matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed/g)];
    if (m.length) return m.map((x) => `${x[2]} passed, ${x[3]} failed`).join(' / ');
  }
  if (stage === 'clippy') {
    const n = (log.match(/^(warning|error)(\[\w+\])?: /gm) ?? []).length;
    return n ? `${n} diagnostics` : 'clean';
  }
  if (stage === 'bundle') {
    const files = [...log.matchAll(/\s(\S+\.(?:deb|AppImage))$/gm)].map((m) => m[1]);
    const sizes = [...log.matchAll(/(\d+)\s+\w+\s+\d+\s+[\d:]+\s+(\S+\.(?:deb|AppImage))$/gm)]
      .map((m) => `${m[2]} (${(m[1] / 1048576).toFixed(1)} MB)`);
    return (sizes.length ? sizes : files).join(', ');
  }
  if (stage === 'smoke') return read('smoke.note').trim();
  if (stage === 'native_qa') {
    const rows = [...read('native-qa.txt').matchAll(/^RESULT (\S+) (\S+)/gm)];
    const bad = rows.filter((r) => r[2] === 'fail').map((r) => r[1]);
    const ok = rows.filter((r) => r[2] === 'pass').length;
    return `${ok}/${rows.length} pass` + (bad.length ? `; failed: ${bad.join(', ')}` : '');
  }
  return '';
}

const rows = STAGES.map((stage) => {
  const [status = 'missing', secs = '0'] = read(`${stage}.res`).trim().split(/\s+/);
  const log = read(`${stage}.log`);
  const r = { stage, status, seconds: Number(secs), notes: notes(stage, log) };
  if (status === 'fail') r.tail = log.split('\n').filter(Boolean).slice(-30).join('\n');
  return r;
});
const ok = rows.every((r) => r.status !== 'fail' && r.status !== 'missing');
const total = Number(read('total-seconds').trim() || 0);
const cache = read('cache.txt').trim().split('\n').filter(Boolean);

let md = `| stage | result | time | notes |\n| --- | --- | --- | --- |\n`;
for (const r of rows) md += `| ${r.stage} | ${ICON[r.status] ?? '?'} ${r.status} | ${r.seconds}s | ${r.notes.replace(/\|/g, '/')} |\n`;
md += `\nWall time ${total}s (js and rust lanes run in parallel).`;
if (cache.length) md += ` Cache: ${cache.join('; ')}.`;
md += '\n';
for (const r of rows.filter((x) => x.tail)) {
  md += `\n<details><summary>${r.stage} log tail</summary>\n\n\`\`\`\n${r.tail.replace(/```/g, "'''")}\n\`\`\`\n</details>\n`;
}
writeFileSync(join(out, 'summary.md'), md);
writeFileSync(join(out, 'summary.json'), JSON.stringify({ ok, total_seconds: total, cache, stages: rows }, null, 2));
process.stdout.write(md);
process.exit(ok ? 0 : 1);
