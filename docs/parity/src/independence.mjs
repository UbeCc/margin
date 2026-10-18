#!/usr/bin/env node
// Authority-independence audit for the built frontend + Tauri config: the reconstruction must not
// load, link, or call into the original product. Exit 0 = no references found.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['dist', 'src-tauri/tauri.conf.json', 'src-tauri/capabilities'];
const needles = [/typora/i, /Typora\.app/, /abnerworks/i, /TypeMark/];
const hits = [];
let files = 0;
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) return readdirSync(p).forEach((n) => walk(join(p, n)));
  files++;
  const text = readFileSync(p, 'latin1');
  for (const re of needles) if (re.test(text)) hits.push(`${p}: ${re}`);
};
roots.forEach(walk);
console.log(JSON.stringify({ roots, files_scanned: files, hits }, null, 1));
process.exit(hits.length ? 1 : 0);
