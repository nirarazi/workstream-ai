/**
 * Converts Slack mrkdwn message text into readable plain text.
 * Handles: user mentions, channel mentions, links, emoji codes, and basic formatting.
 */
export function formatSlackText(text: string): string {
  if (!text) return "";

  let result = text;

  // User mentions: <@U12345|username> → @username, <@U12345> → @user
  result = result.replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1");
  result = result.replace(/<@[A-Z0-9]+>/g, "@user");

  // Channel mentions: <#C12345|channel-name>
  result = result.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");
  result = result.replace(/<#[A-Z0-9]+>/g, "#channel");

  // Links: <url|label> → label, <url> → url
  result = result.replace(/<([^|>]+)\|([^>]+)>/g, "$2");
  result = result.replace(/<([^>]+)>/g, "$1");

  // Slack special commands
  result = result.replace(/<!here\|?[^>]*>/g, "@here");
  result = result.replace(/<!channel\|?[^>]*>/g, "@channel");
  result = result.replace(/<!everyone\|?[^>]*>/g, "@everyone");

  // Emoji shortcodes → unicode (common ones)
  result = result.replace(/:[\w+-]+:/g, (match) => EMOJI_MAP[match] ?? match);

  // Bold: *text* → text
  result = result.replace(/(^|\s)\*([^*\n]+)\*(\s|$|[.,!?])/g, "$1$2$3");

  // Italic: _text_ → text
  result = result.replace(/(^|\s)_([^_\n]+)_(\s|$|[.,!?])/g, "$1$2$3");

  // Strikethrough: ~text~ → text
  result = result.replace(/(^|\s)~([^~\n]+)~(\s|$|[.,!?])/g, "$1$2$3");

  // Inline code: `code` → code
  result = result.replace(/`([^`\n]+)`/g, "$1");

  // Code blocks: ```code``` → code
  result = result.replace(/```[\s\S]*?```/g, (match) =>
    match.replace(/```/g, "").trim(),
  );

  // Block quotes: &gt; text → text
  result = result.replace(/^&gt;\s?/gm, "");

  // HTML entities
  result = result.replace(/&amp;/g, "&");
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");

  // Collapse multiple newlines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

// ---------------------------------------------------------------------------
// Rich message parsing — returns structured segments for JSX rendering
// ---------------------------------------------------------------------------

export type Segment =
  | { type: "text"; value: string }
  | { type: "mention"; name: string }
  | { type: "channel"; name: string }
  | { type: "link"; url: string; label: string }
  | { type: "broadcast"; name: string }
  | { type: "emoji"; shortcode: string; unicode: string | null }
  | { type: "code"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string };

export interface ParseOptions {
  /** Map of Slack user ID → display name for resolving bare <@USERID> mentions */
  userMap?: Map<string, string>;
}

/**
 * Parse Slack mrkdwn text into a flat array of typed segments.
 * The caller (React component) decides how to render each segment.
 */
