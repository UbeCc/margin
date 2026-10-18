// Parse the clean-room interface spec (menu titles, panel labels, bridge names).
// Only the coordinator-prepared prose spec is read — never Typora artifacts.
import { readFileSync } from 'node:fs';

export const norm = (s) => s.replace(/\s+/g, ' ').trim();

/** @returns {{A: string[], B: string[], C: string[]}} normalized labels per section */
export function parseSpec(path) {
  const out = { A: [], B: [], C: [] };
  let sec = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^## ([A-D])\./.exec(line);
    if (m) {
      sec = m[1] === 'D' ? null : m[1];
      continue;
    }
    if (!sec) continue;
    if (line.startsWith('- ')) out[sec].push(line.slice(2));
    else if (line.trim() && out[sec].length) out[sec][out[sec].length - 1] += '\n' + line; // multi-line label
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k].map(norm))];
  return out;
}
