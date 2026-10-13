/**
 * One application, end to end: open the form, extract fields, plan, fill, ask the human for
 * what the agent cannot answer, show the review gate, submit (or not), and record everything.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { LoadedProfile, Paths, SavedAnswer } from "../config.js";
import { saveAnswer } from "../config.js";
import type { Tracker } from "../db.js";
import type { ApplicationStatus, Evaluation, FillResult, FormField, JobRecord, PlanItem } from "../types.js";
import { log } from "../util/log.js";
import { launchBrowser, openPage } from "./browser.js";
import { detectCaptcha } from "./captcha.js";
import { collectValidationErrors, extractFields } from "./extract.js";
import { clickSubmit, executePlan, looksSubmitted } from "./fill.js";
import { buildPlan, type ModelPlanner, type PlannerContext } from "./planner.js";
import type { Reviewer } from "./review.js";

export interface ApplyOptions {
  tracker: Tracker;
  paths: Paths;
  profile: LoadedProfile;
  job: JobRecord;
  evaluation: Evaluation | null;
  answers: SavedAnswer[];
  reviewer: Reviewer;
  planner: ModelPlanner;
  headless: boolean;
  dryRun: boolean;
  /** Optional override of the page URL (used by the demo). */
  url?: string;
  /** Keep the browser open after finishing (useful when the human took over). */
  keepOpen?: boolean;
  slowMo?: number;
}

export interface ApplyOutcome {
  applicationId: number;
  status: ApplicationStatus;
  plan: PlanItem[];
  fills: FillResult[];
  screenshotPath: string | null;
  notes: string[];
}

const MAX_PASSES = 3;
const MAX_SUBMIT_ATTEMPTS = 3;

