import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface Paths {
  root: string;
  configDir: string;
  dataDir: string;
  profile: string;
  sources: string;
  answers: string;
  db: string;
  browserProfile: string;
  screenshots: string;
}

/** Resolve all file locations from a project root (default: cwd, overridable with JOBAGENT_HOME). */
export function resolvePaths(root = process.env.JOBAGENT_HOME ?? process.cwd()): Paths {
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  return {
    root,
    configDir,
    dataDir,
    profile: path.join(configDir, "profile.yaml"),
    sources: path.join(configDir, "sources.yaml"),
    answers: path.join(configDir, "answers.yaml"),
    db: path.join(dataDir, "jobagent.db"),
    browserProfile: path.join(dataDir, "browser-profile"),
    screenshots: path.join(dataDir, "screenshots"),
  };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const EeoSchema = z
  .object({
    gender: z.string().default("Decline to self-identify"),
    race: z.string().default("Decline to self-identify"),
    hispanic_latino: z.string().default("Decline to self-identify"),
    veteran: z.string().default("I don't wish to answer"),
    disability: z.string().default("I don't wish to answer"),
  })
  .partial()
  .default({});

export const ProfileSchema = z.object({
  candidate: z.object({
    first_name: z.string().min(1),
    last_name: z.string().min(1),
    preferred_name: z.string().optional(),
    email: z.string().email(),
    phone: z.string().min(5),
    location: z.object({
      city: z.string(),
      state: z.string().optional().default(""),
      country: z.string().default("United States"),
      postal_code: z.string().optional(),
      address: z.string().optional(),
    }),
    linkedin: z.string().url().optional(),
    github: z.string().url().optional(),
    portfolio: z.string().url().optional(),
    website: z.string().url().optional(),
    pronouns: z.string().optional(),
    current_title: z.string().optional(),
    current_company: z.string().optional(),
    years_of_experience: z.number().optional(),
  }),
  documents: z.object({
    /** Path to the resume PDF that gets uploaded. Relative paths resolve from the config directory. */
    resume_pdf: z.string(),
    /** Plain-text / markdown copy of the resume used in prompts. Path or inline text. */
    resume_text: z.string(),
    /** Optional base cover letter the model should stay consistent with. */
    cover_letter_template: z.string().optional(),
  }),
  work_authorization: z.object({
    authorized_countries: z.array(z.string()).default(["United States"]),
    requires_sponsorship: z.boolean().default(false),
    willing_to_relocate: z.boolean().default(false),
    security_clearance: z.string().optional(),
  }),
  preferences: z.object({
    titles_include: z.array(z.string()).default([]),
    titles_exclude: z.array(z.string()).default([]),
    keywords_include: z.array(z.string()).default([]),
    keywords_exclude: z.array(z.string()).default([]),
    locations: z.array(z.string()).default([]),
    remote: z.enum(["required", "preferred", "any", "no"]).default("preferred"),
    employment_types: z.array(z.string()).default([]),
    min_salary: z.number().optional(),
    max_posting_age_days: z.number().default(45),
    /** Jobs scoring at or above this are queued for application. */
    min_fit_score: z.number().default(70),
    seniority: z.array(z.string()).default([]),
    narrative: z.string().optional(),
  }),
  blocked_companies: z.array(z.string()).default([]),
  screening: z
    .object({
      salary_expectation: z.string().optional(),
      start_date: z.string().optional(),
      notice_period: z.string().optional(),
      how_did_you_hear: z.string().default("Company website"),
      previously_employed_here: z.boolean().default(false),
      referred_by: z.string().optional(),
      over_18: z.boolean().default(true),
      eeo: EeoSchema,
    })
    .prefault({}),
  /** Reusable free-form answers. Matched to form questions by fuzzy label similarity. */
  custom_answers: z
    .array(
      z.object({
        question: z.string(),
        answer: z.string(),
        /** Restrict to a company (case-insensitive) if set. */
        company: z.string().optional(),
      }),
    )
    .default([]),
  model: z
    .object({
      scoring: z.string().default("claude-opus-5-5"),
      planning: z.string().default("claude-opus-5-5"),
      scoring_effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
      planning_effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
      concurrency: z.number().int().min(1).max(8).default(3),
    })
    .prefault({}),
});

export type Profile = z.infer<typeof ProfileSchema>;

/** A profile with document paths resolved and resume text loaded. */
export interface LoadedProfile extends Profile {
  resumePdfPath: string;
  resumeText: string;
}

export function loadProfile(paths: Paths): LoadedProfile {
  if (!fs.existsSync(paths.profile)) {
    throw new Error(`No profile at ${paths.profile}. Run \`jobagent init\` and edit config/profile.yaml.`);
  }
  const raw = YAML.parse(fs.readFileSync(paths.profile, "utf8"));
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid profile.yaml:\n${z.prettifyError(parsed.error)}`);
  }
  const profile = parsed.data;
  const resumePdfPath = path.resolve(paths.configDir, profile.documents.resume_pdf);
  if (!fs.existsSync(resumePdfPath)) {
    console.warn(`warning: documents.resume_pdf not found at ${resumePdfPath}; resume uploads will fail until it exists`);
  }
  const resumeText = readTextOrInline(paths.configDir, profile.documents.resume_text);
  return { ...profile, resumePdfPath, resumeText };
}

/** If `value` names a readable file, return its contents; otherwise return `value` as inline text. */
function readTextOrInline(baseDir: string, value: string): string {
  const looksLikePath = value.length < 512 && !value.includes("\n") && /\.(md|txt|markdown)$/i.test(value.trim());
  const candidate = path.resolve(baseDir, value.trim());
  if (looksLikePath) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return fs.readFileSync(candidate, "utf8");
    console.warn(`warning: documents.resume_text looks like a file path but ${candidate} does not exist; using it as literal text`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const SourceSchema = z.object({
  type: z.enum(["greenhouse", "lever", "ashby"]),
  /** Board token (Greenhouse), site (Lever) or org slug (Ashby). */
  slug: z.string().min(1),
  /** Display name; defaults to the slug. */
  company: z.string().optional(),
});

export type SourceConfig = z.infer<typeof SourceSchema>;

export const SourcesFileSchema = z.object({
  sources: z.array(SourceSchema).default([]),
});

export function loadSources(paths: Paths): SourceConfig[] {
  if (!fs.existsSync(paths.sources)) {
    throw new Error(`No sources file at ${paths.sources}. Run \`jobagent init\` and edit config/sources.yaml.`);
  }
  const raw = YAML.parse(fs.readFileSync(paths.sources, "utf8")) ?? {};
  const parsed = SourcesFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid sources.yaml:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.sources;
}

