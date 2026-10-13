import type { LoadedProfile, SourceConfig } from "../config.js";
import { normalizeTitle, type Tracker } from "../db.js";
import type { Job, SourceKind } from "../types.js";
import { log } from "../util/log.js";
import { ashby } from "./ashby.js";
import type { SourceAdapter } from "./common.js";
import { greenhouse } from "./greenhouse.js";
import { lever } from "./lever.js";
import { prefilter } from "./prefilter.js";

export const ADAPTERS: Record<SourceKind, SourceAdapter> = { greenhouse, lever, ashby };

export interface DiscoverySummary {
  fetched: number;
  inserted: number;
  updated: number;
  passed: number;
  filtered: number;
  duplicates: number;
  errors: Array<{ source: SourceConfig; error: string }>;
}

/**
 * Fetch every configured board, store postings, run the prefilter, and flag duplicates.
 * Prefilter results are recomputed for existing jobs too, so preference edits take effect
 * on the next run without clearing the database.
 */
export async function discover(
  tracker: Tracker,
  sources: SourceConfig[],
  profile: LoadedProfile,
  opts: { only?: SourceKind; adapters?: Partial<Record<SourceKind, SourceAdapter>> } = {},
): Promise<DiscoverySummary> {
  const summary: DiscoverySummary = { fetched: 0, inserted: 0, updated: 0, passed: 0, filtered: 0, duplicates: 0, errors: [] };
  const adapters = { ...ADAPTERS, ...opts.adapters };

  for (const source of sources) {
    if (opts.only && source.type !== opts.only) continue;
    const adapter = adapters[source.type];
    let jobs: Job[];
    try {
      jobs = await adapter.fetchJobs(source.slug, source.company ?? source.slug);
      log.info(`${source.type}/${source.slug}: ${jobs.length} postings`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${source.type}/${source.slug} failed: ${message}`);
      summary.errors.push({ source, error: message });
      continue;
    }
    summary.fetched += jobs.length;

    for (const job of jobs) {
      const inserted = tracker.upsertJob(job);
      if (inserted) summary.inserted++;
      else summary.updated++;

      const result = prefilter(job, profile);
      tracker.setPrefilter(job.id, result.pass, result.reasons);
      if (result.pass) summary.passed++;
      else summary.filtered++;

      if (inserted && result.pass) {
        const twin = tracker.findSimilarJob(job.company, normalizeTitle(job.title), job.id);
        if (twin) {
          tracker.markDuplicate(job.id, twin.id);
          summary.duplicates++;
        }
      }
      if (inserted) tracker.logEvent({ jobId: job.id, applicationId: null, kind: "discovered", message: `${job.company}: ${job.title}`, data: { pass: result.pass, reasons: result.reasons } });
    }
  }
  return summary;
}