export async function applyToJob(opts: ApplyOptions): Promise<ApplyOutcome> {
  const { tracker, profile, job, reviewer, paths } = opts;
  const notes: string[] = [];
  const applicationId = tracker.createApplication(job.id, "draft");
  const event = (kind: string, message: string, data?: unknown) => tracker.logEvent({ jobId: job.id, applicationId, kind, message, data });

  const coverLetterFile = writeCoverLetterFile(paths, job, opts.evaluation);
  const ctx: PlannerContext = { profile, job, evaluation: opts.evaluation, answers: opts.answers, coverLetterFile };

  const context = await launchBrowser({ profileDir: paths.browserProfile, headless: opts.headless, slowMo: opts.slowMo });
  let status: ApplicationStatus = "draft";
  let plan: PlanItem[] = [];
  let fills: FillResult[] = [];
  let fields: FormField[] = [];
  let screenshotPath: string | null = null;

  const finish = async (final: ApplicationStatus, extra: Partial<{ submittedAt: string }> = {}) => {
    status = final;
    tracker.updateApplication(applicationId, { status: final, plan, screenshotPath, notes: notes.join("\n") || null, submittedAt: extra.submittedAt ?? null });
    event("application." + final, `${job.company}: ${job.title}`, { fills: fills.filter((f) => !f.ok) });
    if (!opts.keepOpen) await context.close().catch(() => undefined);
  };

  try {
    const url = opts.url ?? job.applyUrl;
    log.info(`Opening ${url}`);
    const page = await openPage(context, url);
    event("page.opened", url);

    if (!(await ensureHumanIfCaptcha(page, reviewer, notes))) {
      await finish("needs_human");
      return { applicationId, status, plan, fills, screenshotPath, notes };
    }

    await revealForm(page);

    // Pass loop: fill, then re-extract to catch conditionally revealed fields.
    const planned = new Set<string>();
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      fields = await extractFields(page);
      const fresh = fields.filter((f) => !planned.has(f.ref));
      if (fresh.length === 0) break;
      log.info(`Pass ${pass}: ${fresh.length} new field(s)`);
      const items = await buildPlan(fresh, ctx, opts.planner);
      for (const it of items) planned.add(it.ref);
      plan.push(...items);
      const results = await executePlan(page, items, fields);
      fills.push(...results);
      event("pass.filled", `pass ${pass}`, { planned: items.length, failed: results.filter((r) => !r.ok).length });
    }

    // Anything that failed to fill becomes a question for the human.
    for (const r of fills) {
      if (r.ok) continue;
      const item = plan.find((p) => p.ref === r.ref);
      if (item && item.action !== "ask_human") {
        item.action = "ask_human";
        item.rationale = `automatic fill failed: ${r.message ?? "unknown error"}`;
      }
    }

    // Human answers for ask_human items.
    const fieldByRef = new Map(fields.map((f) => [f.ref, f]));
    for (const item of plan.filter((p) => p.action === "ask_human")) {
      const field = fieldByRef.get(item.ref);
      const answer = await reviewer.askHuman(item, field);
      if (answer === null || answer === "") {
        if (item.required) notes.push(`required field left blank: ${item.label}`);
        continue;
      }
      item.value = answer;
      item.source = "human";
      item.action = field && (field.kind === "select" || field.kind === "radio" || field.kind === "combobox" || field.kind === "checkbox_group") ? "select" : field?.kind === "checkbox" ? "check" : "fill";
      const [res] = await executePlan(page, [item], fields);
      fills = fills.filter((f) => f.ref !== item.ref).concat(res ? [res] : []);
      if (res?.ok && field && field.kind !== "file") {
        saveAnswer(paths, { question: item.label, answer, company: undefined });
        event("answer.learned", item.label);
      }
    }

    fs.mkdirSync(paths.screenshots, { recursive: true });
    screenshotPath = path.join(paths.screenshots, `${job.id}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => (screenshotPath = null));

    if (opts.dryRun) {
      notes.push("dry run: not submitted");
      await finish("dry_run");
      return { applicationId, status, plan, fills, screenshotPath, notes };
    }

    // Review / submit loop.
    for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS; attempt++) {
      const warnings = buildWarnings(plan, fills, fields);
      const decision = await reviewer.review({ jobTitle: job.title, company: job.company, url: page.url(), plan, fills, fields, screenshotPath, warnings });

      if (decision.type === "abort") {
        notes.push("aborted by user; draft kept");
        await finish("draft");
        return { applicationId, status, plan, fills, screenshotPath, notes };
      }
      if (decision.type === "skip") {
        notes.push(`skipped${decision.reason ? `: ${decision.reason}` : ""}`);
        tracker.setJobStatus(job.id, "skipped");
        await finish("skipped");
        return { applicationId, status, plan, fills, screenshotPath, notes };
      }
      if (decision.type === "edit") {
        const item = plan.find((p) => p.ref === decision.ref);
        const field = fieldByRef.get(decision.ref);
        if (item && field) {
          item.value = decision.value;
          item.source = "human";
          item.action = field.options.length || field.kind === "combobox" ? "select" : field.kind === "checkbox" ? "check" : "fill";
          const [res] = await executePlan(page, [item], fields);
          fills = fills.filter((f) => f.ref !== item.ref).concat(res ? [res] : []);
        }
        attempt--; // editing does not consume a submit attempt
        continue;
      }
      if (decision.type === "takeover") {
        await reviewer.waitForHuman("The browser is yours. Fix or submit the form, then come back here.");
        if (await looksSubmitted(page)) {
          notes.push("submitted by human during takeover");
          await finish("submitted", { submittedAt: new Date().toISOString() });
          return { applicationId, status, plan, fills, screenshotPath, notes };
        }
        attempt--;
        continue;
      }

      // submit
      if (!(await ensureHumanIfCaptcha(page, reviewer, notes))) {
        await finish("needs_human");
        return { applicationId, status, plan, fills, screenshotPath, notes };
      }
      const clicked = await clickSubmit(page);
      if (!clicked) {
        notes.push("could not find a submit button");
        await reviewer.waitForHuman("No submit button found. Please submit in the browser.").catch(() => undefined);
      }
      await page.waitForTimeout(1500);
      if (await looksSubmitted(page)) {
        log.success("Application submitted");
        await page.screenshot({ path: screenshotPath?.replace(/\.png$/, "-confirmation.png") ?? path.join(paths.screenshots, `${job.id}-confirmation.png`), fullPage: true }).catch(() => undefined);
        await finish("submitted", { submittedAt: new Date().toISOString() });
        return { applicationId, status, plan, fills, screenshotPath, notes };
      }
      const errors = await collectValidationErrors(page);
      if (errors.length) {
        notes.push(`validation errors after submit: ${errors.join(" | ")}`);
        log.warn(`Form reported errors: ${errors.join(" | ")}`);
        // New fields may have appeared (e.g. error-revealed inputs); refresh the model of the page.
        fields = await extractFields(page);
        for (const f of fields) fieldByRef.set(f.ref, f);
      } else {
        notes.push("no confirmation detected after submit");
        log.warn("Could not confirm submission; check the browser.");
      }
    }
    await finish("needs_human");
    return { applicationId, status, plan, fills, screenshotPath, notes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notes.push(`error: ${message}`);
    log.error(message);
    await finish("failed");
    return { applicationId, status, plan, fills, screenshotPath, notes };
  }
}

/** Returns false when a CAPTCHA is present and the reviewer cannot hand off to a human. */
async function ensureHumanIfCaptcha(page: Page, reviewer: Reviewer, notes: string[]): Promise<boolean> {
  const check = await detectCaptcha(page);
  if (!check.present) return true;
  notes.push(`bot check detected (${check.kind})`);
  try {
    await reviewer.waitForHuman(`A ${check.kind} challenge is on the page. Please complete it in the browser.`);
    return true;
  } catch (err) {
    notes.push(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Some postings hide the form behind an "Apply" button; click it when the page has no inputs yet. */
async function revealForm(page: Page): Promise<void> {
  const inputs = await page.locator("input:visible, textarea:visible, select:visible").count();
  if (inputs >= 3) return;
  const apply = page.getByRole("button", { name: /^apply( now| for this job| to this job)?$/i }).or(page.getByRole("link", { name: /^apply( now| for this job| to this job)?$/i }));
  if ((await apply.count()) > 0) {
    await apply.first().click().catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

function buildWarnings(plan: PlanItem[], fills: FillResult[], fields: FormField[]): string[] {
  const warnings: string[] = [];
  const failed = fills.filter((f) => !f.ok);
  for (const f of failed) {
    const item = plan.find((p) => p.ref === f.ref);
    warnings.push(`could not fill "${item?.label ?? f.ref}": ${f.message ?? "unknown"}`);
  }
  for (const item of plan) {
    if (item.required && (item.action === "ask_human" || item.action === "skip" || !item.value) && !fields.find((f) => f.ref === item.ref)?.value) {
      warnings.push(`required field "${item.label}" is empty`);
    }
  }
  const lowConfidence = plan.filter((p) => p.source === "model" && p.confidence < 0.75 && p.value);
  if (lowConfidence.length) warnings.push(`model answers worth a second look: ${lowConfidence.map((p) => p.label).join(", ")}`);
  return warnings;
}

function writeCoverLetterFile(paths: Paths, job: JobRecord, evaluation: Evaluation | null): string | undefined {
  if (!evaluation?.coverLetter) return undefined;
  const dir = path.join(paths.dataDir, "cover-letters");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${job.id}.txt`);
  fs.writeFileSync(file, evaluation.coverLetter, "utf8");
  return file;
}
