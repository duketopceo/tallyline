// ESLint rules for docs/design/silver-lining.md section 13 "Token-only styling".
//   silver-lining/no-raw-color      hex / rgb() / rgba() / hsl() / hsla() in code
//   silver-lining/no-offscale-font  px font sizes outside 11 12 13 14 15 17 24, off-scale named
//                                   sizes (text-lg ...) and every arbitrary text-[Npx] size
//   silver-lining/no-palette-color  Tailwind palette classes (bg-red-600), white/black utilities
//                                   (text-white, bg-black/50), arbitrary non-token colours and
//                                   arbitrary shadow values
// Colour comes from tokens (Tailwind utilities or var(--sl-*)); type from the scale
// (text-micro, text-xs, text-body, text-sm, text-title, text-headline, text-2xl).

export const FONT_SCALE_PX = [11, 12, 13, 14, 15, 17, 24];

const HEX = /(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FN = /\b(?:rgba?|hsla?)\(/g;
// Tailwind named sizes whose rendered px is off the scale (xs=12, sm=14, 2xl=24 are on it)
const TW_NAMED_OFF = /(?<![\w-])text-(?:base|lg|xl|[3-9]xl)(?![\w-])/g;
// Arbitrary font sizes are banned outright (on-scale ones too): use the named type tokens.
const TW_ARBITRARY = /(?<![\w-])text-\[(?:length:)?(\d*\.?\d+)(px|rem|em)\]/g;

// Colour-taking utility prefixes. `border`, `ring` etc. also take widths, so the arbitrary
// rule below only flags colour-shaped values.
const ARB_COLOR_UTILS = ["bg", "text", "border(?:-[xytblrse])?", "ring", "outline", "divide", "fill", "stroke", "from", "via", "to", "decoration", "accent", "caret"];
const ARB_COLOR_PREFIX = `(?:${ARB_COLOR_UTILS.join("|")})`;
const COLOR_PREFIX = `(?:${[...ARB_COLOR_UTILS, "ring-offset", "placeholder", "shadow", "inset-ring", "inset-shadow", "drop-shadow", "text-shadow"].join("|")})`;
const PALETTE = "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)";
// A numeric shade is mandatory, so the app's own tokens (bg-neutral, bg-neutral-soft) stay clean.
const TW_PALETTE = new RegExp(`(?<![\\w-])${COLOR_PREFIX}-${PALETTE}-\\d{2,3}(?:/(?:\\d+|\\[[^\\]]+\\]))?(?![\\w-])`, "g");
const TW_WHITE_BLACK = new RegExp(`(?<![\\w-])${COLOR_PREFIX}-(?:white|black)(?:/(?:\\d+|\\[[^\\]]+\\]))?(?![\\w-])`, "g");
// Colour-shaped arbitrary values. Hex and rgb()/hsl() are left to no-raw-color so a hit is
// never counted twice; var(--...) values are token-driven and pass. Named CSS colours
// (bg-[red], text-[color:red]) are caught alongside the colour functions.
const NAMED_COLORS = "black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|silver|gold|navy|teal|cyan|magenta|brown|maroon|lime|olive|aqua|fuchsia|indigo|violet|crimson|coral|salmon|tomato";
const TW_ARB_COLOR = new RegExp(
  `(?<![\\w-])${ARB_COLOR_PREFIX}-\\[(?:(?:color|length):)?(?:(?:oklch|oklab|lab|lch|hwb|color\\(|color-mix)[^\\]]*|${NAMED_COLORS})\\]`,
  "g",
);
const TW_ARB_SHADOW = /(?<![\w-])(?:inset-|drop-|text-)?shadow-\[(?!var\(--[\w-]+\)\])[^\]]+\]/g;
// Tailwind's default shadow sizes ignore the theme; use shadow-overlay / shadow-tooltip.
const TW_SHADOW_NAMED = /(?<![\w-])(?:inset-|drop-)?shadow-(?:2xs|xs|sm|md|lg|xl|2xl)(?![\w-])/g;

const SKIP_ATTRS = new Set(["href", "id", "htmlFor", "src", "xmlns", "d", "viewBox", "points"]);

function colorHits(text) {
  const hits = [];
  for (const re of [HEX, FN]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) hits.push(m[0]);
  }
  return hits;
}

function fontHits(text) {
  const hits = [];
  TW_NAMED_OFF.lastIndex = 0;
  for (const m of text.matchAll(TW_NAMED_OFF)) hits.push(m[0]);
  TW_ARBITRARY.lastIndex = 0;
  for (const m of text.matchAll(TW_ARBITRARY)) hits.push(m[0]);
  return hits;
}

function paletteHits(text) {
  const hits = [];
  for (const re of [TW_PALETTE, TW_WHITE_BLACK, TW_ARB_COLOR, TW_ARB_SHADOW, TW_SHADOW_NAMED]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      // a shadow carrying a raw colour is already reported once by no-raw-color
      if (re === TW_ARB_SHADOW && colorHits(m[0]).length > 0) continue;
      hits.push(m[0]);
    }
  }
  return hits;
}

function inSkippedAttr(node) {
  const p = node.parent;
  return p?.type === "JSXAttribute" && SKIP_ATTRS.has(p.name?.name);
}

const noRawColor = {
  meta: {
    type: "problem",
    schema: [],
    messages: { raw: "Raw colour {{value}}: use a Silver Lining token (Tailwind utility or var(--sl-*))." },
  },
  create(context) {
    const check = (node, text) => {
      for (const value of colorHits(text)) context.report({ node, messageId: "raw", data: { value } });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string" && !inSkippedAttr(node)) check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? "");
      },
    };
  },
};

const noPaletteColor = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      palette: "{{value}} bypasses the tokens: use a Silver Lining colour/shadow token (bg-surface-2, text-ink-muted, shadow-overlay, ...).",
    },
  },
  create(context) {
    const check = (node, text) => {
      for (const value of paletteHits(text)) context.report({ node, messageId: "palette", data: { value } });
    };
    return {
      Literal(node) {
        if (typeof node.value === "string" && !inSkippedAttr(node)) check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? "");
      },
    };
  },
};

const noOffscaleFont = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      off: "Font size {{value}} is not a type token: use text-micro/xs/body/sm/title/headline/2xl (scale 11 12 13 14 15 17 24 px).",
    },
  },
  create(context) {
    const check = (node, text) => {
      for (const value of fontHits(text)) context.report({ node, messageId: "off", data: { value } });
    };
    const checkPx = (node, n) => {
      if (!FONT_SCALE_PX.includes(n)) {
        context.report({ node, messageId: "off", data: { value: `fontSize ${n}` } });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? "");
      },
      Property(node) {
        const key = node.key.type === "Identifier" ? node.key.name : node.key.value;
        if (key !== "fontSize") return;
        const v = node.value;
        if (v.type === "Literal" && typeof v.value === "number") checkPx(v, v.value);
        else if (v.type === "Literal" && typeof v.value === "string") {
          const m = /^(\d+(?:\.\d+)?)px$/.exec(v.value);
          if (m) checkPx(v, Number(m[1]));
        }
      },
    };
  },
};

const plugin = {
  meta: { name: "silver-lining" },
  rules: { "no-raw-color": noRawColor, "no-offscale-font": noOffscaleFont, "no-palette-color": noPaletteColor },
};

export default plugin;
