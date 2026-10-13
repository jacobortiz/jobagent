/** Small, dependency-free text helpers shared across modules. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Decode HTML entities (named, decimal, hex). Idempotent on plain text. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/** Convert HTML to readable plain text, preserving paragraph and list structure. */
export function htmlToText(html: string): string {
  if (!html) return "";
  let text = html;
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, "\n\n");
  text = text.replace(/<li[^>]*>/gi, "\n• ");
  text = text.replace(/<\/li>/gi, "");
  text = text.replace(/<\/(ul|ol)>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/\r/g, "");
  text = text.replace(/[ \t ]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/** Lowercase, strip punctuation, collapse whitespace. Used for matching labels and titles. */
export function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9+#./ -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(input: string): string[] {
  return normalize(input)
    .split(/[\s/,-]+/)
    .filter((t) => t.length > 0);
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
