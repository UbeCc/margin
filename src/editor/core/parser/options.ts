/**
 * Syntax options read by the (pure) parsers (#102). One editor per window, so a
 * module-level option set is enough; the editor handle updates it from
 * `EditorSettings.markdown` and re-renders. Options only change *rendering*:
 * the source is never rewritten, so `serialize(parse(x)) === x` for every option set.
 */
import { DEFAULT_MARKDOWN_OPTIONS, type MarkdownOptions } from '../../../contracts';

export const syntaxOptions: MarkdownOptions = { ...DEFAULT_MARKDOWN_OPTIONS };

/** Apply a patch; returns true when a parser-relevant option changed. */
export function setSyntaxOptions(patch: Partial<MarkdownOptions> | undefined): boolean {
  if (!patch) return false;
  let changed = false;
  for (const [k, v] of Object.entries(patch) as [keyof MarkdownOptions, never][]) {
    if (v === undefined || syntaxOptions[k] === v) continue;
    (syntaxOptions as unknown as Record<string, unknown>)[k] = v;
    if (PARSER_KEYS.has(k)) changed = true;
  }
  return changed;
}

/** Restore defaults (tests). */
export function resetSyntaxOptions(): void {
  Object.assign(syntaxOptions, DEFAULT_MARKDOWN_OPTIONS);
}

/** Options that change parse trees (block or inline). */
export const PARSER_KEYS: ReadonlySet<keyof MarkdownOptions> = new Set<keyof MarkdownOptions>([
  'highlight', 'subscript', 'superscript', 'inlineMath', 'emoji', 'strict',
  'remapPunctuation', 'smartPunctuation', 'smartQuote', 'smartDash',
]);

/**
 * Remap Unicode Punctuation on Parse (#133, fe-preferences §7.3/§10): on when the
 * box is checked, or forced while smart quotes/dashes convert on input (the input
 * pipeline stores curly punctuation the parser must still recognise).
 * Scope (typora-re#12): blockquote `>〉》`, task brackets `[\[【](x|X)[\]】]`,
 * dash family (front-matter/`---`-line equality + dash-first mixed runs) —
 * full-width digits/dot/minus/＊/＃ are inert.
 */
export function remapOn(): boolean {
  const o = syntaxOptions;
  return o.remapPunctuation || (o.smartPunctuation === 'input' && (o.smartQuote || o.smartDash));
}

/** Common GitHub-style emoji shortcodes (rendered only; the `:code:` source stays). */
export const EMOJI: Readonly<Record<string, string>> = {
  smile: '😄', smiley: '😃', grinning: '😀', laughing: '😆', joy: '😂', wink: '😉', blush: '😊', heart_eyes: '😍',
  sunglasses: '😎', thinking: '🤔', neutral_face: '😐', confused: '😕', cry: '😢', sob: '😭', angry: '😠', scream: '😱',
  sweat_smile: '😅', relaxed: '☺️', innocent: '😇', yum: '😋', sleeping: '😴', tada: '🎉', sparkles: '✨', fire: '🔥',
  heart: '❤️', broken_heart: '💔', star: '⭐', zap: '⚡', sunny: '☀️', cloud: '☁️', umbrella: '☔', snowflake: '❄️',
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', ok_hand: '👌', clap: '👏', wave: '👋', pray: '🙏',
  muscle: '💪', point_right: '👉', point_left: '👈', raised_hands: '🙌', eyes: '👀', rocket: '🚀', warning: '⚠️',
  white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌', question: '❓', exclamation: '❗', bulb: '💡', memo: '📝',
  book: '📖', books: '📚', bookmark: '🔖', link: '🔗', lock: '🔒', key: '🔑', bell: '🔔', calendar: '📅',
  email: '📧', phone: '📱', computer: '💻', bug: '🐛', wrench: '🔧', hammer: '🔨', gear: '⚙️', package: '📦',
  coffee: '☕', beer: '🍺', pizza: '🍕', apple: '🍎', cat: '🐱', dog: '🐶', tiger: '🐯', panda_face: '🐼',
  hourglass: '⌛', watch: '⌚', moon: '🌙', earth_americas: '🌎', globe_with_meridians: '🌐', '100': '💯', poop: '💩',
  arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️', arrow_down: '⬇️', smirk: '😏', kissing_heart: '😘',
};
