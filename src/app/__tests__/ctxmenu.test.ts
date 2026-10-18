import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockInner } from '../../editor/core/block-copy';
import { buildItems, type CtxActions } from '../ctxmenu/items';
import { contextTarget, imageMarkdownSrc } from '../ctxmenu/targets';
import { closeContextMenu, showContextMenu, tidy, type MenuItem } from '../ui/contextmenu';

function doc(html: string): HTMLElement {
  document.body.innerHTML = `<div class="md-editor">${html}</div><input id="field">`;
  return document.querySelector<HTMLElement>('.md-editor')!;
}

const acts = (): CtxActions => ({
  run: vi.fn(),
  exec: vi.fn(() => true),
  restore: vi.fn(),
  cut: vi.fn(),
  copy: vi.fn(),
  paste: vi.fn(),
  writeText: vi.fn(),
  openLink: vi.fn(),
  openExternal: vi.fn(),
  deleteImage: vi.fn(),
  tableAction: vi.fn(),
  editBlock: vi.fn(),
  copyDiagramImage: vi.fn(),
  saveDiagram: vi.fn(),
});

const labels = (items: MenuItem[]): string[] => tidy(items).map((i) => ('separator' in i ? '|' : i.label));

afterEach(() => {
  closeContextMenu();
  document.body.innerHTML = '';
});

describe('context menu targets (Typora key lists)', () => {
  it('text, link and inline math', () => {
    const root = doc(
      '<p class="md-block md-paragraph" data-bid="a" data-type="paragraph">hi <span class="md-wrap md-link" data-href="https://x.io"><span>x</span></span> <span class="md-wrap md-math"><span class="md-src">$a$</span></span></p>',
    );
    const p = root.querySelector('p')!;
    expect(contextTarget(p, root).keys).toEqual(['normal']);
    const link = contextTarget(root.querySelector('.md-link span'), root);
    expect(link.kind).toBe('link');
    expect(link.href).toBe('https://x.io');
    expect(link.keys).toEqual(['openLink', 'copyLink', '|', 'normal']);
    expect(contextTarget(root.querySelector('.md-math .md-src'), root).keys).toEqual(['copyMathInline', '|', 'normal']);
  });

  it('widget blocks get their Typora groups', () => {
    const root = doc(
      ['table', 'code_fence', 'math_block', 'diagram', 'html_block', 'front_matter', 'toc']
        .map((t) => `<div class="md-block md-widget" data-bid="${t}" data-type="${t}"><div class="inner"></div></div>`)
        .join(''),
    );
    const k = (t: string) => contextTarget(root.querySelector(`[data-type=${t}] .inner`), root).keys;
    expect(k('table')).toEqual(['normal', '|', 'table', '|', 'insertParagraphBefore', 'insertParagraphAfter']);
    expect(k('code_fence')).toEqual(['normal', '|', 'code-tools', '|', 'insertParagraphBefore', 'insertParagraphAfter', 'deleteFences']);
    expect(k('math_block')).toContain('copyMathBlock');
    expect(k('diagram')).toEqual(expect.arrayContaining(['edit', 'copy-as-image', 'download-diagram', 'deleteFences']));
    expect(k('html_block').slice(-1)).toEqual(['delete']);
    expect(k('toc')).toEqual(['normal', '|', 'insertParagraphBefore', 'insertParagraphAfter', 'delete']);
  });

  it('images: local vs online, fields, outside', () => {
    const root = doc(
      '<p data-bid="p" data-type="paragraph"><span class="md-wrap md-image"><span class="md-src">![a](assets/a.png)</span><img class="md-img" src="blob:x"></span>' +
        '<span class="md-wrap md-image" id="web"><span class="md-src">![b](https://h/b.png)</span><img class="md-img"></span></p>',
    );
    for (const img of root.querySelectorAll('img')) Object.defineProperties(img, { naturalWidth: { value: 10, configurable: true }, complete: { value: true } });
    const local = contextTarget(root.querySelector('img'), root);
    expect(local.keys).toEqual(['revealImgInFinder', 'copyImgToDir', 'copyImgToSelect', 'moveImgToDir', 'moveImgToSelect', 'uploadImg', '|', 'copyImg', 'zoomImg', 'imgSyntax', 'deleteImgFile', '|', 'normal', '|', 'download-image']);
    expect(local.kind).toBe('image');
    expect(local.src).toBe('assets/a.png');
    expect(local.keys[0]).toBe('revealImgInFinder');
    expect(local.keys).toContain('deleteImgFile');
    const web = contextTarget(root.querySelector('#web img'), root);
    expect(web.keys[0]).toBe('revealImgInBrowser');
    expect(web.keys).toContain('deleteImg');
    expect(web.keys).not.toContain('moveImgToSelect');
    Object.defineProperty(web.img!, 'naturalWidth', { value: 0 });
    expect(contextTarget(root.querySelector('#web img'), root).keys).toEqual(['revealImgInBrowser', 'zoomImg', 'imgSyntax', 'deleteImg', '|', 'normal']);
    expect(contextTarget(document.getElementById('field'), root).keys).toEqual(['input']);
    expect(contextTarget(document.body, root).kind).toBe('none');
  });

  it('source mode is a plain text field menu', () => {
    const root = doc('<p data-bid="a" data-type="paragraph">x</p>');
    const src = document.createElement('div');
    src.innerHTML = '<div class="cm"></div>';
    document.body.append(src);
    expect(contextTarget(src.firstChild, null, src).keys).toEqual(['input']);
    expect(contextTarget(root.querySelector('p'), root).keys).toEqual(['normal']);
  });

  it('parses image sources', () => {
    expect(imageMarkdownSrc('![x](<a b.png> "t")')).toBe('a b.png');
    expect(imageMarkdownSrc('<img src="c.png" />')).toBe('c.png');
    expect(imageMarkdownSrc('plain')).toBeNull();
  });
});

