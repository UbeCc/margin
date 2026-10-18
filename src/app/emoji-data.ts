/**
 * Common GitHub-style emoji shortcodes for `:emoji:` autocomplete (#103). Compact
 * "name emoji" pairs; aliases share an emoji. Not exhaustive — the inserted text is
 * the `:name:` shortcode, so unknown names stay lossless in the Markdown.
 */
const RAW = `
smile 😄|smiley 😃|grinning 😀|laughing 😆|satisfied 😆|joy 😂|rofl 🤣|blush 😊|wink 😉|heart_eyes 😍|kissing_heart 😘
relaxed ☺️|yum 😋|stuck_out_tongue 😛|sunglasses 😎|smirk 😏|neutral_face 😐|expressionless 😑|unamused 😒|sweat_smile 😅
sweat 😓|pensive 😔|confused 😕|confounded 😖|disappointed 😞|worried 😟|angry 😠|rage 😡|cry 😢|sob 😭|scream 😱
astonished 😲|flushed 😳|sleeping 😴|dizzy_face 😵|mask 😷|thinking 🤔|hugs 🤗|innocent 😇|upside_down_face 🙃
slightly_smiling_face 🙂|roll_eyes 🙄|zipper_mouth_face 🤐|nerd_face 🤓|star_struck 🤩|partying_face 🥳|exploding_head 🤯
cold_sweat 😰|grimacing 😬|hushed 😯|open_mouth 😮|tired_face 😫|weary 😩|triumph 😤|skull 💀|ghost 👻|alien 👽|robot 🤖
poop 💩|hankey 💩|clown_face 🤡|smiling_imp 😈|see_no_evil 🙈|hear_no_evil 🙉|speak_no_evil 🙊|wave 👋|raised_hand ✋
ok_hand 👌|thumbsup 👍|+1 👍|thumbsdown 👎|-1 👎|clap 👏|pray 🙏|muscle 💪|point_up ☝️|point_down 👇|point_left 👈
point_right 👉|v ✌️|crossed_fingers 🤞|raised_hands 🙌|handshake 🤝|eyes 👀|brain 🧠|heart ❤️|orange_heart 🧡
yellow_heart 💛|green_heart 💚|blue_heart 💙|purple_heart 💜|black_heart 🖤|broken_heart 💔|sparkling_heart 💖|two_hearts 💕
star ⭐|star2 🌟|sparkles ✨|zap ⚡|fire 🔥|boom 💥|collision 💥|tada 🎉|confetti_ball 🎊|gift 🎁|balloon 🎈|trophy 🏆
medal_sports 🏅|crown 👑|gem 💎|bell 🔔|bulb 💡|book 📖|books 📚|memo 📝|pencil 📝|pencil2 ✏️|pushpin 📌|paperclip 📎
link 🔗|lock 🔒|unlock 🔓|key 🔑|hammer 🔨|wrench 🔧|gear ⚙️|bug 🐛|rocket 🚀|computer 💻|keyboard ⌨️|phone ☎️
email 📧|envelope ✉️|calendar 📅|date 📅|clock3 🕒|hourglass ⌛|warning ⚠️|no_entry ⛔|x ❌|heavy_check_mark ✔️
white_check_mark ✅|ballot_box_with_check ☑️|question ❓|exclamation ❗|heavy_plus_sign ➕|heavy_minus_sign ➖|100 💯
arrow_right ➡️|arrow_left ⬅️|arrow_up ⬆️|arrow_down ⬇️|recycle ♻️|information_source ℹ️|copyright ©️|registered ®️|tm ™️
sunny ☀️|cloud ☁️|umbrella ☔|snowflake ❄️|rainbow 🌈|moon 🌙|earth_americas 🌎|globe_with_meridians 🌐|ocean 🌊
seedling 🌱|evergreen_tree 🌲|deciduous_tree 🌳|cactus 🌵|herb 🌿|four_leaf_clover 🍀|maple_leaf 🍁|fallen_leaf 🍂
rose 🌹|sunflower 🌻|cherry_blossom 🌸|tulip 🌷|apple 🍎|green_apple 🍏|banana 🍌|cherries 🍒|strawberry 🍓|lemon 🍋
watermelon 🍉|grapes 🍇|peach 🍑|pizza 🍕|hamburger 🍔|fries 🍟|cake 🍰|birthday 🎂|cookie 🍪|coffee ☕|tea 🍵|beer 🍺
wine_glass 🍷|cat 🐱|dog 🐶|mouse 🐭|rabbit 🐰|fox_face 🦊|bear 🐻|panda_face 🐼|koala 🐨|tiger 🐯|lion 🦁|cow 🐮
pig 🐷|frog 🐸|monkey_face 🐵|chicken 🐔|penguin 🐧|bird 🐦|turtle 🐢|snake 🐍|whale 🐳|dolphin 🐬|fish 🐟|octopus 🐙
unicorn 🦄|bee 🐝|honeybee 🐝|butterfly 🦋|snail 🐌|car 🚗|bus 🚌|bike 🚲|airplane ✈️|ship 🚢|train 🚆|house 🏠
office 🏢|hospital 🏥|school 🏫|tent ⛺|art 🎨|musical_note 🎵|notes 🎶|headphones 🎧|guitar 🎸|video_game 🎮|soccer ⚽
basketball 🏀|football 🏈|tennis 🎾|dart 🎯|camera 📷|movie_camera 🎥|tv 📺|mag 🔍|chart_with_upwards_trend 📈
chart_with_downwards_trend 📉|bar_chart 📊|clipboard 📋|file_folder 📁|open_file_folder 📂|package 📦|moneybag 💰
dollar 💵|credit_card 💳|shopping_cart 🛒|flag_cn 🇨🇳|cn 🇨🇳|us 🇺🇸|jp 🇯🇵|kr 🇰🇷|de 🇩🇪|fr 🇫🇷|gb 🇬🇧|checkered_flag 🏁
`;

export const EMOJI: [name: string, emoji: string][] = RAW.split(/[|\n]/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(' ');
    return [s.slice(0, i), s.slice(i + 1)] as [string, string];
  });

/**
 * Candidates for a typed prefix (fe-preferences §10): exact match first, then names
 * starting with the text (alphabetical), then names where it starts after `_` / `-`.
 */
export function emojiCandidates(prefix: string, limit = 8): [string, string][] {
  const p = prefix.toLowerCase();
  if (!p) return [];
  const exact = EMOJI.filter(([n]) => n === p);
  const starts = EMOJI.filter(([n]) => n !== p && n.startsWith(p)).sort((a, b) => a[0].localeCompare(b[0]));
  const inner = EMOJI.filter(([n]) => !n.startsWith(p) && n.split(/[_-]/).slice(1).some((w) => w.startsWith(p))).sort((a, b) => a[0].localeCompare(b[0]));
  return [...exact, ...starts, ...inner].slice(0, limit);
}
