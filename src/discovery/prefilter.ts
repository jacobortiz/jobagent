/**
 * Cheap rule-based filter that runs before any LLM call. It is deliberately permissive:
 * its job is to drop obvious non-matches (wrong title family, wrong country, stale posts,
 * blocked companies), not to judge fit. Scoring does the judging.
 */
import type { Profile } from "../config.js";
import type { Job } from "../types.js";
import { normalize } from "../util/text.js";

export interface PrefilterResult {
  pass: boolean;
  reasons: string[];
}

type Prefs = Profile["preferences"];

/** Normalize for phrase matching: punctuation that normalize() keeps for tokens like "c++" becomes a word boundary. */
function matchable(text: string): string {
  return ` ${normalize(text).replace(/[.,/]+/g, " ").replace(/\s+/g, " ").trim()} `;
}

/** Whole-word / phrase containment on normalized text. */
export function containsPhrase(haystack: string, phrase: string): boolean {
  const h = matchable(haystack);
  const p = matchable(phrase).trim();
  if (!p) return false;
  return h.includes(` ${p} `) || h.includes(` ${p}s `);
}

export function matchesAnyPhrase(text: string, phrases: string[]): string | null {
  for (const p of phrases) if (containsPhrase(text, p)) return p;
  return null;
}

function locationMatches(job: Job, prefs: Prefs): boolean {
  if (prefs.locations.length === 0) return true;
  const jobLoc = normalize(job.location);
  const wantsRemote = prefs.locations.some((l) => normalize(l) === "remote");
  if (wantsRemote && (job.remote === true || /\bremote\b/.test(jobLoc))) return true;
  for (const loc of prefs.locations) {
    if (normalize(loc) === "remote") continue;
    // Match on the city token so "Austin, TX" accepts "Austin, Texas, United States".
    const city = normalize(loc.split(",")[0] ?? loc);
    if (city && jobLoc.includes(city)) return true;
  }
  return false;
}

export function prefilter(job: Job, profile: Pick<Profile, "preferences" | "blocked_companies">, now = new Date()): PrefilterResult {
  const prefs = profile.preferences;
  const reasons: string[] = [];

  if (profile.blocked_companies.some((c) => normalize(c) === normalize(job.company))) {
    reasons.push(`blocked company: ${job.company}`);
  }

  const excludedTitle = matchesAnyPhrase(job.title, prefs.titles_exclude);
  if (excludedTitle) reasons.push(`title excluded: "${excludedTitle}"`);

  if (prefs.titles_include.length > 0 && !matchesAnyPhrase(job.title, prefs.titles_include)) {
    reasons.push("title does not match any titles_include entry");
  }

  const excludedKeyword = matchesAnyPhrase(`${job.title} ${job.descriptionText}`, prefs.keywords_exclude);
  if (excludedKeyword) reasons.push(`contains excluded keyword: "${excludedKeyword}"`);

  if (prefs.keywords_include.length > 0 && !matchesAnyPhrase(`${job.title} ${job.descriptionText}`, prefs.keywords_include)) {
    reasons.push("none of keywords_include present");
  }

  if (prefs.remote === "required" && job.remote === false) reasons.push("remote required but job is on-site/hybrid");
  if (prefs.remote === "no" && job.remote === true) reasons.push("remote jobs excluded");

  if (!locationMatches(job, prefs) && !(prefs.remote === "required" && job.remote === true)) {
    reasons.push(`location "${job.location || "unknown"}" not in preferred locations`);
  }

  if (prefs.employment_types.length > 0 && job.employmentType) {
    const ok = prefs.employment_types.some((t) => normalize(job.employmentType ?? "").replace(/[^a-z]/g, "").includes(normalize(t).replace(/[^a-z]/g, "")));
    if (!ok) reasons.push(`employment type "${job.employmentType}" not wanted`);
  }

  if (job.postedAt && prefs.max_posting_age_days > 0) {
    const ageDays = (now.getTime() - new Date(job.postedAt).getTime()) / 86_400_000;
    if (ageDays > prefs.max_posting_age_days) reasons.push(`posted ${Math.floor(ageDays)} days ago (max ${prefs.max_posting_age_days})`);
  }

  return { pass: reasons.length === 0, reasons };
}
