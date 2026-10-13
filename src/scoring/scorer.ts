import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { LoadedProfile } from "../config.js";
import type { Evaluation, Job } from "../types.js";
import { clamp } from "../util/text.js";
import { jobMessage, profileBlock, SCORING_INSTRUCTIONS } from "./prompts.js";

/**
 * Structured output schema. Numeric bounds are enforced in code (clamp) rather than in the
 * schema, and confidence-like values use enums, which structured outputs handle reliably.
 */
export const EvaluationOutput = z.object({
  fit_score: z.number().describe("0-100 fit score"),
  recommendation: z.enum(["apply", "maybe", "skip"]),
  summary: z.string(),
  reasons: z.array(z.string()),
  red_flags: z.array(z.string()),
  missing_requirements: z.array(z.string()),
  matched_requirements: z.array(z.string()),
  seniority_match: z.enum(["under", "match", "over"]),
  tailored_summary: z.string(),
  cover_letter: z.string(),
});

export interface Scorer {
  score(job: Job): Promise<Evaluation>;
}

export class ScoringRefusedError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly category: string | null,
    explanation: string | null,
  ) {
    super(`Model declined to evaluate job ${jobId}${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : ""}`);
    this.name = "ScoringRefusedError";
  }
}

export function createAnthropicClient(): Anthropic {
  // Resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
  return new Anthropic();
}

/** Scores jobs with Claude. The profile is placed in a cached system block so repeated calls are cheap. */
export class ClaudeScorer implements Scorer {
  private readonly system: Anthropic.Beta.BetaTextBlockParam[];

  constructor(
    private readonly client: Anthropic,
    private readonly profile: LoadedProfile,
    private readonly opts: { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" } = {},
  ) {
    this.system = [
      { type: "text", text: SCORING_INSTRUCTIONS },
      { type: "text", text: profileBlock(profile), cache_control: { type: "ephemeral" } },
    ];
  }

  get model(): string {
    return this.opts.model ?? this.profile.model.scoring;
  }

  async score(job: Job): Promise<Evaluation> {
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 8000,
      // Server-side refusal fallback: if a safety classifier declines, the API retries on
      // the default fallback model inside the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: this.system,
      messages: [{ role: "user", content: jobMessage(job) }],
      output_config: {
        effort: this.opts.effort ?? this.profile.model.scoring_effort,
        format: betaZodOutputFormat(EvaluationOutput),
      },
    });

    if (response.stop_reason === "refusal") {
      throw new ScoringRefusedError(job.id, response.stop_details?.category ?? null, response.stop_details?.explanation ?? null);
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error(`Evaluation for ${job.id} was cut off at max_tokens`);
    }
    const out = response.parsed_output;
    if (!out) throw new Error(`Evaluation for ${job.id} did not parse`);

    return {
      jobId: job.id,
      model: response.model,
      fitScore: clamp(Math.round(out.fit_score), 0, 100),
      recommendation: out.recommendation,
      summary: out.summary.trim(),
      reasons: out.reasons,
      redFlags: out.red_flags,
      missingRequirements: out.missing_requirements,
      matchedRequirements: out.matched_requirements,
      seniorityMatch: out.seniority_match,
      tailoredSummary: out.tailored_summary.trim(),
      coverLetter: out.cover_letter.trim(),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
  }
}

/** Deterministic scorer for the offline demo and tests. */
export class StaticScorer implements Scorer {
  constructor(private readonly profile: LoadedProfile) {}
  async score(job: Job): Promise<Evaluation> {
    const c = this.profile.candidate;
    return {
      jobId: job.id,
      model: "static",
      fitScore: 80,
      recommendation: "apply",
      summary: `Offline placeholder evaluation for ${job.title} at ${job.company}.`,
      reasons: ["generated without an LLM (demo mode)"],
      redFlags: [],
      missingRequirements: [],
      matchedRequirements: [],
      seniorityMatch: "match",
      tailoredSummary: `${c.current_title ?? "Engineer"} with ${c.years_of_experience ?? "several"} years of experience.`,
      coverLetter: `Dear Hiring Team,\n\nI am excited to apply for the ${job.title} role at ${job.company}. My background as ${c.current_title ?? "an engineer"} lines up well with what you describe, and I would welcome the chance to discuss how I can contribute.\n\nThank you for your consideration.\n\n${c.first_name} ${c.last_name}`,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    };
  }
}
