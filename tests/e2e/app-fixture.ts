/** Deterministic test folder for the app e2e suite (seeded into WebPlatform's memfs). */
export const ROOT = '/Users/demo/Notes';

const WELCOME = `# Welcome to Margin

Margin is a quiet place to write **Markdown**. What you type is what you see — the syntax
fades away once your cursor leaves a block.

## Getting around

- Press \`⌘P\` to jump to any file in the folder.
- Press \`⌘⇧A\` for every command.
- Press \`⌘/\` to flip between rich and source view.

## Writing

> Simplicity is the ultimate sophistication.

Inline \`code\`, *emphasis*, ==highlights== and [links](https://example.com) all work.

### 中文排版

在 Margin 里，中英文混排也应该舒服：行高宽松，标点不挤，字体回退合理。

## Next steps

1. Open a folder from the sidebar.
2. Try the themes in Preferences.
`;

export const FIXTURE: Record<string, string> = {
  [`${ROOT}/Welcome.md`]: WELCOME,
  [`${ROOT}/Ideas/Roadmap.md`]: '# Roadmap\n\n## Q4\n\n- Export to PDF\n- Themes\n\n## Later\n\n- Sync\n',
  [`${ROOT}/Ideas/Reading list.md`]: '# Reading list\n\n- [ ] The Elements of Typographic Style\n- [x] A Pattern Language\n',
  [`${ROOT}/Journal/2026-10-17.md`]: '# Friday\n\nShipped the shell.\n',
  [`${ROOT}/Journal/2026-10-16.md`]: '# Thursday\n\nSketched the sidebar.\n',
  [`${ROOT}/notes.txt`]: 'plain text notes\r\nsecond line\r\n',
};

/**
 * localStorage entries in WebPlatform's persisted format (`margin.web.fs.v1`:
 * `[path, {kind:'file',content,mtime} | {kind:'dir',mtime}][]`), so the platform
 * restores this tree instead of its own samples on first load.
 */
export function fixtureEntries(files: Record<string, string> = FIXTURE): [string, unknown][] {
  const out = new Map<string, unknown>();
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) out.set('/' + parts.slice(0, i).join('/'), { kind: 'dir', mtime: 1 });
    out.set(path, { kind: 'file', content, mtime: 1 });
  }
  out.set(`${ROOT}/Empty folder`, { kind: 'dir', mtime: 1 });
  return [...out];
}
