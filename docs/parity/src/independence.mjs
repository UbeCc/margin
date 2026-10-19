#!/usr/bin/env node
// Authority-independence audit for the built frontend + Tauri config: the reconstruction must not
// load, link, or call into the original product. Exit 0 = no references found.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = process.argv.slice(2).length ? process.argv.slice(2) : ['dist', 'src-tauri/tauri.conf.json', 'src-tauri/capabilities'];
const needles = [/typora/i, /Typora\.app/, /abnerworks/i, /TypeMark/];
// Markdown front-matter keys that are part of the document format Margin reads for
// compatibility (images §2: typora-copy-images-to / typora-root-url; the `typora-${key}`
// lookup prefix). They name no product binary or service and are masked before scanning.
const formatKeys = [/typora-copy-images-to/g, /typora-root-url/g, /`typora-\$\{[a-z]\}`/g];
const hits = [];
let files = 0;
let masked = 0;
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) return readdirSync(p).forEach((n) => walk(join(p, n)));
  files++;
  let text = readFileSync(p, 'latin1');
  for (const k of formatKeys) text = text.replace(k, (m) => { masked++; return ''; });
  for (const re of needles) if (re.test(text)) hits.push(`${p}: ${re}`);
};
roots.forEach(walk);
console.log(JSON.stringify({ roots, files_scanned: files, format_keys_masked: masked, hits }, null, 1));
process.exit(hits.length ? 1 : 0);
