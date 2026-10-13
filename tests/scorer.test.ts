import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ProfileSchema, type LoadedProfile } from "../src/config.js";
import { ClaudeScorer, ScoringRefusedError } from "../src/scoring/scorer.js";
import type { Job } from "../src/types.js";

const profile: LoadedProfile = {
  ...ProfileSchema.parse({
    candidate: { first_name: "Jane", last_name: "Doe", email: "j@d.com", phone: "5555555", location: { city: "Austin", state: "TX" } },
    documents: { resume_pdf: "r.pdf", resume_text: "inline" },
    work_authorization: {},
    preferences: { min_salary: 150000 },
  }),
  resumePdfPath: "/abs/r.pdf",
  resumeText: "Jane Doe, Senior Engineer.",
};

const job: Job = {
  id: "j1",
  source: "lever",
  sourceSlug: "acme",
  sourceId: "1",
  company: "Acme",
  title: "Backend Engineer",
  location: "Remote",
  remote: true,
  url: "https://x",
  applyUrl: "https://x/apply",
  descriptionText: "Go, Postgres, Kubernetes.",
  descriptionHtml: "",
  postedAt: null,
  department: null,
  employmentType: null,
  salaryText: null,
};

/** Minimal stand-in for the SDK client: records the request and returns a canned response. */
function stubClient(response: Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  const client = { beta: { messages: { parse: async (params: Record<string, unknown>) => (calls.push(params), response) } } };
  return { client: client as unknown as Anthropic, calls };
}

const parsed = {
  fit_score: 142,
  recommendation: "apply",
  summary: "Strong match.",
  reasons: ["Go"],
  red_flags: [],
  missing_requirements: ["Kubernetes"],
  matched_requirements: ["Go", "Postgres"],
  seniority_match: "match",
  tailored_summary: " I build backends. ",
  cover_letter: "Dear Hiring Team,\n\nHello.\n",
};

describe("ClaudeScorer", () => {
  it("sends a cached profile system block, structured output format, effort, and the refusal fallback", async () => {
    const { client, calls } = stubClient({ stop_reason: "end_turn", model: "claude-opus-5-5", parsed_output: parsed, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 1000 } });
    const ev = await new ClaudeScorer(client, profile).score(job);

    expect(calls).toHaveLength(1);
    const params = calls[0]!;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.fallbacks).toBe("default");
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system).toHaveLength(2);
    expect(system[1]!.text).toContain("Jane Doe, Senior Engineer.");
    expect(system[1]!.text).toContain("Minimum base salary: 150000");
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
    const output = params.output_config as { effort: string; format: { type: string } };
    expect(output.effort).toBe("high");
    expect(output.format.type).toBe("json_schema");
    const messages = params.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toContain("Title: Backend Engineer");
    expect(messages[0]!.content).toContain("Go, Postgres, Kubernetes.");

    // Clamped, trimmed, token usage carried through.
    expect(ev).toMatchObject({ jobId: "j1", fitScore: 100, recommendation: "apply", tailoredSummary: "I build backends.", missingRequirements: ["Kubernetes"], inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000, model: "claude-opus-5-5" });
  });

  it("surfaces refusals as a typed error", async () => {
    const { client } = stubClient({ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: "nope" }, parsed_output: null, usage: { input_tokens: 1, output_tokens: 0 } });
    await expect(new ClaudeScorer(client, profile).score(job)).rejects.toBeInstanceOf(ScoringRefusedError);
  });

  it("fails loudly on truncated or unparseable output", async () => {
    const { client } = stubClient({ stop_reason: "max_tokens", parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(new ClaudeScorer(client, profile).score(job)).rejects.toThrow(/max_tokens/);
    const { client: c2 } = stubClient({ stop_reason: "end_turn", parsed_output: null, usage: { input_tokens: 1, output_tokens: 1 } });
    await expect(new ClaudeScorer(c2, profile).score(job)).rejects.toThrow(/did not parse/);
  });

  it("honors model and effort overrides", async () => {
    const { client, calls } = stubClient({ stop_reason: "end_turn", model: "claude-sonnet-5-5", parsed_output: parsed, usage: { input_tokens: 1, output_tokens: 1 } });
    await new ClaudeScorer(client, profile, { model: "claude-sonnet-5-5", effort: "low" }).score(job);
    expect(calls[0]!.model).toBe("claude-sonnet-5-5");
    expect((calls[0]!.output_config as { effort: string }).effort).toBe("low");
  });
});