// ---------------------------------------------------------------------------
// Learned answers (answers typed by the human during review, reused later)
// ---------------------------------------------------------------------------

export const AnswerSchema = z.object({
  question: z.string(),
  answer: z.string(),
  company: z.string().optional(),
  learned_at: z.string().optional(),
});
export type SavedAnswer = z.infer<typeof AnswerSchema>;

export function loadAnswers(paths: Paths): SavedAnswer[] {
  if (!fs.existsSync(paths.answers)) return [];
  const raw = YAML.parse(fs.readFileSync(paths.answers, "utf8")) ?? {};
  const parsed = z.object({ answers: z.array(AnswerSchema).default([]) }).safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid answers.yaml:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.answers;
}

export function saveAnswer(paths: Paths, answer: SavedAnswer): void {
  const existing = loadAnswers(paths);
  const idx = existing.findIndex(
    (a) => a.question.toLowerCase() === answer.question.toLowerCase() && (a.company ?? "") === (answer.company ?? ""),
  );
  const next = { ...answer, learned_at: new Date().toISOString() };
  if (idx >= 0) existing[idx] = next;
  else existing.push(next);
  fs.mkdirSync(path.dirname(paths.answers), { recursive: true });
  fs.writeFileSync(paths.answers, YAML.stringify({ answers: existing }), "utf8");
}
