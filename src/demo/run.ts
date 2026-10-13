/**
 * Offline end-to-end run: a throwaway workspace, a demo profile, a seeded job pointing at
 * the local form, a static evaluation, and a headless application with auto-submit.
 * No API key and no network needed. Used by `jobagent demo` and the e2e test.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { applyToJob, type ApplyOutcome } from "../apply/agent.js";
import { NoModelPlanner } from "../apply/planner.js";
import { AutoReviewer, renderPlan, type Reviewer } from "../apply/review.js";
import { loadAnswers, loadProfile, resolvePaths, type Paths } from "../config.js";
import { Tracker } from "../db.js";
import { prefilter } from "../discovery/prefilter.js";
import { StaticScorer } from "../scoring/scorer.js";
import type { Job } from "../types.js";
import { log } from "../util/log.js";
import { startDemoServer, writeTinyPdf, type DemoServer } from "./server.js";

export const DEMO_PROFILE = {
  candidate: {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane.doe@example.com",
    phone: "+1 512 555 0100",
    location: { city: "Austin", state: "TX", country: "United States", postal_code: "78701" },
    linkedin: "https://www.linkedin.com/in/janedoe",
    github: "https://github.com/janedoe",
    portfolio: "https://janedoe.dev",
    current_title: "Senior Software Engineer",
    current_company: "Example Corp",
    years_of_experience: 7,
  },
  documents: {
    resume_pdf: "resume.pdf",
    resume_text: "Jane Doe. Senior Software Engineer, 7 years building backend systems in Go and TypeScript.",
  },
  work_authorization: { authorized_countries: ["United States"], requires_sponsorship: false, willing_to_relocate: false },
  preferences: {
    titles_include: ["backend engineer", "software engineer"],
    locations: ["Remote", "Austin, TX"],
    remote: "preferred",
    min_fit_score: 70,
  },
  screening: {
    salary_expectation: "$170,000 base, flexible on total comp",
    start_date: "Two weeks after offer",
    how_did_you_hear: "Company website",
    eeo: { gender: "Decline to self-identify", race: "Decline to self-identify", veteran: "I don't wish to answer", disability: "I don't wish to answer" },
  },
  custom_answers: [
    {
      question: "Why do you want to work here?",
      answer: "I want to work on infrastructure that moves physical things. Acme's fleet control plane is exactly the kind of high-stakes backend problem I enjoy owning end to end.",
    },
  ],
};

export interface DemoWorkspace {
  root: string;
  paths: Paths;
  cleanup(): void;
}

export function createDemoWorkspace(root = fs.mkdtempSync(path.join(os.tmpdir(), "jobagent-demo-"))): DemoWorkspace {
  const paths = resolvePaths(root);
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.profile, YAML.stringify(DEMO_PROFILE), "utf8");
  fs.writeFileSync(paths.sources, YAML.stringify({ sources: [] }), "utf8");
  writeTinyPdf(path.join(paths.configDir, "resume.pdf"));
  return { root, paths, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function demoJob(server: DemoServer): Job {
  return {
    id: "demo000001",
    source: "greenhouse",
    sourceSlug: "acme",
    sourceId: "demo",
    company: "Acme Robotics",
    title: "Senior Backend Engineer",
    location: "Austin, TX or Remote (US)",
    remote: true,
    url: `${server.url}/jobs/demo`,
    applyUrl: server.applyUrl,
    descriptionHtml: "<p>We build the control plane for warehouse robots.</p>",
    descriptionText: "We build the control plane for warehouse robots. You will own ingestion pipelines and the APIs our fleet depends on.",
    postedAt: new Date().toISOString(),
    department: "Engineering",
    employmentType: "Full-time",
    salaryText: null,
  };
}

export interface DemoResult {
  outcome: ApplyOutcome;
  submission: Record<string, unknown> | null;
  workspace: DemoWorkspace;
}

export async function runDemo(opts: { headless?: boolean; reviewer?: Reviewer; keepWorkspace?: boolean; quiet?: boolean } = {}): Promise<DemoResult> {
  const workspace = createDemoWorkspace();
  const server = await startDemoServer();
  const tracker = new Tracker(workspace.paths.db);
  try {
    const profile = loadProfile(workspace.paths);
    const job = demoJob(server);
    tracker.upsertJob(job);
    const pf = prefilter(job, profile);
    tracker.setPrefilter(job.id, pf.pass, pf.reasons);
    const evaluation = await new StaticScorer(profile).score(job);
    tracker.insertEvaluation(evaluation);
    const stored = tracker.getJob(job.id);
    if (!stored) throw new Error("demo job not stored");

    if (!opts.quiet) log.info(`Demo form at ${server.applyUrl}`);
    const outcome = await applyToJob({
      tracker,
      paths: workspace.paths,
      profile,
      job: stored,
      evaluation,
      answers: loadAnswers(workspace.paths),
      reviewer: opts.reviewer ?? new AutoReviewer({ autoSubmit: true }),
      planner: new NoModelPlanner(),
      headless: opts.headless ?? true,
      dryRun: false,
    });
    if (!opts.quiet) {
      process.stdout.write("\n" + renderPlan(outcome.plan, outcome.fills) + "\n\n");
      log.info(`Application status: ${outcome.status}`);
      for (const n of outcome.notes) log.info(n);
    }
    return { outcome, submission: server.submissions.at(-1) ?? null, workspace };
  } finally {
    tracker.close();
    await server.close();
    if (!opts.keepWorkspace) workspace.cleanup();
  }
}
