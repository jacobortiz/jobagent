import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAshby } from "../src/discovery/ashby.js";
import { jobId } from "../src/discovery/common.js";
import { parseGreenhouse } from "../src/discovery/greenhouse.js";
import { parseLever } from "../src/discovery/lever.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf8"));

describe("greenhouse parser", () => {
  const jobs = parseGreenhouse("acme", "Acme", fixture("greenhouse.json"));

  it("normalizes core fields", () => {
    expect(jobs).toHaveLength(2);
    const j = jobs[0]!;
    expect(j.source).toBe("greenhouse");
    expect(j.sourceId).toBe("4001");
    expect(j.company).toBe("Acme");
    expect(j.title).toBe("Senior Backend Engineer");
    expect(j.location).toBe("Austin, Texas, United States");
    expect(j.department).toBe("Engineering");
    expect(j.employmentType).toBe("Full-time");
    expect(j.postedAt).toBe("2026-09-28T13:00:00.000Z");
  });

  it("decodes the double-escaped HTML content", () => {
    const j = jobs[0]!;
    expect(j.descriptionHtml).toContain("<strong>control plane</strong>");
    expect(j.descriptionHtml).toContain("&amp;");
    expect(j.descriptionText).toContain("We build & ship the control plane.");
    expect(j.descriptionText).toContain("• Go");
  });

  it("points applyUrl at the embedded form anchor", () => {
    expect(jobs[0]!.applyUrl).toBe("https://job-boards.greenhouse.io/acme/jobs/4001#app");
    expect(jobs[1]!.applyUrl).toBe("https://job-boards.greenhouse.io/acme/jobs/4002#app");
  });

  it("infers remote from the location", () => {
    expect(jobs[0]!.remote).toBeNull();
    expect(jobs[1]!.remote).toBe(true);
  });

  it("derives stable ids", () => {
    expect(jobs[0]!.id).toBe(jobId("greenhouse", "acme", "4001"));
    expect(jobs[0]!.id).toMatch(/^[0-9a-f]{10}$/);
    expect(jobId("greenhouse", "ACME", "4001")).toBe(jobs[0]!.id);
  });
});

describe("lever parser", () => {
  const jobs = parseLever("acme", "Acme", fixture("lever.json"));

  it("normalizes core fields", () => {
    const j = jobs[0]!;
    expect(j.title).toBe("Staff Software Engineer, Infrastructure");
    expect(j.location).toBe("San Francisco, CA");
    expect(j.department).toBe("Engineering / Infrastructure");
    expect(j.employmentType).toBe("Full-time");
    expect(j.remote).toBe(false);
    expect(j.postedAt).toBe("2025-10-01T00:00:00.000Z");
    expect(j.salaryText).toBe("USD 200000–250000 per-year-salary");
  });

  it("assembles description from description + lists + additional", () => {
    const t = jobs[0]!.descriptionText;
    expect(t).toContain("We are hiring.");
    expect(t).toContain("What you'll do");
    expect(t).toContain("• Build systems");
    expect(t).toContain("Pay range");
  });

  it("falls back to hostedUrl/apply when applyUrl is missing", () => {
    expect(jobs[1]!.applyUrl).toBe("https://jobs.lever.co/acme/7f1c2a3b-0000-4000-8000-000000000002/apply");
    expect(jobs[1]!.remote).toBe(true);
  });
});

describe("ashby parser", () => {
  const jobs = parseAshby("acme", "Acme", fixture("ashby.json"));

  it("skips unlisted postings", () => {
    expect(jobs).toHaveLength(1);
  });

  it("normalizes core fields", () => {
    const j = jobs[0]!;
    expect(j.title).toBe("Backend Engineer");
    expect(j.location).toBe("Remote / New York, NY");
    expect(j.remote).toBe(true);
    expect(j.department).toBe("Engineering / Core");
    expect(j.employmentType).toBe("FullTime");
    expect(j.salaryText).toBe("$180K - $220K");
    expect(j.applyUrl).toBe("https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555/application");
    expect(j.descriptionText).toContain("We make tools.");
  });
});
