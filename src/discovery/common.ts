import { createHash } from "node:crypto";
import type { Job, SourceKind } from "../types.js";

export const USER_AGENT = "jobagent/0.1 (+https://github.com/jobagent; personal job-search tool)";

/** Short, stable, URL-safe id for a posting. */
export function jobId(source: SourceKind, slug: string, sourceId: string): string {
  return createHash("sha1").update(`${source}:${slug.toLowerCase()}:${sourceId}`).digest("hex").slice(0, 10);
}

export async function fetchJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  }
  return (await res.json()) as T;
}

/** Guess remote-ness from a location string when the source does not say. */
export function inferRemote(...texts: Array<string | null | undefined>): boolean | null {
  const joined = texts.filter(Boolean).join(" ").toLowerCase();
  if (!joined) return null;
  if (/\b(remote|anywhere|distributed|work from home|wfh)\b/.test(joined)) return true;
  if (/\b(on-?site|in[- ]office|hybrid)\b/.test(joined)) return false;
  return null;
}

export function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface SourceAdapter {
  kind: SourceKind;
  fetchJobs(slug: string, company?: string): Promise<Job[]>;
}
