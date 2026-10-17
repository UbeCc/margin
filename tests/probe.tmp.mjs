import { chromium, webkit } from 'playwright';
const b = await (process.env.WK ? webkit : chromium).launch();
const page = await b.newPage();
page.on('pageerror', e => console.log('PAGEERR', e.message));
page.on('console', m => { if (m.type()==='error'||m.type()==='warning') console.log('CONSOLE', m.type(), m.text()); });
await page.goto('http://localhost:5182/' + (process.env.Q||''));
await page.waitForSelector(process.env.READY || '.app.ready');
const steps = JSON.parse(process.argv[2]);
for (const s of steps) {
  if (s.k) await page.keyboard.press(s.k);
  if (s.t) await page.keyboard.type(s.t);
  if (s.c) await page.click(s.c);
  if (s.e) console.log(JSON.stringify(await page.evaluate(s.e)));
  if (s.w) await page.waitForTimeout(s.w);
  if (s.shot) await page.screenshot({ path: s.shot });
}
await b.close();
