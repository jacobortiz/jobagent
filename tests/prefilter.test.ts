import { describe, expect, it } from "vitest";
import { ProfileSchema } from "../src/config.js";
import { containsPhrase, prefilter } from "../src/discovery/prefilter.js";
import type { Job } from "../src/types.js";

const profile = ProfileSchema.parse({
  candidate: { first_name: "J", last_name: "D", email: "j@d.com", phone: "5555555", location: { city: "Austin", state: "TX" } },
  documents: { resume_pdf: "r.pdf", resume_text: "resume" },
  work_authorization: {},
  preferences: {
    titles_include: ["software engineer", "backend engineer"],
    titles_exclude: ["manager", "intern"],
    keywords_exclude: ["clearance required"],
    locations: ["Remote", "Austin, TX"],
    remote: "preferred",
    employment_types: ["full-time"],
    max_posting_age_days: 30,
  },
  blocked_companies: ["Evil Corp"],
});

const now = new Date("2026-10-13T00:00:00Z");

const base: Job = {
  id: "x",
  source: "greenhouse",
  sourceSlug: "acme",
  sourceId: "1",
  company: "Acme",
  title: "Senior Software Engineer",
  location: "Austin, Texas, United States",
  remote: null,
  url: "u",
  applyUrl: "a",
  descriptionText: "Build things with Go.",
  descriptionHtml: "",
  postedAt: "2026-10-10T00:00:00Z",
  department: null,
  employmentType: "Full-time",
  salaryText: null,
};

describe("containsPhrase", () => {
  it("matches whole words and simple plurals", () => {
    expect(containsPhrase("Senior Software Engineers wanted", "software engineer")).toBe(true);
    expect(containsPhrase("Software Engineering Manager", "manager")).toBe(true);
    expect(containsPhrase("Internal tools", "intern")).toBe(false);
  });
});

describe("prefilter", () => {
  it("passes a good match", () => {
    expect(prefilter(base, profile, now)).toEqual({ pass: true, reasons: [] });
  });

  it("rejects excluded titles even when an include matches", () => {
    const r = prefilter({ ...base, title: "Software Engineer Intern" }, profile, now);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toMatch(/title excluded/);
  });

  it("rejects titles outside the include list", () => {
    const r = prefilter({ ...base, title: "Product Designer" }, profile, now);
    expect(r.reasons).toContain("title does not match any titles_include entry");
  });

  it("rejects excluded keywords in the description", () => {
    const r = prefilter({ ...base, descriptionText: "TS/SCI clearance required." }, profile, now);
    expect(r.reasons.some((x) => x.includes("clearance required"))).toBe(true);
  });

  it("accepts remote jobs when Remote is a preferred location", () => {
    expect(prefilter({ ...base, location: "Remote - US", remote: true }, profile, now).pass).toBe(true);
    expect(prefilter({ ...base, location: "Anywhere", remote: true }, profile, now).pass).toBe(true);
  });

  it("rejects other cities", () => {
    const r = prefilter({ ...base, location: "Berlin, Germany" }, profile, now);
    expect(r.reasons.some((x) => x.startsWith("location"))).toBe(true);
  });

  it("enforces remote=required", () => {
    const strict = { ...profile, preferences: { ...profile.preferences, remote: "required" as const } };
    expect(prefilter({ ...base, remote: false }, strict, now).pass).toBe(false);
    expect(prefilter({ ...base, location: "Portland, OR", remote: true }, strict, now).pass).toBe(true);
  });

  it("rejects stale postings and keeps undated ones", () => {
    expect(prefilter({ ...base, postedAt: "2026-08-01T00:00:00Z" }, profile, now).pass).toBe(false);
    expect(prefilter({ ...base, postedAt: null }, profile, now).pass).toBe(true);
  });

  it("rejects blocked companies and wrong employment types", () => {
    expect(prefilter({ ...base, company: "evil corp" }, profile, now).reasons[0]).toMatch(/blocked/);
    expect(prefilter({ ...base, employmentType: "Contract" }, profile, now).pass).toBe(false);
    expect(prefilter({ ...base, employmentType: "FullTime" }, profile, now).pass).toBe(true);
  });
});
