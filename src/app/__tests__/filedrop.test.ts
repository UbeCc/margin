import { describe, expect, it, vi } from 'vitest';
import { handleFileDrop, linkDest } from '../filedrop';

describe('linkDest', () => {
  it('encodes spaces and wraps parentheses', () => {
    expect(linkDest('a b/c.pdf')).toBe('a%20b/c.pdf');
    expect(linkDest('x(1).pdf')).toBe('<x(1).pdf>');
    expect(linkDest('C:\\docs\\a.pdf')).toBe('C:/docs/a.pdf');
  });
});

describe('handleFileDrop', () => {
  const deps = (over: boolean) => {
    const exec = vi.fn(() => true);
    const host = { isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, right: over ? 100 : -1, bottom: 100, width: over ? 100 : 0 }) };
    return {
      exec,
      d: {
        platform: { stat: async (p: string) => (p.includes('missing') ? null : { path: p, name: p, isDir: p.endsWith('/dir') }) },
        editor: () => ({ exec }) as never,
        editorHost: () => host as never,
        docDir: () => '/n',
        storeImage: async ({ name }: { name: string }) => `assets/${name}`,
        openPaths: vi.fn(async () => undefined),
        notify: vi.fn(),
      },
    };
  };
  it('inserts images and links over the editor, opens markdown and folders', async () => {
    const { d, exec } = deps(true);
    await handleFileDrop(d as never, { paths: ['/n/a.png', '/n/sub/b.pdf', '/n/c.md', '/n/dir', '/n/missing.png'], x: 5, y: 5 });
    expect(exec).toHaveBeenCalledWith({ kind: 'insertMarkdownAt', markdown: '![a](assets/a.png) [b.pdf](sub/b.pdf)', x: 5, y: 5 });
    expect(d.openPaths).toHaveBeenCalledWith(['/n/c.md', '/n/dir']);
  });
  it('ignores other files outside the editor with a hint', async () => {
    const { d, exec } = deps(false);
    await handleFileDrop(d as never, { paths: ['/n/a.png'], x: 5, y: 5 });
    expect(exec).not.toHaveBeenCalled();
    expect(d.notify).toHaveBeenCalled();
  });
});
