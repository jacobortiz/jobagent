import { describe, expect, it } from "vitest";
import { ProfileSchema, type LoadedProfile } from "../src/config.js";
import { Tracker } from "../src/db.js";
import type { SourceAdapter } from "../src/discovery/common.js";
import { discover } from "../src/discovery/index.js";
import type { Job } from "../src/types.js";

const profile: LoadedProfile = {
  ...ProfileSchema.parse({
    candidate: { first_name: "J", last_name: "D", email: "j@d.com", phone: "5555555", location: { city: "Austin", state: "TX" } },
    documents: { resume_pdf: "r.pdf", resume_text: "r" },
    work_authorization: {},
    preferences: { titles_include: ["engineer"], titles_exclude: ["manager"], locations: ["Remote"], max_posting_age_days: 0 },
  }),
  resumePdfPath: "/r.pdf",
  resumeText: "r",
};

const mk = (id: string, title: string, source: Job["source"] = "greenhouse"): Job => ({
  id: `${source}-${id}`,
  source,
  sourceSlug: "acme",
  sourceId: id,
  company: "Acme",
  title,
  location: "Remote",
  remote: true,
  url: "u",
  applyUrl: "a",
  descriptionText: "",
  descriptionHtml: "",
  postedAt: null,
  department: null,
  employmentType: null,
  salaryText: null,
});

const adapter = (kind: Job["source"], jobs: Job[] | Error): SourceAdapter => ({
  kind,
  fetchJobs: async () => {
    if (jobs instanceof Error) throw jobs;
    return jobs;
  },
});

describe("discover", () => {
  it("stores, prefilters, dedupes across sources and isolates source failures", async () => {
    const t = new Tracker(":memory:");
    const adapters = {
      greenhouse: adapter("greenhouse", [mk("1", "Backend Engineer"), mk("2", "Engineering Manager")]),
      lever: adapter("lever", [mk("9", "Backend Engineer (Remote)", "lever")]),
      ashby: adapter("ashby", new Error("boom")),
    };
    const sources = [
      { type: "greenhouse" as const, slug: "acme", company: "Acme" },
      { type: "lever" as const, slug: "acme", company: "Acme" },
      { type: "ashby" as const, slug: "acme", company: "Acme" },
    ];
    const s = await discover(t, sources, profile, { adapters });
    expect(s).toMatchObject({ fetched: 3, inserted: 3, updated: 0, passed: 2, filtered: 1, duplicates: 1 });
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]!.error).toBe("boom");
    expect(t.getJob("greenhouse-1")?.status).toBe("ready");
    expect(t.getJob("greenhouse-2")?.status).toBe("filtered");
    expect(t.getJob("greenhouse-2")?.prefilterReasons).toContain('title excluded: "manager"');
    expect(t.getJob("lever-9")).toMatchObject({ status: "duplicate", duplicateOf: "greenhouse-1" });
    expect(t.jobsToScore().map((j) => j.id)).toEqual(["greenhouse-1"]);

    // Second run: nothing new, existing rows refreshed, statuses preserved.
    const again = await discover(t, sources, profile, { adapters });
    expect(again).toMatchObject({ inserted: 0, updated: 3, duplicates: 0 });
    expect(t.getJob("lever-9")?.status).toBe("duplicate");
    t.close();
  });

  it("re-applies preference changes to existing jobs", async () => {
    const t = new Tracker(":memory:");
    const adapters = { greenhouse: adapter("greenhouse", [mk("1", "Backend Engineer")]) };
    const sources = [{ type: "greenhouse" as const, slug: "acme" }];
    await discover(t, sources, profile, { adapters });
    expect(t.getJob("greenhouse-1")?.status).toBe("ready");
    const stricter = { ...profile, preferences: { ...profile.preferences, titles_exclude: ["backend"] } };
    await discover(t, sources, stricter, { adapters });
    expect(t.getJob("greenhouse-1")?.status).toBe("filtered");
    t.close();
  });
});
