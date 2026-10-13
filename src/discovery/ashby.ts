/**
 * Ashby Job Posting API (public, no auth):
 *   GET https://api.ashbyhq.com/posting-api/job-board/{org}?includeCompensation=true
 */
import type { Job } from "../types.js";
import { htmlToText } from "../util/text.js";
import { fetchJson, inferRemote, jobId, toIso, type SourceAdapter } from "./common.js";

export interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  employmentType?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  publishedAt?: string;
  isListed?: boolean;
  isRemote?: boolean;
  descriptionHtml?: string;
  descriptionPlain?: string;
  jobUrl: string;
  applyUrl?: string;
  compensation?: {
    compensationTierSummary?: string;
    scrapeableCompensationSalarySummary?: string;
  };
}

export interface AshbyResponse {
  apiVersion?: string;
  jobs: AshbyJob[];
}

export function parseAshby(org: string, company: string, data: AshbyResponse): Job[] {
  return (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const locations = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean) as string[];
      const location = locations.join(" / ");
      const html = j.descriptionHtml ?? "";
      return {
        id: jobId("ashby", org, j.id),
        source: "ashby",
        sourceSlug: org,
        sourceId: j.id,
        company,
        title: j.title.trim(),
        location,
        remote: j.isRemote === true ? true : j.isRemote === false ? inferRemote(location, j.title) : inferRemote(location, j.title),
        url: j.jobUrl,
        applyUrl: j.applyUrl ?? `${j.jobUrl.replace(/\/$/, "")}/application`,
        descriptionHtml: html,
        descriptionText: html ? htmlToText(html) : (j.descriptionPlain ?? ""),
        postedAt: toIso(j.publishedAt),
        department: [j.department, j.team].filter(Boolean).join(" / ") || null,
        employmentType: j.employmentType ?? null,
        salaryText: j.compensation?.scrapeableCompensationSalarySummary ?? j.compensation?.compensationTierSummary ?? null,
      };
    });
}

export const ashby: SourceAdapter = {
  kind: "ashby",
  async fetchJobs(slug, company = slug) {
    const data = await fetchJson<AshbyResponse>(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
    );
    return parseAshby(slug, company, data);
  },
};
