/**
 * Shared domain types. Everything that crosses a module boundary is defined here
 * so the discovery, scoring, application, and tracking layers agree on shapes.
 */

export type SourceKind = "greenhouse" | "lever" | "ashby";

/** A job posting normalized from any source adapter. */
export interface Job {
  /** Short stable id derived from source + slug + source_id (safe to type on the CLI). */
  id: string;
  source: SourceKind;
  /** The board / company slug used with the source API (e.g. "stripe"). */
  sourceSlug: string;
  /** The posting id as the source reports it. */
  sourceId: string;
  company: string;
  title: string;
  location: string;
  /** true = explicitly remote, false = explicitly not, null = unknown. */
  remote: boolean | null;
  /** Human-facing posting page. */
  url: string;
  /** Page that hosts the application form (what the agent navigates to). */
  applyUrl: string;
  descriptionText: string;
  descriptionHtml: string;
  /** ISO timestamp if the source reports one. */
  postedAt: string | null;
  department: string | null;
  employmentType: string | null;
  salaryText: string | null;
}

export type JobStatus =
  | "new" // discovered, not yet prefiltered (transient)
  | "filtered" // failed the rule-based prefilter
  | "ready" // passed prefilter, awaiting scoring
  | "scored" // has an evaluation
  | "applied" // an application was submitted
  | "skipped" // user or agent decided not to apply
  | "duplicate"; // same company+title seen via another source

export interface JobRecord extends Job {
  status: JobStatus;
  prefilterPass: boolean | null;
  prefilterReasons: string[];
  duplicateOf: string | null;
  discoveredAt: string;
  updatedAt: string;
}

export type Recommendation = "apply" | "maybe" | "skip";

/** Claude's structured assessment of one job against the profile. */
export interface Evaluation {
  id?: number;
  jobId: string;
  model: string;
  fitScore: number; // 0-100, clamped in code
  recommendation: Recommendation;
  summary: string;
  reasons: string[];
  redFlags: string[];
  missingRequirements: string[];
  matchedRequirements: string[];
  seniorityMatch: "under" | "match" | "over";
  tailoredSummary: string;
  coverLetter: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  createdAt?: string;
}

export type ApplicationStatus =
  | "draft"
  | "in_review"
  | "submitted"
  | "dry_run"
  | "skipped"
  | "needs_human"
  | "failed";

export interface ApplicationRecord {
  id?: number;
  jobId: string;
  status: ApplicationStatus;
  plan: PlanItem[];
  screenshotPath: string | null;
  submittedAt: string | null;
  notes: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EventRecord {
  id?: number;
  jobId: string | null;
  applicationId: number | null;
  kind: string;
  message: string;
  data: unknown;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Form model (application agent)
// ---------------------------------------------------------------------------

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "date"
  | "textarea"
  | "select"
  | "radio" // a group of radio buttons sharing a name; options carry labels
  | "checkbox" // a single yes/no checkbox
  | "checkbox_group" // several checkboxes under one question
  | "combobox" // autocomplete / react-select style widget
  | "file"
  | "unknown";

export interface FieldOption {
  /** Visible label of the option. */
  label: string;
  /** Underlying value (select value, radio value) when available. */
  value: string;
  /** data-ja-ref of the clickable element for radio/checkbox options. */
  ref?: string;
}

/** One input the extractor found on the page. */
export interface FormField {
  /** data-ja-ref attribute stamped onto the element so the filler can find it again. */
  ref: string;
  label: string;
  kind: FieldKind;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  autocomplete: string | null;
  required: boolean;
  options: FieldOption[];
  /** Nearest fieldset legend / heading text, useful for grouping (e.g. "Voluntary Self-Identification"). */
  section: string | null;
  /** Current value, if already populated. */
  value: string | null;
  /** Accepted file types for file inputs. */
  accept: string | null;
}

export type PlanAction = "fill" | "select" | "check" | "upload" | "skip" | "ask_human";

export type PlanSource = "heuristic" | "answers" | "model" | "human";

export interface PlanItem {
  ref: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  action: PlanAction;
  /** Text to type, option label to choose, "true"/"false" for checkboxes, or a profile document key for uploads. */
  value: string | null;
  /** For uploads: the resolved absolute path (from the profile only, never model-chosen). */
  filePath?: string;
  confidence: number; // 0-1
  source: PlanSource;
  rationale: string;
}

export interface FillResult {
  ref: string;
  ok: boolean;
  message?: string;
}
