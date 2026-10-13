/**
 * Turns extracted form fields into a FillPlan.
 *
 * Layer 1 (heuristics): standard fields are mapped deterministically from the profile so the
 * common 80% of an application never touches the model and is fully predictable.
 * Layer 2 (saved answers): questions the human answered before are reused by fuzzy match.
 * Layer 3 (model): whatever is left goes to Claude in one structured-output call, and every
 * decision is validated against the actual field before it is allowed into the plan.
 *
 * Invariants:
 *  - File uploads only ever come from profile-declared documents. The model cannot name a path.
 *  - Select/radio values must correspond to a real option.
 *  - Low-confidence or empty answers on required fields become ask_human, never guesses.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { LoadedProfile, SavedAnswer } from "../config.js";
import { profileBlock } from "../scoring/prompts.js";
import type { Evaluation, FieldOption, FormField, Job, PlanItem } from "../types.js";
import { bestMatch, pickBoolean, similarity } from "../util/fuzzy.js";
import { normalize, truncate } from "../util/text.js";

export interface PlannerContext {
  profile: LoadedProfile;
  job: Job;
  evaluation: Evaluation | null;
  answers: SavedAnswer[];
  /** Path to a generated cover-letter file, if the agent produced one for file-only cover letter inputs. */
  coverLetterFile?: string;
  today?: Date;
}

interface Resolution {
  value: string | null;
  filePath?: string;
  confidence: number;
  rationale: string;
  /** Force the action (e.g. skip) regardless of field kind. */
  action?: PlanItem["action"];
}

