/** Paste: clipboard HTML → markdown and fitting pasted text to the caret context (#62). */
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from './paste';
import { fitToContext } from './clipboard';
import { Doc } from './model';

const GDOCS =
  '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400;">First with </span>' +
  '<span style="font-weight:700;">bold</span><span> and </span><span style="font-style:italic;">italic</span></p><br>' +
  '<p dir="ltr"><span>Second</span></p><ul><li dir="ltr"><p dir="ltr"><span>one</span></p></li><li dir="ltr"><p dir="ltr"><span>two</span></p></li></ul></b>';
const WORD =
  '<body><!--StartFragment--><p class=MsoNormal>Hello <b>Word</b><o:p></o:p></p>\n' +
  "<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='mso-list:Ignore'>·<span>&nbsp;&nbsp; </span></span><![endif]>One<o:p></o:p></p>\n" +
  "<p class=MsoListParagraphCxSpLast style='mso-list:l0 level2 lfo1'><span style='mso-list:Ignore'>1.<span>&nbsp; </span></span>Two<o:p></o:p></p><!--EndFragment--></body>";

describe('htmlToMarkdown (#62)', () => {
  it('Google Docs: no global bold, paragraphs kept apart, styled spans', () => {
    expect(htmlToMarkdown(GDOCS)).toBe('First with **bold** and *italic*\n\nSecond\n\n- one\n- two');
  });
  it('Word pseudo lists become markdown lists', () => {
    expect(htmlToMarkdown(WORD)).toBe('Hello **Word**\n\n- One\n   1. Two');
  });
  it('nested lists stay tight; table cells keep paragraphs; hrefs with parens', () => {
    expect(htmlToMarkdown('<ul><li>outer<ul><li>inner</li></ul></li></ul>')).toBe('- outer\n  - inner');
    expect(htmlToMarkdown('<table><tr><th>h</th></tr><tr><td><p>p1</p><p>p2</p></td></tr></table>')).toBe('| h |\n| --- |\n| p1<br>p2 |');
    expect(htmlToMarkdown('<p><a href="https://w.org/A_(b)">w</a></p>')).toBe('[w](https://w.org/A_(b%29)');
  });
});

describe('fitToContext (#62)', () => {
  it('block markdown pasted mid-paragraph splits the paragraph', () => {
    const d = new Doc('AB\n');
    expect(fitToContext(d, '# H\n\n- a\n- b\n', 1, 1)).toBe('\n\n# H\n\n- a\n- b\n\n');
  });
  it('plain lines pasted into a list item / quote keep the container prefix', () => {
    expect(fitToContext(new Doc('- AB\n'), 'x\ny\n\nz', 3, 3)).toBe('\n\n  x\n  y\n\n  z\n\n  ');
    expect(fitToContext(new Doc('> AB\n'), 'x\ny', 3, 3)).toBe('x\n> y');
  });
  it('single lines are untouched', () => {
    expect(fitToContext(new Doc('AB\n'), 'x\n', 1, 1)).toBe('x');
  });
});