export function parseSlackMessage(text: string, opts?: ParseOptions): Segment[] {
  if (!text) return [];

  const userMap = opts?.userMap;

  // Decode HTML entities first
  let decoded = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

  // Collapse code blocks into single tokens before main parse so the inner
  // content isn't processed as Slack markup.
  const codeBlocks: string[] = [];
  decoded = decoded.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code.trim());
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  decoded = decoded.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Tokenize on Slack markup patterns AND inline formatting (*bold*, _italic_, ~strike~)
  const TOKEN_RE =
    /(<@[A-Z0-9]+(?:\|[^>]*)?>|<#[A-Z0-9]+(?:\|[^>]*)?>|<!(?:here|channel|everyone)[^>]*>|<[^>]+>|:[a-zA-Z0-9_+-]+:|\x00CB\d+\x00|\x00IC\d+\x00|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/;

  const parts = decoded.split(TOKEN_RE);
  const segments: Segment[] = [];

  for (const part of parts) {
    if (!part) continue;

    // Code block placeholder
    if (/^\x00CB(\d+)\x00$/.test(part)) {
      const idx = parseInt(part.replace(/\x00CB|\x00/g, ""), 10);
      segments.push({ type: "code", value: codeBlocks[idx] });
      continue;
    }

    // Inline code placeholder
    if (/^\x00IC(\d+)\x00$/.test(part)) {
      const idx = parseInt(part.replace(/\x00IC|\x00/g, ""), 10);
      segments.push({ type: "code", value: inlineCodes[idx] });
      continue;
    }

    // User mention: <@U123|Name> or <@U123>
    const userLabelMatch = part.match(/^<@([A-Z0-9]+)\|([^>]+)>$/);
    if (userLabelMatch) {
      segments.push({ type: "mention", name: userLabelMatch[2] });
      continue;
    }
    const userIdMatch = part.match(/^<@([A-Z0-9]+)>$/);
    if (userIdMatch) {
      const name = userMap?.get(userIdMatch[1]) ?? userIdMatch[1];
      segments.push({ type: "mention", name });
      continue;
    }

    // Channel mention: <#C123|name>
    const chanMatch = part.match(/^<#[A-Z0-9]+\|([^>]+)>$/);
    if (chanMatch) {
      segments.push({ type: "channel", name: chanMatch[1] });
      continue;
    }
    if (/^<#[A-Z0-9]+>$/.test(part)) {
      segments.push({ type: "channel", name: "channel" });
      continue;
    }

    // Broadcast: <!here>, <!channel>, <!everyone>
    const bcMatch = part.match(/^<!(\w+)/);
    if (bcMatch && /^<!(here|channel|everyone)/.test(part)) {
      segments.push({ type: "broadcast", name: bcMatch[1] });
      continue;
    }

    // Link: <url|label> or <url>
    const linkLabelMatch = part.match(/^<([^|>]+)\|([^>]+)>$/);
    if (linkLabelMatch) {
      segments.push({ type: "link", url: linkLabelMatch[1], label: linkLabelMatch[2] });
      continue;
    }
    const linkMatch = part.match(/^<(https?:\/\/[^>]+)>$/);
    if (linkMatch) {
      let label: string;
      try {
        const u = new URL(linkMatch[1]);
        label = u.hostname + (u.pathname === "/" ? "" : u.pathname);
      } catch {
        label = linkMatch[1];
      }
      segments.push({ type: "link", url: linkMatch[1], label });
      continue;
    }

    // Emoji shortcode
    const emojiMatch = part.match(/^(:[a-zA-Z0-9_+-]+:)$/);
    if (emojiMatch) {
      const unicode = EMOJI_MAP[emojiMatch[1]] ?? null;
      segments.push({ type: "emoji", shortcode: emojiMatch[1], unicode });
      continue;
    }

    // Bold: *text*
    const boldMatch = part.match(/^\*([^*\n]+)\*$/);
    if (boldMatch) {
      segments.push({ type: "bold", value: boldMatch[1] });
      continue;
    }

    // Italic: _text_
    const italicMatch = part.match(/^_([^_\n]+)_$/);
    if (italicMatch) {
      segments.push({ type: "italic", value: italicMatch[1] });
      continue;
    }

    // Strikethrough: ~text~ — render as text (no strikethrough segment type needed)
    const strikeMatch = part.match(/^~([^~\n]+)~$/);
    if (strikeMatch) {
      segments.push({ type: "text", value: strikeMatch[1] });
      continue;
    }

    // Plain text — push as-is
    if (part.length > 0) {
      segments.push({ type: "text", value: part });
    }
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Comprehensive emoji shortcode → unicode map
// ---------------------------------------------------------------------------

const EMOJI_MAP: Record<string, string> = {
  ":+1:": "\uD83D\uDC4D",
  ":-1:": "\uD83D\uDC4E",
  ":100:": "\uD83D\uDCAF",
  ":1234:": "\uD83D\uDD22",
  ":thumbsup:": "\uD83D\uDC4D",
  ":thumbsdown:": "\uD83D\uDC4E",
  ":ok_hand:": "\uD83D\uDC4C",
  ":wave:": "\uD83D\uDC4B",
  ":clap:": "\uD83D\uDC4F",
  ":raised_hands:": "\uD83D\uDE4C",
  ":pray:": "\uD83D\uDE4F",
  ":muscle:": "\uD83D\uDCAA",
  ":point_right:": "\uD83D\uDC49",
  ":point_left:": "\uD83D\uDC48",
  ":point_up:": "\u261D\uFE0F",
  ":point_down:": "\uD83D\uDC47",
  ":eyes:": "\uD83D\uDC40",
  ":brain:": "\uD83E\uDDE0",
  // faces
  ":smile:": "\uD83D\uDE04",
  ":grinning:": "\uD83D\uDE00",
  ":laughing:": "\uD83D\uDE06",
  ":joy:": "\uD83D\uDE02",
  ":rofl:": "\uD83E\uDD23",
  ":slightly_smiling_face:": "\uD83D\uDE42",
  ":wink:": "\uD83D\uDE09",
  ":blush:": "\uD83D\uDE0A",
  ":innocent:": "\uD83D\uDE07",
  ":thinking_face:": "\uD83E\uDD14",
  ":neutral_face:": "\uD83D\uDE10",
  ":expressionless:": "\uD83D\uDE11",
  ":unamused:": "\uD83D\uDE12",
  ":roll_eyes:": "\uD83D\uDE44",
  ":grimacing:": "\uD83D\uDE2C",
  ":relieved:": "\uD83D\uDE0C",
  ":pensive:": "\uD83D\uDE14",
  ":sleeping:": "\uD83D\uDE34",
  ":drooling_face:": "\uD83E\uDD24",
  ":sunglasses:": "\uD83D\uDE0E",
  ":nerd_face:": "\uD83E\uDD13",
  ":sweat_smile:": "\uD83D\uDE05",
  ":cold_sweat:": "\uD83D\uDE30",
  ":scream:": "\uD83D\uDE31",
  ":flushed:": "\uD83D\uDE33",
  ":dizzy_face:": "\uD83D\uDE35",
  ":rage:": "\uD83D\uDE21",
  ":angry:": "\uD83D\uDE20",
  ":cry:": "\uD83D\uDE22",
  ":sob:": "\uD83D\uDE2D",
  ":disappointed:": "\uD83D\uDE1E",
  ":worried:": "\uD83D\uDE1F",
  ":confused:": "\uD83D\uDE15",
  ":hushed:": "\uD83D\uDE2F",
  ":astonished:": "\uD83D\uDE32",
  ":zipper_mouth_face:": "\uD83E\uDD10",
  ":mask:": "\uD83D\uDE37",
  ":robot_face:": "\uD83E\uDD16",
  ":smiling_imp:": "\uD83D\uDE08",
  ":skull:": "\uD83D\uDC80",
  ":ghost:": "\uD83D\uDC7B",
  ":alien:": "\uD83D\uDC7D",
  ":heart_eyes:": "\uD83D\uDE0D",
  ":kissing_heart:": "\uD83D\uDE18",
  ":stuck_out_tongue:": "\uD83D\uDE1B",
  ":stuck_out_tongue_winking_eye:": "\uD83D\uDE1C",
  ":stuck_out_tongue_closed_eyes:": "\uD83D\uDE1D",
  ":hugging_face:": "\uD83E\uDD17",
  ":shrug:": "\uD83E\uDD37",
  ":face_palm:": "\uD83E\uDD26",
  ":man_shrugging:": "\uD83E\uDD37\u200D\u2642\uFE0F",
  ":woman_shrugging:": "\uD83E\uDD37\u200D\u2640\uFE0F",
  ":saluting_face:": "\uD83E\uDEE1",
  // hearts
  ":heart:": "\u2764\uFE0F",
  ":orange_heart:": "\uD83E\uDDE1",
  ":yellow_heart:": "\uD83D\uDC9B",
  ":green_heart:": "\uD83D\uDC9A",
  ":blue_heart:": "\uD83D\uDC99",
  ":purple_heart:": "\uD83D\uDC9C",
  ":broken_heart:": "\uD83D\uDC94",
  ":sparkling_heart:": "\uD83D\uDC96",
  // objects
  ":fire:": "\uD83D\uDD25",
  ":star:": "\u2B50",
  ":star2:": "\uD83C\uDF1F",
  ":sparkles:": "\u2728",
  ":zap:": "\u26A1",
  ":boom:": "\uD83D\uDCA5",
  ":tada:": "\uD83C\uDF89",
  ":confetti_ball:": "\uD83C\uDF8A",
  ":balloon:": "\uD83C\uDF88",
  ":trophy:": "\uD83C\uDFC6",
  ":medal:": "\uD83C\uDFC5",
  ":crown:": "\uD83D\uDC51",
  ":gem:": "\uD83D\uDC8E",
  ":rocket:": "\uD83D\uDE80",
  ":airplane:": "\u2708\uFE0F",
  ":hourglass:": "\u23F3",
  ":hourglass_flowing_sand:": "\u23F3",
  ":watch:": "\u231A",
  ":alarm_clock:": "\u23F0",
  ":stopwatch:": "\u23F1\uFE0F",
  ":bell:": "\uD83D\uDD14",
  ":key:": "\uD83D\uDD11",
  ":lock:": "\uD83D\uDD12",
  ":unlock:": "\uD83D\uDD13",
  ":bulb:": "\uD83D\uDCA1",
  ":flashlight:": "\uD83D\uDD26",
  ":wrench:": "\uD83D\uDD27",
  ":hammer:": "\uD83D\uDD28",
  ":nut_and_bolt:": "\uD83D\uDD29",
  ":gear:": "\u2699\uFE0F",
  ":chains:": "\u26D3\uFE0F",
  ":scissors:": "\u2702\uFE0F",
  ":paperclip:": "\uD83D\uDCCE",
  ":pushpin:": "\uD83D\uDCCC",
  ":round_pushpin:": "\uD83D\uDCCD",
  ":triangular_ruler:": "\uD83D\uDCCF",
  ":straight_ruler:": "\uD83D\uDCCF",
  ":clipboard:": "\uD83D\uDCCB",
  ":page_facing_up:": "\uD83D\uDCC4",
  ":page_with_curl:": "\uD83D\uDCC3",
  ":bookmark_tabs:": "\uD83D\uDCD1",
  ":bar_chart:": "\uD83D\uDCCA",
  ":chart_with_upwards_trend:": "\uD83D\uDCC8",
  ":chart_with_downwards_trend:": "\uD83D\uDCC9",
  ":memo:": "\uD83D\uDCDD",
  ":pencil:": "\u270F\uFE0F",
  ":pencil2:": "\u270F\uFE0F",
  ":pen:": "\uD83D\uDD8A\uFE0F",
  ":calendar:": "\uD83D\uDCC5",
  ":date:": "\uD83D\uDCC5",
  ":file_folder:": "\uD83D\uDCC1",
  ":open_file_folder:": "\uD83D\uDCC2",
  ":wastebasket:": "\uD83D\uDDD1\uFE0F",
  ":package:": "\uD83D\uDCE6",
  ":mailbox:": "\uD83D\uDCEB",
  ":email:": "\uD83D\uDCE7",
  ":envelope:": "\u2709\uFE0F",
  ":inbox_tray:": "\uD83D\uDCE5",
  ":outbox_tray:": "\uD83D\uDCE4",
  ":link:": "\uD83D\uDD17",
  ":mag:": "\uD83D\uDD0D",
  ":mag_right:": "\uD83D\uDD0E",
  ":microscope:": "\uD83D\uDD2C",
  ":telescope:": "\uD83D\uDD2D",
  ":computer:": "\uD83D\uDCBB",
  ":desktop_computer:": "\uD83D\uDDA5\uFE0F",
  ":keyboard:": "\u2328\uFE0F",
  ":printer:": "\uD83D\uDDA8\uFE0F",
  ":mouse_three_button:": "\uD83D\uDDB1\uFE0F",
  ":cd:": "\uD83D\uDCBF",
  ":floppy_disk:": "\uD83D\uDCBE",
  ":satellite:": "\uD83D\uDCE1",
  ":battery:": "\uD83D\uDD0B",
  ":electric_plug:": "\uD83D\uDD0C",
  ":iphone:": "\uD83D\uDCF1",
  ":calling:": "\uD83D\uDCF2",
  ":telephone_receiver:": "\uD83D\uDCDE",
  ":tv:": "\uD83D\uDCFA",
  ":radio:": "\uD83D\uDCFB",
  ":camera:": "\uD83D\uDCF7",
  ":video_camera:": "\uD83D\uDCF9",
  ":movie_camera:": "\uD83C\uDFA5",
  ":clapper:": "\uD83C\uDFAC",
  ":microphone:": "\uD83C\uDFA4",
  ":headphones:": "\uD83C\uDFA7",
  ":musical_note:": "\uD83C\uDFB5",
  ":notes:": "\uD83C\uDFB6",
  ":art:": "\uD83C\uDFA8",
  // checks and symbols
  ":white_check_mark:": "\u2705",
  ":heavy_check_mark:": "\u2714\uFE0F",
  ":ballot_box_with_check:": "\u2611\uFE0F",
  ":x:": "\u274C",
  ":negative_squared_cross_mark:": "\u274E",
  ":bangbang:": "\u203C\uFE0F",
  ":interrobang:": "\u2049\uFE0F",
  ":question:": "\u2753",
  ":grey_question:": "\u2754",
  ":grey_exclamation:": "\u2755",
  ":exclamation:": "\u2757",
  ":warning:": "\u26A0\uFE0F",
  ":no_entry:": "\u26D4",
  ":no_entry_sign:": "\uD83D\uDEAB",
  ":forbidden:": "\uD83D\uDEAB",
  ":rotating_light:": "\uD83D\uDEA8",
  ":construction:": "\uD83D\uDEA7",
  ":stop_sign:": "\uD83D\uDED1",
  ":information_source:": "\u2139\uFE0F",
  ":recycle:": "\u267B\uFE0F",
  ":white_circle:": "\u26AA",
  ":black_circle:": "\u26AB",
  ":red_circle:": "\uD83D\uDD34",
  ":large_blue_circle:": "\uD83D\uDD35",
  ":large_orange_circle:": "\uD83D\uDFE0",
  ":large_yellow_circle:": "\uD83D\uDFE1",
  ":large_green_circle:": "\uD83D\uDFE2",
  ":large_purple_circle:": "\uD83D\uDFE3",
  ":large_brown_circle:": "\uD83D\uDFE4",
  ":checkered_flag:": "\uD83C\uDFC1",
  // arrows
  ":arrow_right:": "\u27A1\uFE0F",
  ":arrow_left:": "\u2B05\uFE0F",
  ":arrow_up:": "\u2B06\uFE0F",
  ":arrow_down:": "\u2B07\uFE0F",
  ":arrow_upper_right:": "\u2197\uFE0F",
  ":arrow_lower_right:": "\u2198\uFE0F",
  ":arrow_upper_left:": "\u2196\uFE0F",
  ":arrow_lower_left:": "\u2199\uFE0F",
  ":arrows_counterclockwise:": "\uD83D\uDD04",
  ":leftwards_arrow_with_hook:": "\u21A9\uFE0F",
  ":arrow_right_hook:": "\u21AA\uFE0F",
  // nature / weather
  ":sunny:": "\u2600\uFE0F",
  ":cloud:": "\u2601\uFE0F",
  ":partly_sunny:": "\u26C5",
  ":umbrella:": "\u2614",
  ":snowflake:": "\u2744\uFE0F",
  ":rainbow:": "\uD83C\uDF08",
  ":ocean:": "\uD83C\uDF0A",
  ":sunrise:": "\uD83C\uDF05",
  ":sunrise_over_mountains:": "\uD83C\uDF04",
  ":city_sunrise:": "\uD83C\uDF07",
  ":city_sunset:": "\uD83C\uDF06",
  ":crescent_moon:": "\uD83C\uDF19",
  ":full_moon:": "\uD83C\uDF15",
  ":new_moon:": "\uD83C\uDF11",
  ":earth_americas:": "\uD83C\uDF0E",
  ":earth_africa:": "\uD83C\uDF0D",
  ":earth_asia:": "\uD83C\uDF0F",
  ":volcano:": "\uD83C\uDF0B",
  ":milky_way:": "\uD83C\uDF0C",
  ":cyclone:": "\uD83C\uDF00",
  // animals
  ":dog:": "\uD83D\uDC36",
  ":cat:": "\uD83D\uDC31",
  ":mouse:": "\uD83D\uDC2D",
  ":hamster:": "\uD83D\uDC39",
  ":rabbit:": "\uD83D\uDC30",
  ":fox_face:": "\uD83E\uDD8A",
  ":bear:": "\uD83D\uDC3B",
  ":panda_face:": "\uD83D\uDC3C",
  ":koala:": "\uD83D\uDC28",
  ":tiger:": "\uD83D\uDC2F",
  ":lion_face:": "\uD83E\uDD81",
  ":unicorn_face:": "\uD83E\uDD84",
  ":bee:": "\uD83D\uDC1D",
  ":bug:": "\uD83D\uDC1B",
  ":butterfly:": "\uD83E\uDD8B",
  ":snail:": "\uD83D\uDC0C",
  ":snake:": "\uD83D\uDC0D",
  ":turtle:": "\uD83D\uDC22",
  ":octopus:": "\uD83D\uDC19",
  ":whale:": "\uD83D\uDC33",
  ":dolphin:": "\uD83D\uDC2C",
  ":eagle:": "\uD83E\uDD85",
  ":owl:": "\uD83E\uDD89",
  // food
  ":coffee:": "\u2615",
  ":tea:": "\uD83C\uDF75",
  ":beer:": "\uD83C\uDF7A",
  ":beers:": "\uD83C\uDF7B",
  ":wine_glass:": "\uD83C\uDF77",
  ":cocktail:": "\uD83C\uDF78",
  ":champagne:": "\uD83C\uDF7E",
  ":pizza:": "\uD83C\uDF55",
  ":hamburger:": "\uD83C\uDF54",
  ":fries:": "\uD83C\uDF5F",
  ":taco:": "\uD83C\uDF2E",
  ":burrito:": "\uD83C\uDF2F",
  ":sushi:": "\uD83C\uDF63",
  ":apple:": "\uD83C\uDF4E",
  ":banana:": "\uD83C\uDF4C",
  ":watermelon:": "\uD83C\uDF49",
  ":cake:": "\uD83C\uDF70",
  ":birthday:": "\uD83C\uDF82",
  ":cookie:": "\uD83C\uDF6A",
  ":chocolate_bar:": "\uD83C\uDF6B",
  ":ice_cream:": "\uD83C\uDF68",
  ":doughnut:": "\uD83C\uDF69",
  ":popcorn:": "\uD83C\uDF7F",
  // people / activities
  ":speech_balloon:": "\uD83D\uDCAC",
  ":thought_balloon:": "\uD83D\uDCAD",
  ":speaking_head_in_silhouette:": "\uD83D\uDDE3\uFE0F",
  ":bust_in_silhouette:": "\uD83D\uDC64",
  ":busts_in_silhouette:": "\uD83D\uDC65",
  ":boy:": "\uD83D\uDC66",
  ":girl:": "\uD83D\uDC67",
  ":man:": "\uD83D\uDC68",
  ":woman:": "\uD83D\uDC69",
  ":family:": "\uD83D\uDC6A",
  ":couple:": "\uD83D\uDC6B",
  ":dancer:": "\uD83D\uDC83",
  ":running:": "\uD83C\uDFC3",
  ":walking:": "\uD83D\uDEB6",
  // transport
  ":car:": "\uD83D\uDE97",
  ":taxi:": "\uD83D\uDE95",
  ":bus:": "\uD83D\uDE8C",
  ":ambulance:": "\uD83D\uDE91",
  ":fire_engine:": "\uD83D\uDE92",
  ":police_car:": "\uD83D\uDE93",
  ":truck:": "\uD83D\uDE9A",
  ":bike:": "\uD83D\uDEB2",
  ":ship:": "\uD83D\uDEA2",
  ":boat:": "\u26F5",
  ":train:": "\uD83D\uDE86",
  // buildings
  ":house:": "\uD83C\uDFE0",
  ":office:": "\uD83C\uDFE2",
  ":hospital:": "\uD83C\uDFE5",
  ":bank:": "\uD83C\uDFE6",
  ":hotel:": "\uD83C\uDFE8",
  ":school:": "\uD83C\uDFEB",
  ":church:": "\u26EA",
  ":tent:": "\u26FA",
  ":factory:": "\uD83C\uDFED",
  // money
  ":moneybag:": "\uD83D\uDCB0",
  ":dollar:": "\uD83D\uDCB5",
  ":credit_card:": "\uD83D\uDCB3",
  ":chart:": "\uD83D\uDCB9",
  ":money_with_wings:": "\uD83D\uDCB8",
  // misc
  ":zzz:": "\uD83D\uDCA4",
  ":poop:": "\uD83D\uDCA9",
  ":sweat_drops:": "\uD83D\uDCA6",
  ":dash:": "\uD83D\uDCA8",
  ":dizzy:": "\uD83D\uDCAB",
  ":speech_balloon:": "\uD83D\uDCAC",
  ":thought_balloon:": "\uD83D\uDCAD",
  ":anger:": "\uD83D\uDCA2",
  ":bomb:": "\uD83D\uDCA3",
  ":collision:": "\uD83D\uDCA5",
  ":raised_hand:": "\u270B",
  ":hand:": "\u270B",
  ":v:": "\u270C\uFE0F",
  ":pinching_hand:": "\uD83E\uDD0F",
  ":crossed_fingers:": "\uD83E\uDD1E",
  ":metal:": "\uD83E\uDD18",
  ":call_me_hand:": "\uD83E\uDD19",
  ":writing_hand:": "\u270D\uFE0F",
  ":handshake:": "\uD83E\uDD1D",
  ":open_hands:": "\uD83D\uDC50",
  ":palms_up_together:": "\uD83E\uDD32",
  // clothing / accessories
  ":tophat:": "\uD83C\uDFA9",
  ":womans_hat:": "\uD83D\uDC52",
  ":mortar_board:": "\uD83C\uDF93",
  ":necktie:": "\uD83D\uDC54",
  ":shirt:": "\uD83D\uDC55",
  ":jeans:": "\uD83D\uDC56",
  ":dress:": "\uD83D\uDC57",
  ":kimono:": "\uD83D\uDC58",
  ":bikini:": "\uD83D\uDC59",
  ":purse:": "\uD83D\uDC5B",
  ":handbag:": "\uD83D\uDC5C",
  ":high_heel:": "\uD83D\uDC60",
  ":boot:": "\uD83D\uDC62",
  ":eyeglasses:": "\uD83D\uDC53",
  ":dark_sunglasses:": "\uD83D\uDD76\uFE0F",
  ":ring:": "\uD83D\uDC8D",
  ":lipstick:": "\uD83D\uDC84",
  // sports / activities
  ":soccer:": "\u26BD",
  ":basketball:": "\uD83C\uDFC0",
  ":football:": "\uD83C\uDFC8",
  ":baseball:": "\u26BE",
  ":tennis:": "\uD83C\uDFBE",
  ":golf:": "\u26F3",
  ":ski:": "\uD83C\uDFBF",
  ":snowboarder:": "\uD83C\uDFC2",
  ":surfer:": "\uD83C\uDFC4",
  ":swimmer:": "\uD83C\uDFCA",
  ":weight_lifting:": "\uD83C\uDFCB\uFE0F",
  ":dart:": "\uD83C\uDFAF",
  ":bowling:": "\uD83C\uDFB3",
  ":video_game:": "\uD83C\uDFAE",
  ":slot_machine:": "\uD83C\uDFB0",
  ":game_die:": "\uD83C\uDFB2",
  ":crystal_ball:": "\uD83D\uDD2E",
  // time
  ":timer_clock:": "\u23F2\uFE0F",
  ":mantelpiece_clock:": "\uD83D\uDD70\uFE0F",
  ":clock1:": "\uD83D\uDD50",
  ":clock12:": "\uD83D\uDD5B",
  // flags
  ":flag-us:": "\uD83C\uDDFA\uD83C\uDDF8",
  ":flag-gb:": "\uD83C\uDDEC\uD83C\uDDE7",
  ":flag-il:": "\uD83C\uDDEE\uD83C\uDDF1",
  ":flag-ua:": "\uD83C\uDDFA\uD83C\uDDE6",
  ":triangular_flag_on_post:": "\uD83D\uDEA9",
  ":white_flag:": "\uD83C\uDFF3\uFE0F",
  ":black_flag:": "\uD83C\uDFF4",
  ":rainbow_flag:": "\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08",
  // plants
  ":seedling:": "\uD83C\uDF31",
  ":evergreen_tree:": "\uD83C\uDF32",
  ":deciduous_tree:": "\uD83C\uDF33",
  ":palm_tree:": "\uD83C\uDF34",
  ":cactus:": "\uD83C\uDF35",
  ":tulip:": "\uD83C\uDF37",
  ":cherry_blossom:": "\uD83C\uDF38",
  ":rose:": "\uD83C\uDF39",
  ":hibiscus:": "\uD83C\uDF3A",
  ":sunflower:": "\uD83C\uDF3B",
  ":four_leaf_clover:": "\uD83C\uDF40",
  ":maple_leaf:": "\uD83C\uDF41",
  ":fallen_leaf:": "\uD83C\uDF42",
  ":mushroom:": "\uD83C\uDF44",
  // misc extra
  ":moyai:": "\uD83D\uDDFF",
  ":izakaya_lantern:": "\uD83C\uDFEE",
  ":prayer_beads:": "\uD83D\uDCFF",
  ":potable_water:": "\uD83D\uDEB0",
  ":seat:": "\uD83D\uDCBA",
  ":thinking:": "\uD83E\uDD14",
  ":mag:": "\uD83D\uDD0D",
  ":loudspeaker:": "\uD83D\uDCE2",
  ":mega:": "\uD83D\uDCE3",
  ":no_bell:": "\uD83D\uDD15",
  ":mute:": "\uD83D\uDD07",
  ":sound:": "\uD83D\uDD09",
  ":loud_sound:": "\uD83D\uDD0A",
  ":satellite_antenna:": "\uD83D\uDCE1",
  ":shield:": "\uD83D\uDEE1\uFE0F",
  ":crossed_swords:": "\u2694\uFE0F",
  ":dagger_knife:": "\uD83D\uDDE1\uFE0F",
  ":axe:": "\uD83E\uDE93",
  ":test_tube:": "\uD83E\uDDEA",
  ":petri_dish:": "\uD83E\uDDEB",
  ":dna:": "\uD83E\uDDEC",
  ":abacus:": "\uD83E\uDDF0",
  ":broom:": "\uD83E\uDDF9",
  ":thread:": "\uD83E\uDDF5",
  ":yarn:": "\uD83E\uDDF6",
  ":jigsaw:": "\uD83E\uDDE9",
  ":infinity:": "\u267E\uFE0F",
  ":heavy_plus_sign:": "\u2795",
  ":heavy_minus_sign:": "\u2796",
  ":heavy_division_sign:": "\u2797",
  ":heavy_multiplication_x:": "\u2716\uFE0F",
  ":wavy_dash:": "\u3030\uFE0F",
  ":curly_loop:": "\u27B0",
  ":loop:": "\u27BF",
  ":copyright:": "\u00A9\uFE0F",
  ":registered:": "\u00AE\uFE0F",
  ":tm:": "\u2122\uFE0F",
  ":slightly_smiling_face:": "\uD83D\uDE42",
  ":partying_face:": "\uD83E\uDD73",
  ":smirk:": "\uD83D\uDE0F",
  ":yawning_face:": "\uD83E\uDD71",
  ":pleading_face:": "\uD83E\uDD7A",
  ":hot_face:": "\uD83E\uDD75",
  ":cold_face:": "\uD83E\uDD76",
  ":woozy_face:": "\uD83E\uDD74",
  ":exploding_head:": "\uD83E\uDD2F",
  ":cowboy_hat_face:": "\uD83E\uDD20",
  ":clown_face:": "\uD83E\uDD21",
  ":lying_face:": "\uD83E\uDD25",
  ":shushing_face:": "\uD83E\uDD2B",
  ":hand_over_mouth:": "\uD83E\uDD2D",
  ":monocle_face:": "\uD83E\uDDD0",
  ":nerd:": "\uD83E\uDD13",
  ":triumph:": "\uD83D\uDE24",
  ":persevere:": "\uD83D\uDE23",
  ":sweat:": "\uD83D\uDE13",
  ":weary:": "\uD83D\uDE29",
  ":tired_face:": "\uD83D\uDE2B",
  ":fearful:": "\uD83D\uDE28",
  ":anguished:": "\uD83D\uDE27",
  ":open_mouth:": "\uD83D\uDE2E",
  ":no_mouth:": "\uD83D\uDE36",
};
