#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { applyToJob } from "./apply/agent.js";
import { ClaudePlanner, NoModelPlanner, type ModelPlanner } from "./apply/planner.js";
import { AutoReviewer, renderPlan, TerminalReviewer, type Reviewer } from "./apply/review.js";
import { loadAnswers, loadProfile, loadSources, resolvePaths, type LoadedProfile, type Paths } from "./config.js";
import { Tracker } from "./db.js";
import { discover } from "./discovery/index.js";
import { runDemo } from "./demo/run.js";
import { ClaudeScorer, createAnthropicClient, ScoringRefusedError, StaticScorer, type Scorer } from "./scoring/scorer.js";
import type { Evaluation, JobRecord, JobStatus, SourceKind } from "./types.js";
import { mapLimit } from "./util/async.js";
import { color, log, setLogLevel, table } from "./util/log.js";
import { truncate } from "./util/text.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const program = new Command();

program
  .name("jobagent")
  .description("Discover jobs, score them with Claude, tailor materials, fill ATS forms, and track outcomes. Humans approve every submission.")
  .version("0.1.0")
  .option("-C, --home <dir>", "project directory containing config/ and data/ (default: cwd or $JOBAGENT_HOME)")
  .option("-v, --verbose", "debug logging")
  .hook("preAction", (cmd) => {
    const o = cmd.opts<{ verbose?: boolean; home?: string }>();
    if (o.verbose) setLogLevel("debug");
    if (o.home) process.env.JOBAGENT_HOME = path.resolve(o.home);
  });

function ctx(): { paths: Paths; tracker: Tracker } {
  const paths = resolvePaths();
  return { paths, tracker: new Tracker(paths.db) };
}

function withProfile(paths: Paths): LoadedProfile {
  return loadProfile(paths);
}

function makeScorer(profile: LoadedProfile, offline: boolean): Scorer {
  return offline ? new StaticScorer(profile) : new ClaudeScorer(createAnthropicClient(), profile);
}

function makePlanner(noLlm: boolean): ModelPlanner {
  return noLlm ? new NoModelPlanner() : new ClaudePlanner(createAnthropicClient());
}

function scoreLabel(e: Evaluation | null): string {
  if (!e) return color.dim("—");
  const s = String(e.fitScore).padStart(3);
  return e.fitScore >= 80 ? color.green(s) : e.fitScore >= 60 ? color.yellow(s) : color.dim(s);
}

// ------------------------------------------------------------------ init

program
  .command("init")
  .description("Create config/ with example profile and sources, and the data/ directory")
  .action(() => {
    const paths = resolvePaths();
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    // src/cli.ts -> ../config ; dist/src/cli.js -> ../../config
    const examples = [path.resolve(here, "..", "config"), path.resolve(here, "..", "..", "config")].find((d) => fs.existsSync(path.join(d, "profile.example.yaml")));
    if (!examples) throw new Error("Could not locate the bundled config examples");
    const copy = (name: string, target: string) => {
      if (fs.existsSync(target)) {
        log.info(`${path.relative(paths.root, target)} already exists, leaving it alone`);
        return;
      }
      fs.copyFileSync(path.join(examples, name), target);
      log.success(`wrote ${path.relative(paths.root, target)}`);
    };
    copy("profile.example.yaml", paths.profile);
    copy("sources.example.yaml", paths.sources);
    new Tracker(paths.db).close();
    log.success(`database at ${path.relative(paths.root, paths.db)}`);
    log.info("Next: edit config/profile.yaml and config/sources.yaml, then run `jobagent discover`.");
  });

// -------------------------------------------------------------- discover

