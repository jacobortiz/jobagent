import { normalize, tokens } from "./text.js";

/** Classic Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

/** 0..1 similarity based on normalized edit distance. */
export function stringSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (!na.length || !nb.length) return 0;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

/** Jaccard overlap of word tokens, 0..1. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Blend of character and token similarity; robust to both typos and reordering. */
export function similarity(a: string, b: string): number {
  const s = stringSimilarity(a, b);
  const t = tokenSimilarity(a, b);
  const na = normalize(a);
  const nb = normalize(b);
  // Containment bonus: "United States" vs "United States of America"
  const contains = na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na)) ? 0.85 : 0;
  return Math.max(s, t, contains, 0.6 * s + 0.4 * t);
}

export interface Match<T> {
  item: T;
  score: number;
}

/** Pick the best candidate by similarity to `query`, or null if nothing reaches `threshold`. */
export function bestMatch<T>(query: string, candidates: T[], toText: (c: T) => string, threshold = 0.75): Match<T> | null {
  let best: Match<T> | null = null;
  for (const item of candidates) {
    const score = similarity(query, toText(item));
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= threshold ? best : null;
}

/**
 * Choose an option for a yes/no style question. Handles "Yes"/"No", "I am"/"I am not",
 * "Authorized"/"Not authorized" and similar phrasings.
 */
export function pickBoolean<T>(want: boolean, options: T[], toText: (o: T) => string): T | null {
  const yes = /^(yes|y|true|i am|i do|i have|authorized|eligible|agree|accept)\b/i;
  const no = /^(no|n|false|i am not|i do not|i don't|not |none|decline|disagree)\b/i;
  for (const o of options) {
    const text = toText(o).trim();
    if (want && yes.test(text) && !/not\b/i.test(text)) return o;
    if (!want && no.test(text)) return o;
  }
  // Fall back to fuzzy on bare yes/no.
  const target = want ? "yes" : "no";
  const m = bestMatch(target, options, toText, 0.6);
  return m ? m.item : null;
}
