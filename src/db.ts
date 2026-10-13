/**
 * SQLite tracker built on Node's built-in `node:sqlite` (no native build step).
 * Four tables: jobs, evaluations, applications, events.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApplicationRecord, ApplicationStatus, Evaluation, EventRecord, Job, JobRecord, JobStatus, PlanItem } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_slug TEXT NOT NULL,
  source_id TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  remote INTEGER,
  url TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  description_text TEXT NOT NULL DEFAULT '',
  description_html TEXT NOT NULL DEFAULT '',
  posted_at TEXT,
  department TEXT,
  employment_type TEXT,
  salary_text TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  prefilter_pass INTEGER,
  prefilter_reasons TEXT NOT NULL DEFAULT '[]',
  duplicate_of TEXT,
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source, source_slug, source_id)
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_company_title ON jobs(company, title);

CREATE TABLE IF NOT EXISTS evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  fit_score INTEGER NOT NULL,
  recommendation TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  reasons TEXT NOT NULL DEFAULT '[]',
  red_flags TEXT NOT NULL DEFAULT '[]',
  missing_requirements TEXT NOT NULL DEFAULT '[]',
  matched_requirements TEXT NOT NULL DEFAULT '[]',
  seniority_match TEXT NOT NULL DEFAULT 'match',
  tailored_summary TEXT NOT NULL DEFAULT '',
  cover_letter TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evaluations_job ON evaluations(job_id, created_at);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '[]',
  screenshot_path TEXT,
  submitted_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS applications_job ON applications(job_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  application_id INTEGER,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, created_at);
`;

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const parseJson = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export class Tracker {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------------ jobs

  /**
   * Insert a job or refresh mutable fields of an existing one.
   * Returns whether the job was newly inserted.
   */
  upsertJob(job: Job): boolean {
    const existing = this.db.prepare("SELECT id FROM jobs WHERE id = ?").get(job.id) as Row | undefined;
    const ts = now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE jobs SET title=?, location=?, remote=?, url=?, apply_url=?, description_text=?, description_html=?,
           posted_at=?, department=?, employment_type=?, salary_text=?, updated_at=? WHERE id=?`,
        )
        .run(
          job.title,
          job.location,
          boolToInt(job.remote),
          job.url,
          job.applyUrl,
          job.descriptionText,
          job.descriptionHtml,
          job.postedAt,
          job.department,
          job.employmentType,
          job.salaryText,
          ts,
          job.id,
        );
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO jobs (id, source, source_slug, source_id, company, title, location, remote, url, apply_url,
          description_text, description_html, posted_at, department, employment_type, salary_text, status,
          discovered_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?)`,
      )
      .run(
        job.id,
        job.source,
        job.sourceSlug,
        job.sourceId,
        job.company,
        job.title,
        job.location,
        boolToInt(job.remote),
        job.url,
        job.applyUrl,
        job.descriptionText,
        job.descriptionHtml,
        job.postedAt,
        job.department,
        job.employmentType,
        job.salaryText,
        ts,
        ts,
      );
    return true;
  }

  setPrefilter(jobId: string, pass: boolean, reasons: string[]): void {
    const status: JobStatus = pass ? "ready" : "filtered";
    this.db
      .prepare(
        `UPDATE jobs SET prefilter_pass=?, prefilter_reasons=?, status=CASE WHEN status IN ('new','filtered','ready') THEN ? ELSE status END, updated_at=? WHERE id=?`,
      )
      .run(pass ? 1 : 0, JSON.stringify(reasons), status, now(), jobId);
  }

  markDuplicate(jobId: string, ofJobId: string): void {
    this.db
      .prepare("UPDATE jobs SET status='duplicate', duplicate_of=?, updated_at=? WHERE id=? AND status IN ('new','ready','filtered')")
      .run(ofJobId, now(), jobId);
  }

  setJobStatus(jobId: string, status: JobStatus): void {
    this.db.prepare("UPDATE jobs SET status=?, updated_at=? WHERE id=?").run(status, now(), jobId);
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    if (row) return rowToJob(row);
    // Allow prefix lookups so short ids are convenient on the CLI.
    const rows = this.db.prepare("SELECT * FROM jobs WHERE id LIKE ? LIMIT 2").all(`${id}%`) as Row[];
    if (rows.length === 1 && rows[0]) return rowToJob(rows[0]);
    return null;
  }

  /** Find a non-duplicate job at the same company with the same normalized title. */
  findSimilarJob(company: string, normalizedTitle: string, excludeId: string): JobRecord | null {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE lower(company)=lower(?) AND id != ? AND status != 'duplicate'")
      .all(company, excludeId) as Row[];
    for (const row of rows) {
      if (normalizeTitle(String(row.title)) === normalizedTitle) return rowToJob(row);
    }
    return null;
  }

  listJobs(opts: { status?: JobStatus | JobStatus[]; minScore?: number; limit?: number; company?: string } = {}): Array<JobRecord & { evaluation: Evaluation | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`j.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (opts.company) {
      where.push("lower(j.company) LIKE lower(?)");
      params.push(`%${opts.company}%`);
    }
    if (opts.minScore !== undefined) {
      where.push("e.fit_score >= ?");
      params.push(opts.minScore);
    }
    const sql = `
      SELECT j.*, e.id AS e_id, e.model AS e_model, e.fit_score AS e_fit_score, e.recommendation AS e_recommendation,
             e.summary AS e_summary, e.reasons AS e_reasons, e.red_flags AS e_red_flags,
             e.missing_requirements AS e_missing, e.matched_requirements AS e_matched, e.seniority_match AS e_seniority,
             e.tailored_summary AS e_tailored, e.cover_letter AS e_cover, e.input_tokens AS e_in, e.output_tokens AS e_out,
             e.cache_read_tokens AS e_cache, e.created_at AS e_created
      FROM jobs j
      LEFT JOIN evaluations e ON e.id = (SELECT id FROM evaluations WHERE job_id = j.id ORDER BY created_at DESC, id DESC LIMIT 1)
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY COALESCE(e.fit_score, -1) DESC, j.discovered_at DESC
      ${opts.limit ? "LIMIT " + Number(opts.limit) : ""}`;
    const rows = this.db.prepare(sql).all(...(params as never[])) as Row[];
    return rows.map((row) => ({ ...rowToJob(row), evaluation: row.e_id ? joinedEvaluation(row) : null }));
  }

  /** Jobs that passed the prefilter and have no evaluation yet. */
  jobsToScore(limit?: number): JobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j WHERE j.status='ready' AND NOT EXISTS (SELECT 1 FROM evaluations e WHERE e.job_id=j.id)
         ORDER BY j.posted_at DESC NULLS LAST, j.discovered_at DESC ${limit ? "LIMIT " + Number(limit) : ""}`,
      )
      .all() as Row[];
    return rows.map(rowToJob);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all() as Row[];
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.status)] = Number(r.n);
    return out;
  }

  // ----------------------------------------------------------- evaluations

  insertEvaluation(ev: Evaluation): number {
    const res = this.db
      .prepare(
        `INSERT INTO evaluations (job_id, model, fit_score, recommendation, summary, reasons, red_flags, missing_requirements,
          matched_requirements, seniority_match, tailored_summary, cover_letter, input_tokens, output_tokens, cache_read_tokens, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ev.jobId,
        ev.model,
        Math.round(ev.fitScore),
        ev.recommendation,
        ev.summary,
        JSON.stringify(ev.reasons),
        JSON.stringify(ev.redFlags),
        JSON.stringify(ev.missingRequirements),
        JSON.stringify(ev.matchedRequirements),
        ev.seniorityMatch,
        ev.tailoredSummary,
        ev.coverLetter,
        ev.inputTokens,
        ev.outputTokens,
        ev.cacheReadTokens,
        now(),
      );
    this.db.prepare("UPDATE jobs SET status='scored', updated_at=? WHERE id=? AND status IN ('ready','new')").run(now(), ev.jobId);
    return Number(res.lastInsertRowid);
  }

  latestEvaluation(jobId: string): Evaluation | null {
    const row = this.db
      .prepare("SELECT * FROM evaluations WHERE job_id=? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(jobId) as Row | undefined;
    return row ? rowToEvaluation(row) : null;
  }

  // ---------------------------------------------------------- applications

  createApplication(jobId: string, status: ApplicationStatus, plan: PlanItem[] = []): number {
    const ts = now();
    const res = this.db
      .prepare("INSERT INTO applications (job_id, status, plan, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(jobId, status, JSON.stringify(plan), ts, ts);
    return Number(res.lastInsertRowid);
  }

  updateApplication(
    id: number,
    patch: Partial<Pick<ApplicationRecord, "status" | "plan" | "screenshotPath" | "submittedAt" | "notes">>,
  ): void {
    const current = this.getApplication(id);
    if (!current) throw new Error(`No application ${id}`);
    const next = { ...current, ...patch };
    this.db
      .prepare("UPDATE applications SET status=?, plan=?, screenshot_path=?, submitted_at=?, notes=?, updated_at=? WHERE id=?")
      .run(next.status, JSON.stringify(next.plan), next.screenshotPath, next.submittedAt, next.notes, now(), id);
    if (next.status === "submitted") this.setJobStatus(current.jobId, "applied");
  }

  getApplication(id: number): ApplicationRecord | null {
    const row = this.db.prepare("SELECT * FROM applications WHERE id=?").get(id) as Row | undefined;
    return row ? rowToApplication(row) : null;
  }

  applicationsForJob(jobId: string): ApplicationRecord[] {
    const rows = this.db.prepare("SELECT * FROM applications WHERE job_id=? ORDER BY created_at DESC").all(jobId) as Row[];
    return rows.map(rowToApplication);
  }

  listApplications(status?: ApplicationStatus): Array<ApplicationRecord & { company: string; title: string }> {
    const rows = this.db
      .prepare(
        `SELECT a.*, j.company, j.title FROM applications a JOIN jobs j ON j.id=a.job_id
         ${status ? "WHERE a.status=?" : ""} ORDER BY a.created_at DESC`,
      )
      .all(...((status ? [status] : []) as never[])) as Row[];
    return rows.map((r) => ({ ...rowToApplication(r), company: String(r.company), title: String(r.title) }));
  }

  // ---------------------------------------------------------------- events

  logEvent(ev: Omit<EventRecord, "id" | "createdAt">): void {
    this.db
      .prepare("INSERT INTO events (job_id, application_id, kind, message, data, created_at) VALUES (?,?,?,?,?,?)")
      .run(ev.jobId, ev.applicationId, ev.kind, ev.message, ev.data === undefined ? null : JSON.stringify(ev.data), now());
  }

  eventsForJob(jobId: string): EventRecord[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE job_id=? ORDER BY created_at ASC").all(jobId) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      jobId: r.job_id as string | null,
      applicationId: r.application_id as number | null,
      kind: String(r.kind),
      message: String(r.message),
      data: parseJson(r.data, null),
      createdAt: String(r.created_at),
    }));
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function boolToInt(b: boolean | null): number | null {
  return b === null ? null : b ? 1 : 0;
}

function intToBool(n: unknown): boolean | null {
  return n === null || n === undefined ? null : Number(n) === 1;
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowToJob(row: Row): JobRecord {
  return {
    id: String(row.id),
    source: row.source as JobRecord["source"],
    sourceSlug: String(row.source_slug),
    sourceId: String(row.source_id),
    company: String(row.company),
    title: String(row.title),
    location: String(row.location ?? ""),
    remote: intToBool(row.remote),
    url: String(row.url),
    applyUrl: String(row.apply_url),
    descriptionText: String(row.description_text ?? ""),
    descriptionHtml: String(row.description_html ?? ""),
    postedAt: (row.posted_at as string | null) ?? null,
    department: (row.department as string | null) ?? null,
    employmentType: (row.employment_type as string | null) ?? null,
    salaryText: (row.salary_text as string | null) ?? null,
    status: row.status as JobStatus,
    prefilterPass: intToBool(row.prefilter_pass),
    prefilterReasons: parseJson<string[]>(row.prefilter_reasons, []),
    duplicateOf: (row.duplicate_of as string | null) ?? null,
    discoveredAt: String(row.discovered_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToEvaluation(row: Row): Evaluation {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    model: String(row.model),
    fitScore: Number(row.fit_score),
    recommendation: row.recommendation as Evaluation["recommendation"],
    summary: String(row.summary ?? ""),
    reasons: parseJson<string[]>(row.reasons, []),
    redFlags: parseJson<string[]>(row.red_flags, []),
    missingRequirements: parseJson<string[]>(row.missing_requirements, []),
    matchedRequirements: parseJson<string[]>(row.matched_requirements, []),
    seniorityMatch: row.seniority_match as Evaluation["seniorityMatch"],
    tailoredSummary: String(row.tailored_summary ?? ""),
    coverLetter: String(row.cover_letter ?? ""),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    createdAt: String(row.created_at),
  };
}

function joinedEvaluation(row: Row): Evaluation {
  return rowToEvaluation({
    id: row.e_id,
    job_id: row.id,
    model: row.e_model,
    fit_score: row.e_fit_score,
    recommendation: row.e_recommendation,
    summary: row.e_summary,
    reasons: row.e_reasons,
    red_flags: row.e_red_flags,
    missing_requirements: row.e_missing,
    matched_requirements: row.e_matched,
    seniority_match: row.e_seniority,
    tailored_summary: row.e_tailored,
    cover_letter: row.e_cover,
    input_tokens: row.e_in,
    output_tokens: row.e_out,
    cache_read_tokens: row.e_cache,
    created_at: row.e_created,
  });
}

function rowToApplication(row: Row): ApplicationRecord {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    status: row.status as ApplicationStatus,
    plan: parseJson<PlanItem[]>(row.plan, []),
    screenshotPath: (row.screenshot_path as string | null) ?? null,
    submittedAt: (row.submitted_at as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