type Rule = {
  name: string;
  /** Match against the combined label/name/id/autocomplete/placeholder text. */
  test: (field: FormField, text: string) => boolean;
  resolve: (field: FormField, ctx: PlannerContext) => Resolution | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fieldText(f: FormField): string {
  return normalize([f.label, f.name ?? "", f.id ?? "", f.autocomplete ?? "", f.placeholder ?? ""].join(" "));
}

const re = (pattern: RegExp) => (_f: FormField, text: string) => pattern.test(text);
const DECLINE = /decline|prefer not|don'?t wish|do not wish|rather not|not to (answer|disclose|identify|self)/i;

/** Choose an option label for choice fields, or pass the raw value through for free text. */
function choose(field: FormField, desired: string, confidence: number, rationale: string): Resolution | null {
  if (field.options.length === 0) return { value: desired, confidence, rationale };
  const m = bestMatch(desired, field.options, (o) => o.label, 0.6);
  if (m) return { value: m.item.label, confidence: Math.min(confidence, 0.5 + m.score / 2), rationale };
  return null;
}

function chooseBoolean(field: FormField, want: boolean, confidence: number, rationale: string): Resolution | null {
  if (field.kind === "checkbox") return { value: want ? "true" : "false", confidence, rationale };
  if (field.options.length === 0) return { value: want ? "Yes" : "No", confidence, rationale };
  const opt = pickBoolean(want, field.options, (o: FieldOption) => o.label);
  return opt ? { value: opt.label, confidence, rationale } : null;
}

function chooseDecline(field: FormField, desired: string, rationale: string): Resolution | null {
  const direct = choose(field, desired, 0.75, rationale);
  if (direct && direct.confidence >= 0.7) return direct;
  const decline = field.options.find((o) => DECLINE.test(o.label));
  if (decline) return { value: decline.label, confidence: 0.7, rationale: `${rationale} (closest decline option)` };
  return direct;
}

function fullName(ctx: PlannerContext): string {
  return `${ctx.profile.candidate.first_name} ${ctx.profile.candidate.last_name}`;
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

/** "TX" -> "Texas"; anything else passes through. */
export function expandState(state: string): string {
  return US_STATES[state.trim().toUpperCase()] ?? state;
}

/** "Austin, Texas" — the long state name matches location autocompletes far more reliably than "TX". */
function cityState(ctx: PlannerContext): string {
  const l = ctx.profile.candidate.location;
  return [l.city, l.state ? expandState(l.state) : ""].filter(Boolean).join(", ");
}

/**
 * Normalize a form question for matching against saved answers: the company name becomes
 * "here" so "Why do you want to work at Acme Robotics?" matches "Why do you want to work here?".
 */
export function genericizeQuestion(label: string, company: string): string {
  const words = normalize(company).split(" ").filter((w) => w.length > 1 && !/^(inc|llc|ltd|corp|co|the)$/.test(w));
  let text = normalize(label);
  if (words.length) {
    const full = words.join(" ");
    text = text.replace(new RegExp(`\\b(join(ing)?)\\s+(the\\s+)?${escapeRegExp(full)}('s)?\\b`, "g"), "$1 us");
    text = text.replace(new RegExp(`\\b(at|for|with)\\s+(the\\s+)?${escapeRegExp(full)}('s)?\\b`, "g"), "here");
    text = text.replace(new RegExp(`\\b${escapeRegExp(full)}('s)?\\b`, "g"), "here");
    for (const w of words) text = text.replace(new RegExp(`\\b${escapeRegExp(w)}('s)?\\b`, "g"), "here");
    text = text.replace(/\bhere( here)+\b/g, "here").replace(/\s+/g, " ").trim();
  }
  return text;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function yearsOption(field: FormField, years: number): Resolution | null {
  if (field.options.length === 0) return { value: String(years), confidence: 0.9, rationale: "years of experience from profile" };
  for (const o of field.options) {
    const nums = o.label.match(/\d+/g)?.map(Number) ?? [];
    const plus = /\+|or more|more than|over/i.test(o.label);
    if (nums.length >= 2 && years >= (nums[0] ?? 0) && years <= (nums[1] ?? 0)) return { value: o.label, confidence: 0.85, rationale: "years range from profile" };
    if (nums.length === 1 && plus && years >= (nums[0] ?? 0)) return { value: o.label, confidence: 0.85, rationale: "years range from profile" };
    if (nums.length === 1 && /less than|under|fewer/i.test(o.label) && years < (nums[0] ?? 0)) return { value: o.label, confidence: 0.85, rationale: "years range from profile" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rules (order matters: first match wins)
// ---------------------------------------------------------------------------

const RULES: Rule[] = [
  {
    name: "resume upload",
    test: (f, t) => f.kind === "file" && (/resume|cv\b|curriculum/.test(t) || !/cover|letter|transcript|portfolio|photo|other/.test(t)),
    resolve: (f, ctx) => ({ value: "resume_pdf", filePath: ctx.profile.resumePdfPath, confidence: 0.95, rationale: "resume from profile documents" }),
  },
  {
    name: "cover letter upload",
    test: (f, t) => f.kind === "file" && /cover|letter/.test(t),
    resolve: (f, ctx) =>
      ctx.coverLetterFile
        ? { value: "cover_letter_file", filePath: ctx.coverLetterFile, confidence: 0.8, rationale: "generated cover letter" }
        : { value: null, confidence: 0.6, rationale: "no cover letter file available", action: f.required ? "ask_human" : "skip" },
  },
  {
    name: "other file",
    test: (f) => f.kind === "file",
    resolve: (f) => ({ value: null, confidence: 0.5, rationale: "unrecognized file input", action: f.required ? "ask_human" : "skip" }),
  },
  {
    name: "cover letter text",
    test: (f, t) => f.kind === "textarea" && /cover ?letter/.test(t),
    resolve: (f, ctx) =>
      ctx.evaluation?.coverLetter ? { value: ctx.evaluation.coverLetter, confidence: 0.9, rationale: "tailored cover letter" } : null,
  },
  {
    name: "first name",
    test: re(/\b(first|given)[ -]?name\b|^first$|given-name|\bfname\b/),
    resolve: (_f, ctx) => ({ value: ctx.profile.candidate.first_name, confidence: 0.98, rationale: "profile" }),
  },
  {
    name: "last name",
    test: re(/\b(last|family)[ -]?name\b|surname|family-name|\blname\b/),
    resolve: (_f, ctx) => ({ value: ctx.profile.candidate.last_name, confidence: 0.98, rationale: "profile" }),
  },
  {
    name: "preferred name",
    test: re(/preferred (first )?name|nickname|what should we call you/),
    resolve: (_f, ctx) => ({ value: ctx.profile.candidate.preferred_name ?? ctx.profile.candidate.first_name, confidence: 0.9, rationale: "profile" }),
  },
  {
    name: "full name",
    test: (f, t) => f.kind !== "file" && /(^|\b)(full |your |legal |candidate |applicant )?name(\b|$)/.test(t) && !/company|employer|school|university|referr|user ?name|file ?name|contact name|manager/.test(t),
    resolve: (_f, ctx) => ({ value: fullName(ctx), confidence: 0.9, rationale: "profile" }),
  },
  {
    name: "email",
    test: (f, t) => f.kind === "email" || /e-?mail/.test(t),
    resolve: (_f, ctx) => ({ value: ctx.profile.candidate.email, confidence: 0.98, rationale: "profile" }),
  },
  {
    name: "phone country / dial code",
    test: (f, t) => /(phone|dial|country) ?code|phone country/.test(t) && f.options.length > 0,
    resolve: (f, ctx) => choose(f, ctx.profile.candidate.location.country, 0.7, "country for phone code"),
  },
  {
    name: "phone",
    test: (f, t) => f.kind === "tel" || /\b(phone|mobile|telephone|cell)\b/.test(t),
    resolve: (_f, ctx) => ({ value: ctx.profile.candidate.phone, confidence: 0.97, rationale: "profile" }),
  },
  {
    name: "linkedin",
    test: re(/linked ?in/),
    resolve: (f, ctx) =>
      ctx.profile.candidate.linkedin ? { value: ctx.profile.candidate.linkedin, confidence: 0.97, rationale: "profile" } : f.required ? null : { value: null, confidence: 0.9, rationale: "no LinkedIn in profile", action: "skip" },
  },
  {
    name: "github",
    test: re(/git ?hub/),
    resolve: (f, ctx) =>
      ctx.profile.candidate.github ? { value: ctx.profile.candidate.github, confidence: 0.97, rationale: "profile" } : f.required ? null : { value: null, confidence: 0.9, rationale: "no GitHub in profile", action: "skip" },
  },
  {
    name: "portfolio / website",
    test: re(/portfolio|personal (web)?site|\bwebsite\b|\burl\b|\blink\b|other (profile|site)/),
    resolve: (f, ctx) => {
      const c = ctx.profile.candidate;
      const v = c.portfolio ?? c.website ?? c.github;
      return v ? { value: v, confidence: 0.85, rationale: "profile portfolio/website" } : f.required ? null : { value: null, confidence: 0.9, rationale: "no website in profile", action: "skip" };
    },
  },
  {
    name: "country",
    test: (f, t) => /\bcountry\b/.test(t) && !/code/.test(t),
    resolve: (f, ctx) => choose(f, ctx.profile.candidate.location.country, 0.9, "profile country"),
  },
  {
    name: "postal code",
    test: re(/\b(zip|postal|post) ?code\b|\bzip\b/),
    resolve: (f, ctx) => (ctx.profile.candidate.location.postal_code ? { value: ctx.profile.candidate.location.postal_code, confidence: 0.95, rationale: "profile" } : f.required ? null : { value: null, confidence: 0.9, rationale: "no postal code in profile", action: "skip" }),
  },
  {
    name: "state / province",
    test: (f, t) => /\b(state|province|region)\b/.test(t) && !/united states|statement/.test(t),
    resolve: (f, ctx) => (ctx.profile.candidate.location.state ? choose(f, ctx.profile.candidate.location.state, 0.85, "profile state") : null),
  },
  {
    name: "city / location",
    test: re(/\b(city|location|where (are you|do you) (located|based|live)|based in|current (location|city))\b/),
    resolve: (f, ctx) => {
      if (/\bcity\b/.test(fieldText(f)) && !/state|location/.test(fieldText(f)) && f.kind !== "combobox") {
        return { value: ctx.profile.candidate.location.city, confidence: 0.9, rationale: "profile city" };
      }
      return { value: cityState(ctx), confidence: 0.85, rationale: "profile location" };
    },
  },
  {
    name: "street address",
    test: re(/\b(street|address line|mailing address|home address|^address)\b/),
    resolve: (f, ctx) => (ctx.profile.candidate.location.address ? { value: ctx.profile.candidate.location.address, confidence: 0.9, rationale: "profile" } : f.required ? null : { value: null, confidence: 0.9, rationale: "no address in profile", action: "skip" }),
  },
  {
    name: "current company",
    test: re(/current (company|employer|organization)|most recent (company|employer)|\bemployer\b|company name/),
    resolve: (f, ctx) => (ctx.profile.candidate.current_company ? { value: ctx.profile.candidate.current_company, confidence: 0.85, rationale: "profile" } : null),
  },
  {
    name: "current title",
    test: re(/current (job )?(title|role|position)|most recent (title|role)|\bjob title\b/),
    resolve: (f, ctx) => (ctx.profile.candidate.current_title ? { value: ctx.profile.candidate.current_title, confidence: 0.85, rationale: "profile" } : null),
  },
  {
    name: "years of experience",
    test: re(/years? of (professional |relevant |work |industry |total )?experience|how many years|years experience/),
    resolve: (f, ctx) => (ctx.profile.candidate.years_of_experience !== undefined ? yearsOption(f, ctx.profile.candidate.years_of_experience) : null),
  },
  {
    name: "work authorization",
    test: re(/legally (authori[sz]ed|eligible|permitted)|authori[sz](ed|ation) to work|eligib(le|ility) to work|right to work|work authori[sz]ation|lawfully/),
    resolve: (f, ctx) => {
      const auth = ctx.profile.work_authorization.authorized_countries.map(normalize);
      const t = fieldText(f);
      const mentioned = auth.find((c) => t.includes(c)) ?? (t.includes("united states") || t.includes("u.s") || t.includes(" us ") ? auth.find((c) => /united states|usa/.test(c)) : undefined);
      const want = mentioned !== undefined || auth.length > 0;
      return chooseBoolean(f, want, 0.85, "work authorization from profile");
    },
  },
  {
    name: "visa sponsorship",
    test: re(/sponsorship|sponsor|\bvisa\b/),
    resolve: (f, ctx) => chooseBoolean(f, ctx.profile.work_authorization.requires_sponsorship, 0.85, "sponsorship from profile"),
  },
  {
    name: "relocation",
    test: re(/relocat/),
    resolve: (f, ctx) => chooseBoolean(f, ctx.profile.work_authorization.willing_to_relocate, 0.85, "relocation preference from profile"),
  },
  {
    name: "age / over 18",
    test: re(/\b18\b|legal age|age requirement|years of age/),
    resolve: (f, ctx) => chooseBoolean(f, ctx.profile.screening.over_18, 0.9, "age from profile"),
  },
  {
    name: "previously employed here",
    test: re(/previously (worked|employed|been employed)|former employee|ever (worked|been employed) (for|at|with)|worked (here|for us) before|current(ly)? or former employee/),
    resolve: (f, ctx) => chooseBoolean(f, ctx.profile.screening.previously_employed_here, 0.85, "profile screening"),
  },
  {
    name: "how did you hear",
    test: re(/how did you (hear|find|learn)|where did you (hear|find)|referral source|\bsource\b/),
    resolve: (f, ctx) => {
      const direct = choose(f, ctx.profile.screening.how_did_you_hear, 0.8, "profile screening");
      if (direct) return direct;
      const fallback = f.options.find((o) => /career|website|job board|other|search/i.test(o.label));
      return fallback ? { value: fallback.label, confidence: 0.6, rationale: "closest source option" } : null;
    },
  },
  {
    name: "referrer",
    test: re(/referr(ed|al) (by|name|from)|referrer|who referred|employee referral/),
    resolve: (f, ctx) => (ctx.profile.screening.referred_by ? { value: ctx.profile.screening.referred_by, confidence: 0.9, rationale: "profile" } : f.required ? null : { value: null, confidence: 0.9, rationale: "no referrer", action: "skip" }),
  },
  {
    name: "salary expectation",
    test: re(/salary|compensation|pay (expectation|range|rate)|desired (pay|rate)/),
    resolve: (f, ctx) => (ctx.profile.screening.salary_expectation ? { value: ctx.profile.screening.salary_expectation, confidence: 0.8, rationale: "profile screening" } : null),
  },
  {
    name: "start date / availability",
    test: re(/start date|available to start|availability|earliest (start|date)|when (can|could) you start|notice period/),
    resolve: (f, ctx) => {
      const t = fieldText(f);
      const v = /notice/.test(t) ? ctx.profile.screening.notice_period ?? ctx.profile.screening.start_date : ctx.profile.screening.start_date ?? ctx.profile.screening.notice_period;
      return v ? { value: v, confidence: 0.8, rationale: "profile screening" } : null;
    },
  },
  {
    name: "pronouns",
    test: re(/pronoun/),
    resolve: (f, ctx) => (ctx.profile.candidate.pronouns ? choose(f, ctx.profile.candidate.pronouns, 0.85, "profile") : f.required ? chooseDecline(f, "Prefer not to say", "no pronouns in profile") : { value: null, confidence: 0.9, rationale: "no pronouns in profile", action: "skip" }),
  },
  {
    name: "eeo gender",
    test: re(/\bgender\b|\bsex\b/),
    resolve: (f, ctx) => chooseDecline(f, ctx.profile.screening.eeo.gender ?? "Decline to self-identify", "EEO default"),
  },
  {
    name: "eeo hispanic/latino",
    test: re(/hispanic|latin[ox]/),
    resolve: (f, ctx) => chooseDecline(f, ctx.profile.screening.eeo.hispanic_latino ?? "Decline to self-identify", "EEO default"),
  },
  {
    name: "eeo race",
    test: re(/\brace\b|ethnicity|ethnic/),
    resolve: (f, ctx) => chooseDecline(f, ctx.profile.screening.eeo.race ?? "Decline to self-identify", "EEO default"),
  },
  {
    name: "eeo veteran",
    test: re(/veteran|military/),
    resolve: (f, ctx) => chooseDecline(f, ctx.profile.screening.eeo.veteran ?? "I don't wish to answer", "EEO default"),
  },
  {
    name: "eeo disability",
    test: re(/disabilit/),
    resolve: (f, ctx) => chooseDecline(f, ctx.profile.screening.eeo.disability ?? "I don't wish to answer", "EEO default"),
  },
  {
    name: "self-id date",
    test: (f, t) => (f.kind === "date" || /^date( signed)?$|today'?s date/.test(t)) && !/birth|start|graduat|end/.test(t),
    resolve: (_f, ctx) => ({ value: (ctx.today ?? new Date()).toISOString().slice(0, 10), confidence: 0.8, rationale: "today" }),
  },
  {
    name: "marketing opt-in",
    test: (f, t) => f.kind === "checkbox" && /newsletter|marketing|talent (community|network)|future (opportunities|roles|openings)|keep me (informed|updated)|send me/.test(t),
    resolve: () => ({ value: "false", confidence: 0.85, rationale: "declined marketing opt-in" }),
  },
  {
    name: "consent / acknowledgement",
    test: (f, t) => f.kind === "checkbox" && /agree|consent|acknowledge|privacy|terms|certify|accurate|confirm|understand|authorize/.test(t),
    resolve: () => ({ value: "true", confidence: 0.8, rationale: "required acknowledgement (you approve the whole form at review)" }),
  },
];

// ---------------------------------------------------------------------------
// Layer 1 + 2
// ---------------------------------------------------------------------------

function actionFor(field: FormField, res: Resolution): PlanItem["action"] {
  if (res.action) return res.action;
  if (field.kind === "file") return "upload";
  if (field.kind === "checkbox") return "check";
  if (field.kind === "select" || field.kind === "radio" || field.kind === "combobox" || field.kind === "checkbox_group") return "select";
  return "fill";
}

function toItem(field: FormField, res: Resolution, source: PlanItem["source"]): PlanItem {
  return {
    ref: field.ref,
    label: field.label,
    kind: field.kind,
    required: field.required,
    action: actionFor(field, res),
    value: res.value,
    filePath: res.filePath,
    confidence: res.confidence,
    source,
    rationale: res.rationale,
  };
}

/** Saved answers and profile custom_answers, matched by question similarity. */
export function answerLookup(field: FormField, ctx: PlannerContext): Resolution | null {
  const company = normalize(ctx.job.company);
  const pool: Array<{ question: string; answer: string; company?: string; weight: number }> = [
    ...ctx.answers.map((a) => ({ ...a, weight: a.company && normalize(a.company) === company ? 1.05 : a.company ? 0 : 1 })),
    ...ctx.profile.custom_answers.map((a) => ({ ...a, weight: a.company && normalize(a.company) === company ? 1.05 : a.company ? 0 : 0.98 })),
  ].filter((a) => a.weight > 0);
  if (!pool.length) return null;
  const question = genericizeQuestion(field.label, ctx.job.company);
  let best: { score: number; answer: string; question: string } | null = null;
  for (const a of pool) {
    const score = Math.max(similarity(question, genericizeQuestion(a.question, ctx.job.company)), similarity(field.label, a.question)) * a.weight;
    if (!best || score > best.score) best = { score, answer: a.answer, question: a.question };
  }
  // Free-form questions get a slightly lower bar: the human sees the answer at review anyway.
  const threshold = field.kind === "textarea" ? 0.72 : 0.8;
  if (!best || best.score < threshold) return null;
  const rationale = `saved answer for "${best.question}"`;
  if (field.options.length) {
    if (/^(yes|no|true|false)$/i.test(best.answer.trim())) return chooseBoolean(field, /^(yes|true)$/i.test(best.answer.trim()), 0.8, rationale);
    return choose(field, best.answer, 0.8, rationale);
  }
  if (field.kind === "checkbox") return { value: /^(yes|true|1)$/i.test(best.answer.trim()) ? "true" : "false", confidence: 0.8, rationale };
  return { value: best.answer, confidence: Math.min(0.9, best.score), rationale };
}

export interface HeuristicResult {
  plan: PlanItem[];
  unresolved: FormField[];
}

export function heuristicPlan(fields: FormField[], ctx: PlannerContext): HeuristicResult {
  const plan: PlanItem[] = [];
  const unresolved: FormField[] = [];
  let resumeAssigned = false;

  for (const field of fields) {
    if (field.kind === "unknown") {
      unresolved.push(field);
      continue;
    }
    // Saved answers win over generic rules for free-form questions (they are more specific).
    const saved = field.kind === "textarea" || field.options.length > 0 || field.kind === "text" ? answerLookup(field, ctx) : null;
    if (saved && saved.confidence >= 0.8 && (field.kind === "textarea" || !RULES.slice(0, 15).some((r) => r.test(field, fieldText(field))))) {
      plan.push(toItem(field, saved, "answers"));
      continue;
    }

    const text = fieldText(field);
    let resolved: Resolution | null = null;
    for (const rule of RULES) {
      if (!rule.test(field, text)) continue;
      if (rule.name === "resume upload" && resumeAssigned) continue;
      resolved = rule.resolve(field, ctx);
      if (resolved) {
        if (rule.name === "resume upload") resumeAssigned = true;
        resolved.rationale = `${rule.name}: ${resolved.rationale}`;
        break;
      }
    }
    if (!resolved && saved) resolved = saved;
    if (resolved) {
      plan.push(toItem(field, resolved, saved === resolved ? "answers" : "heuristic"));
    } else {
      unresolved.push(field);
    }
  }
  return { plan, unresolved };
}

// ---------------------------------------------------------------------------
// Layer 3: model
// ---------------------------------------------------------------------------

export const ModelPlanOutput = z.object({
  decisions: z.array(
    z.object({
      ref: z.string().describe("The field ref exactly as given"),
      action: z.enum(["fill", "select", "check", "skip", "ask_human"]),
      value: z.string().describe("Text to enter, the exact option label to pick, 'true'/'false' for checkboxes, or empty for skip/ask_human"),
      confidence: z.enum(["high", "medium", "low"]),
      rationale: z.string().describe("One short sentence"),
    }),
  ),
});

export type ModelDecision = z.infer<typeof ModelPlanOutput>["decisions"][number];

export const PLANNER_INSTRUCTIONS = `You are filling out a job application form on behalf of the candidate described in this system prompt. You will receive the job, the candidate's tailored materials, and a list of form fields that could not be mapped automatically. For each field decide what to enter.

Rules:
- Use only facts from the candidate profile, resume and tailored materials. Never invent employers, degrees, dates, numbers or credentials. If the form asks for something the profile does not contain (e.g. a school name you cannot find in the resume, a government ID, a specific certification) use action "ask_human".
- For fields with options, "value" must be one of the option labels verbatim. Pick "select" as the action.
- For checkboxes, action "check" with value "true" or "false".
- For free-text questions (why this company, describe a project, etc.) write a concise, specific, first-person answer in the candidate's voice: 2-5 sentences unless the field obviously wants a short phrase. Draw on the posting and the tailored summary. No markdown.
- Optional fields you have nothing good for: action "skip".
- Required fields you cannot answer confidently: action "ask_human". Prefer ask_human over a guess for anything about legal status, compensation history, references, demographics or personal identifiers.
- Never answer demographic (EEO) questions with anything other than a decline/prefer-not-to-answer option unless the profile states a value.
- Return one decision per field ref. Do not add refs that were not provided.`;

/** Compact, model-facing rendering of the fields. */
export function describeFields(fields: FormField[]): string {
  return fields
    .map((f) => {
      const parts = [`ref=${f.ref}`, `kind=${f.kind}`, f.required ? "required" : "optional", `label=${JSON.stringify(f.label || f.placeholder || f.name || "")}`];
      if (f.section) parts.push(`section=${JSON.stringify(truncate(f.section, 80))}`);
      if (f.placeholder && f.placeholder !== f.label) parts.push(`placeholder=${JSON.stringify(f.placeholder)}`);
      if (f.options.length) parts.push(`options=${JSON.stringify(f.options.slice(0, 60).map((o) => o.label))}`);
      if (f.value) parts.push(`current=${JSON.stringify(truncate(f.value, 60))}`);
      return "- " + parts.join(" ");
    })
    .join("\n");
}

export function plannerUserMessage(fields: FormField[], ctx: PlannerContext): string {
  const ev = ctx.evaluation;
  return [
    `# Job`,
    `Company: ${ctx.job.company}`,
    `Title: ${ctx.job.title}`,
    `Location: ${ctx.job.location || "not stated"}`,
    ``,
    `## Posting (excerpt)`,
    truncate(ctx.job.descriptionText, 6000),
    ``,
    ev ? `## Tailored materials\nSummary: ${ev.tailoredSummary}\n\nCover letter:\n${ev.coverLetter}` : "",
    ``,
    `# Fields to decide`,
    describeFields(fields),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const CONFIDENCE: Record<ModelDecision["confidence"], number> = { high: 0.9, medium: 0.7, low: 0.4 };

/**
 * Validate model decisions against the real fields. Anything that does not check out is
 * downgraded to ask_human (required) or skip (optional) rather than executed.
 */
export function validateModelPlan(decisions: ModelDecision[], fields: FormField[]): PlanItem[] {
  const byRef = new Map(fields.map((f) => [f.ref, f]));
  const seen = new Set<string>();
  const items: PlanItem[] = [];

  const fallback = (field: FormField, rationale: string): PlanItem => ({
    ref: field.ref,
    label: field.label,
    kind: field.kind,
    required: field.required,
    action: field.required ? "ask_human" : "skip",
    value: null,
    confidence: 0.3,
    source: "model",
    rationale,
  });

  for (const d of decisions) {
    const field = byRef.get(d.ref);
    if (!field || seen.has(d.ref)) continue;
    seen.add(d.ref);
    const confidence = CONFIDENCE[d.confidence];
    const value = d.value?.trim() ?? "";
    const base: PlanItem = { ref: field.ref, label: field.label, kind: field.kind, required: field.required, action: d.action, value, confidence, source: "model", rationale: d.rationale };

    if (field.kind === "file") {
      items.push(fallback(field, "file inputs are never filled from model output"));
      continue;
    }
    if (d.action === "ask_human") {
      items.push({ ...base, value: null });
      continue;
    }
    if (d.action === "skip") {
      items.push(field.required ? { ...base, action: "ask_human", value: null, rationale: `model skipped a required field: ${d.rationale}` } : { ...base, value: null });
      continue;
    }
    if (confidence < 0.5) {
      items.push(fallback(field, `low confidence: ${d.rationale}`));
      continue;
    }
    if (!value) {
      items.push(fallback(field, "model returned an empty value"));
      continue;
    }
    if (field.kind === "checkbox" || d.action === "check") {
      const bool = /^(true|yes|1|checked)$/i.test(value) ? "true" : /^(false|no|0|unchecked)$/i.test(value) ? "false" : null;
      if (!bool || field.kind !== "checkbox") {
        if (field.kind === "checkbox_group") {
          const chosen = value.split(/[;,]/).map((v) => bestMatch(v.trim(), field.options, (o) => o.label, 0.6)).filter(Boolean);
          if (chosen.length) {
            items.push({ ...base, action: "check", value: chosen.map((c) => c!.item.label).join("; ") });
            continue;
          }
        }
        items.push(fallback(field, `unusable checkbox value "${value}"`));
        continue;
      }
      items.push({ ...base, action: "check", value: bool });
      continue;
    }
    if (field.options.length > 0) {
      const m = bestMatch(value, field.options, (o) => o.label, 0.6);
      if (!m) {
        items.push(fallback(field, `"${value}" is not one of the options`));
        continue;
      }
      items.push({ ...base, action: "select", value: m.item.label, confidence: Math.min(confidence, 0.5 + m.score / 2) });
      continue;
    }
    items.push({ ...base, action: field.kind === "combobox" ? "select" : "fill" });
  }

  for (const field of fields) {
    if (!seen.has(field.ref)) items.push(fallback(field, "model gave no decision"));
  }
  return items;
}

export interface ModelPlanner {
  plan(fields: FormField[], ctx: PlannerContext): Promise<PlanItem[]>;
}

export class ClaudePlanner implements ModelPlanner {
  constructor(
    private readonly client: Anthropic,
    private readonly opts: { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" } = {},
  ) {}

  async plan(fields: FormField[], ctx: PlannerContext): Promise<PlanItem[]> {
    if (fields.length === 0) return [];
    const response = await this.client.beta.messages.parse({
      model: this.opts.model ?? ctx.profile.model.planning,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: PLANNER_INSTRUCTIONS },
        { type: "text", text: profileBlock(ctx.profile), cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: plannerUserMessage(fields, ctx) }],
      output_config: { effort: this.opts.effort ?? ctx.profile.model.planning_effort, format: betaZodOutputFormat(ModelPlanOutput) },
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      // Nothing from the model: every remaining field goes to the human.
      return validateModelPlan([], fields);
    }
    return validateModelPlan(response.parsed_output.decisions, fields);
  }
}

/** Planner that never calls a model: all unresolved fields become ask_human / skip. */
export class NoModelPlanner implements ModelPlanner {
  async plan(fields: FormField[]): Promise<PlanItem[]> {
    return validateModelPlan([], fields);
  }
}

/** Full pipeline: heuristics, saved answers, then the model for the remainder. */
export async function buildPlan(fields: FormField[], ctx: PlannerContext, model: ModelPlanner): Promise<PlanItem[]> {
  const { plan, unresolved } = heuristicPlan(fields, ctx);
  const modelItems = await model.plan(unresolved, ctx);
  const order = new Map(fields.map((f, i) => [f.ref, i]));
  return [...plan, ...modelItems].sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0));
}
