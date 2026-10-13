/**
 * Lever Postings API (public, no auth):
 *   GET https://api.lever.co/v0/postings/{site}?mode=json
 */
import type { Job } from "../types.js";
import { htmlToText } from "../util/text.js";
import { fetchJson, inferRemote, jobId, toIso, type SourceAdapter } from "./common.js";

export interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  workplaceType?: "remote" | "hybrid" | "onsite" | "unspecified" | string;
  categories?: { commitment?: string; department?: string; location?: string; team?: string; allLocations?: string[] };
  description?: string;
  descriptionPlain?: string;
  additional?: string;
  additionalPlain?: string;
  lists?: Array<{ text: string; content: string }>;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export function parseLever(site: string, company: string, data: LeverPosting[]): Job[] {
  return (data ?? []).map((p) => {
    const listsHtml = (p.lists ?? []).map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`).join("");
    const html = `${p.description ?? ""}${listsHtml}${p.additional ?? ""}`;
    const location = p.categories?.location?.trim() ?? p.categories?.allLocations?.join(" / ") ?? "";
    const remote =
      p.workplaceType === "remote" ? true : p.workplaceType === "onsite" || p.workplaceType === "hybrid" ? false : inferRemote(location, p.text);
    const salary =
      p.salaryRange && (p.salaryRange.min || p.salaryRange.max)
        ? `${p.salaryRange.currency ?? ""} ${p.salaryRange.min ?? "?"}–${p.salaryRange.max ?? "?"} ${p.salaryRange.interval ?? ""}`.trim()
        : null;
    return {
      id: jobId("lever", site, p.id),
      source: "lever",
      sourceSlug: site,
      sourceId: p.id,
      company,
      title: p.text.trim(),
      location,
      remote,
      url: p.hostedUrl,
      applyUrl: p.applyUrl ?? `${p.hostedUrl.replace(/\/$/, "")}/apply`,
      descriptionHtml: html,
      descriptionText: html ? htmlToText(html) : (p.descriptionPlain ?? ""),
      postedAt: toIso(p.createdAt),
      department: [p.categories?.department, p.categories?.team].filter(Boolean).join(" / ") || null,
      employmentType: p.categories?.commitment ?? null,
      salaryText: salary,
    };
  });
}

export const lever: SourceAdapter = {
  kind: "lever",
  async fetchJobs(slug, company = slug) {
    const data = await fetchJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    return parseLever(slug, company, data);
  },
};
