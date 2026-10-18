/** Preferences › Editor and › Markdown panes (#100, #102). */
import type { MarkdownOptions } from '../../contracts';
import type { MarginSettings } from '../settings';
import { h } from '../util/dom';
import type { PrefKit } from './kit';

export function editorPane(k: PrefKit): HTMLElement {
  const s = k.cur();
  const md = s.markdown;

  // Custom Shortcut Keys: { "<command id or label>": "Mod+Shift+K" }
  const keys = h('textarea.css-input', { rows: '4', spellcheck: 'false', placeholder: '{ "Toggle Sidebar": "Mod+Shift+B" }', 'data-pref': 'keyBinding' }) as HTMLTextAreaElement;
  keys.value = Object.keys(s.keyBinding).length ? JSON.stringify(s.keyBinding, null, 2) : '';
  const keyStatus = h('span.pref-hint', { 'data-pref-status': 'keyBinding' });
  keys.addEventListener('change', () => {
    try {
      const v = keys.value.trim() ? (JSON.parse(keys.value) as unknown) : {};
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected a JSON object');
      k.set({ keyBinding: v as Record<string, string> });
      keyStatus.textContent = 'Saved';
    } catch (e) {
      keyStatus.textContent = `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`;
    }
  });

  return h(
    'section.pref-section',
    { 'data-section': 'editor' },
    k.group(
      'Auto Pair',
      k.mdToggle('autoPairBrackets', 'Auto pair brackets and quotes'),
      k.mdToggle('autoPairMarkdown', 'Auto pair common Markdown syntax', 'e.g: * _ ` ~'),
    ),
    k.group(
      'Live Rendering',
      k.mdToggle('expandSimpleBlock', 'Display source for simple blocks (including headings, etc.) on focus'),
    ),
    k.group(
      'Code Fences',
      k.mdToggle('codeLineNumbers', 'Display line numbers for code fences'),
      k.mdToggle('codeLineWrap', 'Auto wrap long lines'),
      k.row(
        'Indent Size for Code',
        k.select(
          'markdown.codeIndentSize',
          [['2', '2 spaces per tab'], ['3', '3 spaces per tab'], ['4', '4 spaces per tab'], ['0', 'Preserve tabs']],
          String(md.codeIndentSize),
          (v) => k.setMd({ codeIndentSize: Number(v) as MarkdownOptions['codeIndentSize'] }),
        ),
      ),
    ),
    k.group(
      'When Writing',
      k.toggle('spellcheck', 'Check spelling while typing'),
      k.toggle('focusMode', 'Focus mode', 'Dim everything except the current block (F8)'),
      k.toggle('typewriterMode', 'Typewriter mode', 'Always keep caret in middle of screen when typewriter mode is enabled (F9)'),
    ),
    k.group(
      'Default Line Ending',
      k.row(
        'Line ending for new file',
        k.select(
          'defaultLineEnding',
          [['auto', 'Auto ( Recommended )'], ['lf', 'LF (macOS / Linux)'], ['crlf', 'CRLF (Windows)']],
          s.defaultLineEnding,
          (v) => k.set({ defaultLineEnding: v as MarginSettings['defaultLineEnding'] }),
        ),
      ),
      k.toggle('insertFinalNewline', 'Insert Final New Line On Save'),
    ),
    k.group(
      'Custom Shortcut Keys',
      k.note('Map a command (its name in the command palette, or its id) to a key, e.g. "Mod+Shift+K"; several keys separated by commas.'),
      keys,
      keyStatus,
    ),
  );
}

export function markdownPane(k: PrefKit): HTMLElement {
  const md = k.cur().markdown;
  const ex = (marker: string) => `e.g: ${marker} item`;
  return h(
    'section.pref-section',
    { 'data-section': 'markdown' },
    k.group(
      'Syntax Support',
      k.mdToggle('inlineMath', 'Inline Math ( e.g: $\\LaTeX$ )'),
      k.mdToggle('subscript', 'Subscript ( e.g: H~2~O )'),
      k.mdToggle('superscript', 'Superscript ( e.g: X^2^ )'),
      k.mdToggle('highlight', 'Highlight (e.g: ==key==)'),
      k.mdToggle('emoji', 'Emoji (e.g. :smile:)'),
    ),
    k.group('Markdown Variants', k.mdToggle('strict', 'Strict Mode', '(more strict to GFM spec)')),
    k.group(
      'Syntax Preference',
      k.note('(only applies to styles created from menubar or hybrid view)'),
      k.row(
        'Unordered List',
        k.select('markdown.ulStyle', [['-', ex('-')], ['*', ex('*')], ['+', ex('+')]], md.ulStyle, (v) => k.setMd({ ulStyle: v as MarkdownOptions['ulStyle'] })),
      ),
      k.row(
        'Ordered List',
        k.select('markdown.olStyle', [['.', 'e.g: 1. item'], [')', 'e.g: 1) item']], md.olStyle, (v) => k.setMd({ olStyle: v as MarkdownOptions['olStyle'] })),
      ),
    ),
    k.group(
      'Whitespace and Line Breaks',
      k.radios(
        'markdown.preserveLineBreak',
        [
          ['preserve', 'Preserve whitespace and single line break'],
          ['ignore', 'Ignore whitespace and single line break'],
        ],
        md.preserveLineBreak ? 'preserve' : 'ignore',
        (v) => k.setMd({ preserveLineBreak: v === 'preserve' }),
      ),
      k.mdToggle('visibleBr', 'Visible <br/>'),
      k.mdToggle('indentFirstLine', 'Indent first line of paragraphs'),
      k.mdToggle('backslashBreak', 'Apply Line Break at \\ and &#92;newline'),
    ),
    k.group(
      'Math Blocks',
      k.row(
        'Auto Numbering Math Equations',
        k.select(
          'markdown.mathNumbering',
          [['all', 'Auto Numbering for All Math Equations'], ['ams', 'Use AMS Numbering Rules'], ['none', 'No Automatic Equation Numbering']],
          md.mathNumbering,
          (v) => k.setMd({ mathNumbering: v as MarkdownOptions['mathNumbering'] }),
        ),
      ),
      k.mdToggle('mathPhysics', 'Enable physics package', 'Physics package will redefine some latex macros, such as \\div, \\Re, etc.'),
    ),
    k.group('On Parse', k.toggle('remapPunctuation', 'Remap Unicode Punctuation on Parse')),
  );
}
