import { chromium, webkit } from 'playwright';
const b = await (process.env.WK ? webkit : chromium).launch();
const page = await b.newPage();
const errs=[]; page.on('pageerror', e => errs.push('PAGEERR '+e.message));
page.on('console', m => { if (m.type()==='error') errs.push('CONSOLE '+m.text()); });
await page.goto('http://localhost:5182/');
await page.waitForSelector('.app.ready'); await page.waitForTimeout(500);
await page.evaluate(()=>{ window.__MARGIN_DIALOG__ = () => null; });
const ids = await page.evaluate(() => import('/src/app/commands.ts').then(m => m.COMMANDS.map(c => c.id)));
const caret = async () => page.evaluate(() => { const root=document.querySelector('.md-editor'); const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT); for(let n=w.nextNode();n;n=w.nextNode()){const i=n.textContent.indexOf('Type Markdown'); if(i>=0){root.focus(); const r=document.createRange(); r.setStart(n,i+2); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r); return true;}} return false; });
const skip = new Set(['print','exportPdf','exportHtml','open','openFolder','saveAs','close','new','preferences','commandPalette','quickOpen','find','replace']);
for (const id of ids) {
  if (skip.has(id)) continue;
  await page.evaluate(() => { document.querySelectorAll('.modal-backdrop').forEach(e=>e.remove()); });
  await page.evaluate(() => __margin.editor.setMarkdown(window.__orig ??= __margin.editor.getMarkdown()));
  await caret();
  const before = await page.evaluate(() => __margin.editor.getMarkdown());
  errs.length = 0;
  let r; try { r = await page.evaluate((id) => __margin.run(id), id); } catch (e) { r = 'THROW ' + e.message; }
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => __margin.editor.getMarkdown());
  const cls = await page.evaluate(() => document.querySelector('.app').className);
  let diff=''; if (before!==after){ let i=0; while(before[i]===after[i]) i++; diff = JSON.stringify(after.slice(Math.max(0,i-15), i+40)); }
  console.log(id.padEnd(18), String(r).padEnd(6), diff.slice(0,90), errs.join(' | ').slice(0,200));
  if (await page.evaluate(()=>__margin.editor.isSourceMode())) await page.evaluate(()=>__margin.editor.setSourceMode(false));
}
console.log('final class', await page.evaluate(() => document.querySelector('.app').className));
await b.close();