describe('context menu items', () => {
  it('text menu: Cut / Copy / Paste / Copy / Paste As, Search with Google on a selection', () => {
    const root = doc('<p data-bid="a" data-type="paragraph">hello</p>');
    const t = contextTarget(root.querySelector('p'), root);
    expect(labels(buildItems(t, { selection: '' }, acts()))).toEqual(['Cut', 'Copy', 'Paste', 'Copy / Paste As…']);
    const a = acts();
    const items = buildItems(t, { selection: 'hello' }, a);
    expect(labels(items)).toEqual(['Cut', 'Copy', 'Paste', 'Copy / Paste As…', '|', 'Search with Google']);
    (items[items.length - 1] as { run(): void }).run();
    expect(a.openExternal).toHaveBeenCalledWith('https://www.google.com/search?q=hello');
    const sub = items.find((i) => 'submenu' in i) as { submenu: MenuItem[] };
    expect(labels(sub.submenu)).toEqual(['Copy as Markdown', 'Copy as HTML Code', 'Copy without Theme Styling', '|', 'Paste as Plain Text']);
  });

  it('link menu puts Copy Link Address next to Copy', () => {
    const root = doc('<p data-bid="a" data-type="paragraph"><span class="md-wrap md-link" data-href="u">l</span></p>');
    const a = acts();
    const items = buildItems(contextTarget(root.querySelector('.md-link'), root), { selection: '' }, a);
    expect(labels(items)).toEqual(['Open Link', '|', 'Cut', 'Copy', 'Copy Link Address', 'Paste', 'Copy / Paste As…']);
    (items[0] as { run(): void }).run();
    expect(a.openLink).toHaveBeenCalledWith('u');
  });

  it('code block menu: Code Tools and Delete Code Block', () => {
    const root = doc('<div data-bid="c" data-type="code_fence"><i></i></div>');
    const a = acts();
    const items = tidy(buildItems(contextTarget(root.querySelector('i'), root), { selection: '' }, a));
    expect(labels(items)).toEqual(['Cut', 'Copy', 'Paste', 'Copy / Paste As…', '|', 'Code Tools', '|', 'Insert Paragraph Before', 'Insert Paragraph After', 'Delete Code Block']);
    (items[items.length - 1] as { run(): void }).run();
    expect(a.run).toHaveBeenCalledWith('delete:block');
    const tools = items.find((i) => 'submenu' in i && i.label === 'Code Tools') as { submenu: { label: string; run(): void }[] };
    tools.submenu[0].run();
    expect(a.exec).toHaveBeenCalledWith({ kind: 'code', op: 'copy' });
  });

  it('input menu has only Cut / Copy / Paste', () => {
    doc('');
    const t = contextTarget(document.getElementById('field'), document.querySelector('.md-editor'));
    expect(labels(buildItems(t, { selection: 'x' }, acts()))).toEqual(['Cut', 'Copy', 'Paste']);
  });

  it('video and emoji targets: Save Video As… after system items; Copy <char> for :emoji:', () => {
    const root = doc(
      '<div data-bid="h" data-type="html_block"><div class="inner"><video src="assets/v.mp4" controls></video></div></div>' +
        '<p data-bid="p" data-type="paragraph"><span class="md-wrap md-entity"><span class="md-meta">:smile:</span><span class="md-entity-char">😄</span></span></p>',
    );
    const a = acts();
    a.saveVideoAs = vi.fn();
    const v = buildItems(contextTarget(root.querySelector('video'), root), { selection: '' }, a);
    expect(labels(v)).toEqual(['Cut', 'Copy', 'Paste', 'Copy / Paste As…', '|', 'Save Video As…']);
    (v[v.length - 1] as { run(): void }).run();
    expect(a.saveVideoAs).toHaveBeenCalledWith('assets/v.mp4');
    const e = buildItems(contextTarget(root.querySelector('.md-entity-char'), root), { selection: '' }, a);
    expect(labels(e)[0]).toBe("Copy '😄'");
    (e[0] as { run(): void }).run();
    expect(a.writeText).toHaveBeenCalledWith('😄');
  });

  it('image menu: folder targets, zoom presets grouped, syntax switch checked, Save Image As…', () => {
    const root = doc(
      '<p data-bid="p" data-type="paragraph"><span class="md-wrap md-image"><span class="md-src">![a](assets/a.png)</span><img class="md-img" src="blob:x"></span></p>',
    );
    const img = root.querySelector('img')!;
    Object.defineProperties(img, { naturalWidth: { value: 10, configurable: true }, complete: { value: true } });
    const a = acts();
    a.revealImage = vi.fn();
    a.uploadImage = vi.fn();
    a.copyImageTo = vi.fn();
    a.imageTarget = () => ({ label: './assets', canMove: true, run: vi.fn() });
    a.zoomChoices = () => ({ zoomNow: '50%', presets: ['25%', '33%', '50%', '67%', '100%', '150%', '200%'], set: vi.fn() });
    a.syntaxState = () => ({ isHtml: false, switchTo: vi.fn() });
    a.saveImageAs = vi.fn();
    const items = buildItems(contextTarget(img, root), { selection: '' }, a);
    expect(labels(items)).toEqual([
      'Open Image Location…', 'Copy to ./assets', 'Copy Image to…', 'Move to ./assets', 'Rename or Move Image to…', 'Upload Image',
      '|', 'Zoom Image to 50%', 'Zoom Image', 'Switch Image Syntax', 'Delete Image File', '|',
      'Cut', 'Copy', 'Copy Image Content', 'Paste', 'Copy / Paste As…', '|', 'Save Image As…',
    ]);
    const zoom = items.find((i) => 'label' in i && i.label === 'Zoom Image') as { submenu: MenuItem[] };
    expect(labels(zoom.submenu)).toEqual(['25%', '33%', '50%', '67%', '|', '100%', '150%', '200%']);
    const syn = items.find((i) => 'label' in i && i.label === 'Switch Image Syntax') as { submenu: MenuItem[] };
    expect(labels(syn.submenu)).toEqual(['Markdown Style', 'HTML Style']);
    expect((syn.submenu[0] as { checked?: boolean }).checked).toBe(true);
    (items[items.length - 1] as { run(): void }).run();
    expect(a.saveImageAs).toHaveBeenCalledWith('assets/a.png');
  });
});

describe('context menu widget', () => {
  it('opens submenus on hover and runs items', () => {
    const run = vi.fn();
    showContextMenu(10, 10, [{ label: 'Sub', submenu: [{ label: 'Leaf', run, checked: true }] }, { separator: true }]);
    expect(document.querySelectorAll('.context-sep').length).toBe(0); // trailing separator dropped
    document.querySelector<HTMLButtonElement>('.context-item')!.dispatchEvent(new MouseEvent('mouseenter'));
    const leaf = document.querySelector<HTMLButtonElement>('.context-submenu .context-item')!;
    expect(leaf.getAttribute('aria-checked')).toBe('true');
    leaf.click();
    expect(run).toHaveBeenCalled();
    expect(document.querySelector('.context-menu')).toBeNull();
  });
});

describe('block copy', () => {
  it('strips fences', () => {
    expect(blockInner('code_fence', '```js\na\nb\n```')).toBe('a\nb');
    expect(blockInner('code_fence', '~~~~\nx')).toBe('x');
    expect(blockInner('math_block', '$$\nE=mc^2\n$$')).toBe('E=mc^2');
    expect(blockInner('table', '|a|')).toBe('|a|');
  });
});
