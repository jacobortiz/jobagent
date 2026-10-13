/**
 * Greenhouse Job Board API (public, no auth):
 *   GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true
 * `content` is HTML that has been entity-escaped once; decode then strip.
 */
import type { Job } from "../types.js";
import { decodeEntities, htmlToText } from "../util/text.js";
import { fetchJson, inferRemote, jobId, toIso, type SourceAdapter } from "./common.js";

export interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  content?: string;
  location?: { name?: string };
  departments?: Array<{ name?: string }>;
  offices?: Array<{ name?: string; location?: string }>;
  metadata?: Array<{ name?: string; value?: unknown }>;
}

export interface GreenhouseResponse {
  jobs: GreenhouseJob[];
  meta?: { total?: number };
}

export function parseGreenhouse(board: string, company: string, data: GreenhouseResponse): Job[] {
  return (data.jobs ?? []).map((j) => {
    const html = decodeEntities(j.content ?? "");
    const location = j.location?.name?.trim() ?? "";
    const employmentType =
      j.metadata?.find((m) => /employment|job type/i.test(m.name ?? ""))?.value?.toString() ?? null;
    return {
      id: jobId("greenhouse", board, String(j.id)),
      source: "greenhouse",
      sourceSlug: board,
      sourceId: String(j.id),
      company,
      title: j.title.trim(),
      location,
      remote: inferRemote(location, j.title),
      url: j.absolute_url,
      // The embedded application form lives on the posting page (anchored at #app).
      applyUrl: j.absolute_url.includes("#") ? j.absolute_url : `${j.absolute_url}#app`,
      descriptionHtml: html,
      descriptionText: htmlToText(html),
      postedAt: toIso(j.first_published ?? j.updated_at),
      department: j.departments?.map((d) => d.name).filter(Boolean).join(", ") || null,
      employmentType,
      salaryText: null,
    };
  });
}

export const greenhouse: SourceAdapter = {
  kind: "greenhouse",
  async fetchJobs(slug, company = slug) {
    const data = await fetchJson<GreenhouseResponse>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
    );
    return parseGreenhouse(slug, company, data);
  },
};
