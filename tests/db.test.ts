import { describe, expect, it } from "vitest";
import { normalizeTitle, Tracker } from "../src/db.js";
import type { Evaluation, Job } from "../src/types.js";

const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id,
  source: "greenhouse",
  sourceSlug: "acme",
  sourceId: id,
  company: "Acme",
  title: "Backend Engineer",
  location: "Remote",
  remote: true,
  url: `https://x/${id}`,
  applyUrl: `https://x/${id}#app`,
  descriptionText: "desc",
  descriptionHtml: "<p>desc</p>",
  postedAt: "2026-10-01T00:00:00.000Z",
  department: null,
  employmentType: null,
  salaryText: null,
  ...extra,
});

const evaluation = (jobId: string, fitScore: number): Evaluation => ({
  jobId,
  model: "test",
  fitScore,
  recommendation: fitScore >= 70 ? "apply" : "skip",
  summary: "s",
  reasons: ["r"],
  redFlags: [],
  missingRequirements: [],
  matchedRequirements: ["m"],
  seniorityMatch: "match",
  tailoredSummary: "t",
  coverLetter: "c",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
});

describe("Tracker", () => {
  it("upserts jobs and tracks prefilter status", () => {
    const t = new Tracker(":memory:");
    expect(t.upsertJob(job("a"))).toBe(true);
    expect(t.upsertJob(job("a", { title: "Backend Engineer II" }))).toBe(false);
    expect(t.getJob("a")?.title).toBe("Backend Engineer II");
    t.setPrefilter("a", false, ["too old"]);
    expect(t.getJob("a")).toMatchObject({ status: "filtered", prefilterPass: false, prefilterReasons: ["too old"] });
    t.setPrefilter("a", true, []);
    expect(t.getJob("a")?.status).toBe("ready");
    expect(t.countByStatus()).toEqual({ ready: 1 });
    t.close();
  });

  it("stores evaluations and surfaces the latest one in listings", () => {
    const t = new Tracker(":memory:");
    t.upsertJob(job("a"));
    t.upsertJob(job("b"));
    t.setPrefilter("a", true, []);
    t.setPrefilter("b", true, []);
    expect(t.jobsToScore().map((j) => j.id).sort()).toEqual(["a", "b"]);
    t.insertEvaluation(evaluation("a", 60));
    t.insertEvaluation(evaluation("a", 85));
    expect(t.jobsToScore().map((j) => j.id)).toEqual(["b"]);
    expect(t.latestEvaluation("a")?.fitScore).toBe(85);
    const rows = t.listJobs({ minScore: 70 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "a", status: "scored" });
    expect(rows[0]!.evaluation?.reasons).toEqual(["r"]);
    t.close();
  });

  it("supports prefix lookups when unambiguous", () => {
    const t = new Tracker(":memory:");
    t.upsertJob(job("abc123"));
    t.upsertJob(job("abd456"));
    expect(t.getJob("abc")?.id).toBe("abc123");
    expect(t.getJob("ab")).toBeNull();
    t.close();
  });

  it("flags duplicates by company + normalized title", () => {
    const t = new Tracker(":memory:");
    t.upsertJob(job("a", { title: "Backend Engineer (Remote)" }));
    t.upsertJob(job("b", { source: "lever", title: "Backend Engineer" }));
    const twin = t.findSimilarJob("acme", normalizeTitle("Backend Engineer"), "b");
    expect(twin?.id).toBe("a");
    t.markDuplicate("b", "a");
    expect(t.getJob("b")).toMatchObject({ status: "duplicate", duplicateOf: "a" });
    t.close();
  });

  it("records applications and marks the job applied on submit", () => {
    const t = new Tracker(":memory:");
    t.upsertJob(job("a"));
    const id = t.createApplication("a", "draft", []);
    t.updateApplication(id, { status: "in_review", plan: [{ ref: "f1", label: "Email", kind: "email", required: true, action: "fill", value: "x@y", confidence: 1, source: "heuristic", rationale: "" }] });
    expect(t.getApplication(id)?.plan[0]?.label).toBe("Email");
    t.updateApplication(id, { status: "submitted", submittedAt: "2026-10-13T00:00:00Z" });
    expect(t.getJob("a")?.status).toBe("applied");
    expect(t.listApplications("submitted")).toHaveLength(1);
    t.logEvent({ jobId: "a", applicationId: id, kind: "test", message: "hello", data: { k: 1 } });
    expect(t.eventsForJob("a")[0]).toMatchObject({ kind: "test", data: { k: 1 } });
    t.close();
  });
});
