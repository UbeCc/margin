import { describe, expect, it } from 'vitest';
import { localImageSrcs } from './relocate';

describe('localImageSrcs', () => {
  it('collects local markdown and html image srcs, skips urls and data:', () => {
    const md = [
      '![a](/Users/me/Library/app/img-1.png)',
      '![b](<./assets/with space.png> "t")',
      '![c](https://x.test/c.png) ![d](data:image/png;base64,AA==)',
      '<img src="../pics/e.jpg" width=10>',
      '![f](file:///tmp/f.png) ![a again](/Users/me/Library/app/img-1.png)',
    ].join('\n');
    expect(localImageSrcs(md)).toEqual([
      '/Users/me/Library/app/img-1.png',
      './assets/with space.png',
      'file:///tmp/f.png',
      '../pics/e.jpg',
    ]);
  });
});
