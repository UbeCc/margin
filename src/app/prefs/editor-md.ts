/** Preferences › Editor and › Markdown panes (#100, #102). */
import type { MarkdownOptions } from '../../contracts';
import type { MarginSettings } from '../settings';
import { h } from '../util/dom';
import type { PrefKit } from './kit';

export function editorPane(k: PrefKit): HTMLElement {
  const s = k.cur();
  // Editor › Indent Size on Save (#132, fe-preferences §5.1): preview shows a quote,
  // a list item, a nested ordered item and a continuation at the chosen width.
  const preview = h('pre.pref-indent-preview', { text: '' });
  const paintPreview = () => {
    const m = k.cur().markdown;
    const w = m.indentSize === -1 || m.indentSize === 0 ? 2 : m.indentSize;
    const pad = (marker: string) => (m.indentSize === -1 ? marker + '\t' : marker + ' '.repeat(m.prettyIndent ? Math.max(1, w - marker.length) : 1));
    const ind = m.indentSize === -1 ? '\t' : ' '.repeat(w);
    preview.textContent = [`${pad('>')}Quote`, `${pad('-')}List item`, `${ind}${pad('1.')}Nested`, `${ind}${ind}continuation`].join('\n');
  };
  const indentSel = k.select(
    'markdown.indentSize',
    [['0', 'Auto'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['-1', 'Tab']],
    String(s.markdown.indentSize),
    (v) => {
      k.setMd({ indentSize: Number(v) as MarkdownOptions['indentSize'] });
      paintPreview();
    },
  );
  const pretty = k.mdToggle('prettyIndent', 'Pretty indentation');
  pretty.querySelector('input')!.addEventListener('change', paintPreview);
  paintPreview();
  const pairBrackets = k.mdToggle('autoPairBrackets', 'Auto pair brackets and quotes');
  const pairMd = k.mdToggle('autoPairMarkdown', 'Auto pair common Markdown syntax', 'e.g: * _ ` ~');
  // "Auto pair common Markdown syntax" is disabled (and shown unchecked) while bracket pairing is off.
  const mdBox = pairMd.querySelector('input')!;
  const sync = () => {
    const on = k.cur().markdown.autoPairBrackets;
    mdBox.disabled = !on;
    mdBox.checked = on && k.cur().markdown.autoPairMarkdown;
  };
  pairBrackets.querySelector('input')!.addEventListener('change', sync);
  sync();
  return h(
    'section.pref-section',
    { 'data-section': 'editor' },
    k.group(
      'Indent Size on Save',
      k.note('only apply to quotes and lists created from menu bar or hybrid view'),
      k.row('Indent Size', indentSel),
      pretty,
      preview,
    ),
    k.group('Auto Pair', pairBrackets, pairMd),
    k.group('Live Rendering', k.mdToggle('expandSimpleBlock', 'Display source for simple blocks (including headings, etc.) on focus')),
    k.group(
      'Default Line Ending',
      k.row(
        'Line ending for new file',
        k.select(
          'defaultLineEnding',
          [['auto', 'Auto'], ['lf', 'LF (Unix Style)'], ['crlf', 'CRLF (Windows Style)']],
          s.defaultLineEnding,
          (v) => k.set({ defaultLineEnding: v as MarginSettings['defaultLineEnding'] }),
        ),
      ),
    ),
    k.group(
      'When Writing',
      k.toggle('spellcheck', 'Check spelling while typing'),
      k.toggle('focusMode', 'Focus mode', 'Dim everything except the current block (F8)'),
      k.toggle('typewriterMode', 'Typewriter mode', 'Always keep caret in middle of screen (F9)'),
    ),
  );
}

export function markdownPane(k: PrefKit): HTMLElement {
  const md = k.cur().markdown;
  // Smart Punctuation (#133, fe-preferences §7.3): the remap box is forced checked and
  // disabled while Convert on Input is selected and Smart Quotes or Smart Dashes is on;
  // the parser applies the same rule via remapOn() (options.ts).
  const smartSel = k.select(
    'markdown.smartPunctuation',
    [['input', 'Convert on Input'], ['rendering', 'Convert on Rendering']],
    md.smartPunctuation,
    (v) => k.setMd({ smartPunctuation: v as MarkdownOptions['smartPunctuation'] }),
  );
  const quoteRow = k.mdToggle('smartQuote', 'Smart Quotes', 'You could set quote patterns in System Preferences → Keyboard → Text. If it is changed, Typora will need a restart to apply it.');
  const dashRow = k.mdToggle('smartDash', 'Smart Dashes');
  const remapRow = k.mdToggle(
    'remapPunctuation',
    'Remap Unicode Punctuation on Parse',
    "Recognize unicode punctuations as ASCII ones when parse markdown, e.g: 》 blockquote → > blockquote; [link](src ’title’) → [link](src 'title'). It will be turned on automatically if smart quotes/dashes will be converted on input.",
  );
  const remapBox = remapRow.querySelector('input')!;
  const syncRemap = () => {
    const m = k.cur().markdown;
    const forced = m.smartPunctuation === 'input' && (m.smartQuote || m.smartDash);
    remapBox.disabled = forced;
    remapBox.checked = forced || m.remapPunctuation;
  };
  smartSel.addEventListener('change', syncRemap);
  quoteRow.querySelector('input')!.addEventListener('change', syncRemap);
  dashRow.querySelector('input')!.addEventListener('change', syncRemap);
  syncRemap();
  return h(
    'section.pref-section',
    { 'data-section': 'markdown' },
    k.group(
      'Syntax Preference',
      k.note('only apply to quotes and lists created from menu bar or hybrid view'),
      k.mdToggle('strict', 'Strict Mode', '(more strict to GFM spec)'),
      k.row(
        'Heading Style',
        k.select(
          'markdown.headingStyle',
          [['atx', 'atx (#)'], ['atxSuffix', 'atx with suffix (# ⋯ #)'], ['setext', 'setext (===)'], ['setextVar', 'variable-width setext (=====)']],
          md.headingStyle,
          (v) => k.setMd({ headingStyle: v as MarkdownOptions['headingStyle'] }),
        ),
      ),
      k.row('Unordered List', k.select('markdown.ulStyle', [['-', '-'], ['+', '+'], ['*', '*']], md.ulStyle, (v) => k.setMd({ ulStyle: v as MarkdownOptions['ulStyle'] }))),
      k.row(
        'Ordered List',
        k.select('markdown.olStyle', [['increment', '1. ⋯ 2. ⋯ 3. ⋯'], ['ones', '1. ⋯ 1. ⋯ 1. ⋯']], md.olStyle, (v) => k.setMd({ olStyle: v as MarkdownOptions['olStyle'] })),
      ),
    ),
    k.group(
      'Syntax Support',
      k.mdToggle('inlineMath', 'Inline Math ( e.g: $\\LaTeX$ )'),
      k.mdToggle('subscript', 'Subscript ( e.g: H~2~O )'),
      k.mdToggle('superscript', 'Superscript ( e.g: X^2^ )'),
      k.mdToggle('highlight', 'Highlight (e.g: ==key==)'),
      k.mdToggle('emoji', 'Emoji (e.g. :smile:)'),
    ),
    k.group(
      'Smart Punctuation',
      k.row(
        '',
        smartSel,
        'Convert on Input: Input ASCII dashes or quotes, converted and saved as curly quotes or unicode dashes. Convert on Rendering: Input and saved as ASCII dashes or quotes, render as curly quotes or unicode dashes.',
      ),
      quoteRow,
      dashRow,
      remapRow,
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
      'Math',
      k.mdToggle('mathLineBreaks', 'Apply Line Break at \\ and \\newline'),
      k.mdToggle('mathPhysics', 'Enable physics package', 'Physics package will redefine some latex macros, such as \\div, \\Re, etc.'),
      k.row(
        'Auto Numbering Math Equations',
        k.select(
          'markdown.mathNumbering',
          [['none', 'No Automatic Equation Numbering'], ['ams', 'Use AMS Numbering Rules'], ['all', 'Auto Numbering for All Math Equations']],
          md.mathNumbering,
          (v) => k.setMd({ mathNumbering: v as MarkdownOptions['mathNumbering'] }),
        ),
      ),
    ),
    k.group(
      'Whitespace / Line Break',
      k.mdToggle('indentFirstLine', 'Indent first line of paragraphs'),
      k.mdToggle('visibleBr', 'Visible <br/>'),
      k.row(
        'When Writing',
        k.select(
          'markdown.preserveLineBreak',
          [['preserve', 'Preserve whitespace and single line break'], ['ignore', 'Ignore whitespace and single line break']],
          md.preserveLineBreak ? 'preserve' : 'ignore',
          (v) => k.setMd({ preserveLineBreak: v === 'preserve' }),
        ),
      ),
    ),
  );
}