program
  .command("discover")
  .description("Fetch postings from every configured board, store them, and run the prefilter")
  .option("--source <type>", "only one source type: greenhouse | lever | ashby")
  .action(async (o: { source?: SourceKind }) => {
    const { paths, tracker } = ctx();
    try {
      const profile = withProfile(paths);
      const sources = loadSources(paths);
      if (!sources.length) {
        log.warn("No sources configured in config/sources.yaml");
        return;
      }
      const s = await discover(tracker, sources, profile, { only: o.source });
      log.success(`fetched ${s.fetched} · new ${s.inserted} · updated ${s.updated} · passed prefilter ${s.passed} · filtered ${s.filtered} · duplicates ${s.duplicates}`);
      if (s.errors.length) log.warn(`${s.errors.length} source(s) failed`);
      const counts = tracker.countByStatus();
      log.info("totals by status: " + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "));
    } finally {
      tracker.close();
    }
  });

// ------------------------------------------------------------------ score

program
  .command("score")
  .description("Evaluate unscored jobs that passed the prefilter with Claude")
  .option("-n, --limit <n>", "maximum jobs to score this run", "25")
  .option("--job <id>", "score (or re-score) one job")
  .option("--offline", "use the placeholder scorer (no API calls)")
  .action(async (o: { limit: string; job?: string; offline?: boolean }) => {
    const { paths, tracker } = ctx();
    try {
      const profile = withProfile(paths);
      const scorer = makeScorer(profile, !!o.offline);
      let jobs: JobRecord[];
      if (o.job) {
        const j = tracker.getJob(o.job);
        if (!j) throw new Error(`No job ${o.job}`);
        jobs = [j];
      } else {
        jobs = tracker.jobsToScore(Number(o.limit));
      }
      if (!jobs.length) {
        log.info("Nothing to score. Run `jobagent discover` first.");
        return;
      }
      log.info(`Scoring ${jobs.length} job(s) with ${scorer instanceof ClaudeScorer ? scorer.model : "static scorer"}…`);
      let tokens = { input: 0, output: 0, cached: 0 };
      await mapLimit(jobs, profile.model.concurrency, async (job) => {
        try {
          const ev = await scorer.score(job);
          tracker.insertEvaluation(ev);
          tokens = { input: tokens.input + ev.inputTokens, output: tokens.output + ev.outputTokens, cached: tokens.cached + ev.cacheReadTokens };
          log.info(`${scoreLabel(ev)} ${ev.recommendation.padEnd(5)} ${job.id} ${truncate(job.company, 18).padEnd(18)} ${truncate(job.title, 50)}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof ScoringRefusedError) tracker.setJobStatus(job.id, "skipped");
          tracker.logEvent({ jobId: job.id, applicationId: null, kind: "score.error", message, data: null });
          log.warn(`${job.id} ${truncate(job.title, 40)}: ${message}`);
        }
      });
      if (tokens.input + tokens.output > 0) log.info(`tokens: in ${tokens.input} (cached ${tokens.cached}) · out ${tokens.output}`);
    } finally {
      tracker.close();
    }
  });

// ------------------------------------------------------------- list/show

program
  .command("list")
  .description("List tracked jobs with their latest score")
  .option("-s, --status <status...>", "filter by status (new filtered ready scored applied skipped duplicate)")
  .option("--min-score <n>", "only jobs scoring at least n")
  .option("--company <name>", "filter by company substring")
  .option("-n, --limit <n>", "max rows", "50")
  .action((o: { status?: JobStatus[]; minScore?: string; company?: string; limit: string }) => {
    const { tracker } = ctx();
    try {
      const rows = tracker.listJobs({
        status: o.status,
        minScore: o.minScore !== undefined ? Number(o.minScore) : undefined,
        company: o.company,
        limit: Number(o.limit),
      });
      if (!rows.length) {
        log.info("No jobs match.");
        return;
      }
      process.stdout.write(
        table(
          rows.map((r) => [r.id, scoreLabel(r.evaluation), r.evaluation?.recommendation ?? "", r.status, truncate(r.company, 20), truncate(r.title, 48), truncate(r.location || (r.remote ? "Remote" : ""), 24), r.postedAt?.slice(0, 10) ?? ""]),
          ["id", "fit", "rec", "status", "company", "title", "location", "posted"],
        ) + "\n",
      );
    } finally {
      tracker.close();
    }
  });

program
  .command("queue")
  .description("Jobs recommended to apply to (score ≥ min_fit_score) that have not been applied to yet")
  .action(() => {
    const { paths, tracker } = ctx();
    try {
      const profile = withProfile(paths);
      const rows = tracker.listJobs({ status: "scored", minScore: profile.preferences.min_fit_score });
      const queue = rows.filter((r) => r.evaluation?.recommendation !== "skip");
      if (!queue.length) {
        log.info("Queue is empty.");
        return;
      }
      process.stdout.write(table(queue.map((r) => [r.id, scoreLabel(r.evaluation), truncate(r.company, 20), truncate(r.title, 50), truncate(r.evaluation?.summary ?? "", 70)]), ["id", "fit", "company", "title", "summary"]) + "\n");
      log.info(`Apply with: jobagent apply <id>`);
    } finally {
      tracker.close();
    }
  });

program
  .command("show <id>")
  .description("Show a job, its evaluation, cover letter, applications and events")
  .option("--cover-letter", "print only the cover letter")
  .action((id: string, o: { coverLetter?: boolean }) => {
    const { tracker } = ctx();
    try {
      const job = tracker.getJob(id);
      if (!job) throw new Error(`No job ${id}`);
      const ev = tracker.latestEvaluation(job.id);
      if (o.coverLetter) {
        process.stdout.write((ev?.coverLetter ?? "(no evaluation yet)") + "\n");
        return;
      }
      const out: string[] = [];
      out.push(color.bold(`${job.title} @ ${job.company}`) + `  ${color.dim(job.id)}`);
      out.push(`${job.location || "location n/a"}${job.remote ? " · remote" : ""}${job.salaryText ? " · " + job.salaryText : ""}${job.postedAt ? " · posted " + job.postedAt.slice(0, 10) : ""}`);
      out.push(`status: ${job.status}  source: ${job.source}/${job.sourceSlug}`);
      out.push(`url: ${job.url}`);
      if (job.prefilterReasons.length) out.push(color.yellow(`prefilter: ${job.prefilterReasons.join("; ")}`));
      if (ev) {
        out.push("");
        out.push(color.bold(`Fit ${ev.fitScore}/100 · ${ev.recommendation} · seniority ${ev.seniorityMatch}`) + color.dim(`  (${ev.model})`));
        out.push(ev.summary);
        if (ev.reasons.length) out.push(color.green("+ ") + ev.reasons.join("\n" + color.green("+ ")));
        if (ev.missingRequirements.length) out.push(color.yellow("- ") + ev.missingRequirements.join("\n" + color.yellow("- ")));
        if (ev.redFlags.length) out.push(color.red("! ") + ev.redFlags.join("\n" + color.red("! ")));
        out.push("");
        out.push(color.bold("Tailored summary"));
        out.push(ev.tailoredSummary);
        out.push("");
        out.push(color.bold("Cover letter"));
        out.push(ev.coverLetter);
      } else {
        out.push(color.dim("\nNot scored yet. Run `jobagent score --job " + job.id + "`."));
      }
      const apps = tracker.applicationsForJob(job.id);
      if (apps.length) {
        out.push("");
        out.push(color.bold("Applications"));
        for (const a of apps) out.push(`#${a.id} ${a.status}${a.submittedAt ? " at " + a.submittedAt : ""}${a.screenshotPath ? " · " + a.screenshotPath : ""}${a.notes ? "\n   " + a.notes.replace(/\n/g, "\n   ") : ""}`);
      }
      const events = tracker.eventsForJob(job.id);
      if (events.length) {
        out.push("");
        out.push(color.bold("Events"));
        for (const e of events) out.push(color.dim(`${e.createdAt?.slice(0, 19)} ${e.kind}`) + ` ${e.message}`);
      }
      out.push("");
      out.push(color.bold("Description"));
      out.push(truncate(job.descriptionText, 3000));
      process.stdout.write(out.join("\n") + "\n");
    } finally {
      tracker.close();
    }
  });

// ------------------------------------------------------------------ apply

program
  .command("apply <id>")
  .description("Open the application form, fill it, and review before submitting")
  .option("--dry-run", "fill the form and take a screenshot, never submit")
  .option("--auto-submit", "submit without the interactive review when nothing needs a human")
  .option("--headless", "run the browser headless (default: visible so you can take over)")
  .option("--no-llm", "heuristics only; unresolved fields are asked of you instead of Claude")
  .option("--url <url>", "override the application URL")
  .action(async (id: string, o: { dryRun?: boolean; autoSubmit?: boolean; headless?: boolean; llm: boolean; url?: string }) => {
    const { paths, tracker } = ctx();
    let terminal: TerminalReviewer | null = null;
    try {
      const profile = withProfile(paths);
      const job = tracker.getJob(id);
      if (!job) throw new Error(`No job ${id}`);
      let evaluation = tracker.latestEvaluation(job.id);
      if (!evaluation && o.llm) {
        log.info("No evaluation yet; scoring first so the cover letter is tailored…");
        evaluation = await makeScorer(profile, false).score(job);
        tracker.insertEvaluation(evaluation);
      }
      if (evaluation && evaluation.recommendation === "skip") log.warn(`Claude recommended skipping this one (fit ${evaluation.fitScore}). Proceeding because you asked.`);
      const interactive = !o.autoSubmit && process.stdin.isTTY;
      const reviewer: Reviewer = interactive ? (terminal = new TerminalReviewer()) : new AutoReviewer({ autoSubmit: !!o.autoSubmit });
      const outcome = await applyToJob({
        tracker,
        paths,
        profile,
        job,
        evaluation,
        answers: loadAnswers(paths),
        reviewer,
        planner: makePlanner(!o.llm),
        headless: !!o.headless,
        dryRun: !!o.dryRun,
        url: o.url,
      });
      process.stdout.write("\n" + renderPlan(outcome.plan, outcome.fills) + "\n\n");
      log.info(`application #${outcome.applicationId}: ${outcome.status}`);
      for (const n of outcome.notes) log.info(n);
      if (outcome.screenshotPath) log.info(`screenshot: ${outcome.screenshotPath}`);
    } finally {
      terminal?.close();
      tracker.close();
    }
  });

program
  .command("applications")
  .description("List applications and their status")
  .action(() => {
    const { tracker } = ctx();
    try {
      const rows = tracker.listApplications();
      if (!rows.length) {
        log.info("No applications yet.");
        return;
      }
      process.stdout.write(table(rows.map((a) => [String(a.id), a.status, a.jobId, truncate(a.company, 20), truncate(a.title, 45), a.submittedAt?.slice(0, 16) ?? a.updatedAt?.slice(0, 16) ?? ""]), ["#", "status", "job", "company", "title", "when"]) + "\n");
    } finally {
      tracker.close();
    }
  });

// -------------------------------------------------------------------- run

program
  .command("run")
  .description("Daily routine: discover, score new matches, and print the queue (schedule this with cron)")
  .option("-n, --limit <n>", "max jobs to score", "25")
  .option("--apply", "after scoring, walk the queue interactively")
  .option("--offline", "placeholder scorer, no API calls")
  .action(async (o: { limit: string; apply?: boolean; offline?: boolean }) => {
    const { paths, tracker } = ctx();
    let terminal: TerminalReviewer | null = null;
    try {
      const profile = withProfile(paths);
      const sources = loadSources(paths);
      const s = await discover(tracker, sources, profile);
      log.success(`discover: ${s.inserted} new, ${s.passed} pass prefilter`);
      const scorer = makeScorer(profile, !!o.offline);
      const jobs = tracker.jobsToScore(Number(o.limit));
      log.info(`scoring ${jobs.length} job(s)…`);
      await mapLimit(jobs, profile.model.concurrency, async (job) => {
        try {
          const ev = await scorer.score(job);
          tracker.insertEvaluation(ev);
          log.info(`${scoreLabel(ev)} ${job.id} ${truncate(job.company, 18).padEnd(18)} ${truncate(job.title, 50)}`);
        } catch (err) {
          log.warn(`${job.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      const queue = tracker.listJobs({ status: "scored", minScore: profile.preferences.min_fit_score }).filter((r) => r.evaluation?.recommendation !== "skip");
      log.success(`${queue.length} job(s) in the apply queue`);
      if (queue.length) process.stdout.write(table(queue.map((r) => [r.id, scoreLabel(r.evaluation), truncate(r.company, 20), truncate(r.title, 50)]), ["id", "fit", "company", "title"]) + "\n");
      if (o.apply && queue.length) {
        if (!process.stdin.isTTY) throw new Error("--apply needs an interactive terminal");
        terminal = new TerminalReviewer();
        for (const r of queue) {
          log.info(`\n→ ${r.title} @ ${r.company} (fit ${r.evaluation?.fitScore})`);
          const outcome = await applyToJob({ tracker, paths, profile, job: r, evaluation: r.evaluation, answers: loadAnswers(paths), reviewer: terminal, planner: makePlanner(!!o.offline), headless: false, dryRun: false });
          log.info(`application #${outcome.applicationId}: ${outcome.status}`);
          if (outcome.status === "draft") break; // user quit
        }
      }
    } finally {
      terminal?.close();
      tracker.close();
    }
  });

// ------------------------------------------------------------------- demo

program
  .command("demo")
  .description("Offline end-to-end run against a local test form (no API key, no network)")
  .option("--headed", "show the browser")
  .action(async (o: { headed?: boolean }) => {
    const result = await runDemo({ headless: !o.headed });
    if (result.submission) {
      log.success("The demo form received:");
      process.stdout.write(table(Object.entries(result.submission).map(([k, v]) => [k, truncate(String(v ?? ""), 80)]), ["field", "value"]) + "\n");
    } else {
      log.warn("The form was not submitted.");
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  if (process.env.JOBAGENT_LOG === "debug" && err instanceof Error) console.error(err.stack);
  process.exitCode = 1;
});
