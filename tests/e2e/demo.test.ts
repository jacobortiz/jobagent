import { describe, expect, it } from "vitest";
import { runDemo } from "../../src/demo/run.js";

describe("offline end-to-end demo", () => {
  it("fills and submits the local application form without a model", async () => {
    const { outcome, submission } = await runDemo({ headless: true, quiet: true });
    expect(outcome.status).toBe("submitted");
    expect(outcome.fills.filter((f) => !f.ok)).toEqual([]);
    expect(outcome.plan.filter((p) => p.action === "ask_human")).toEqual([]);
    expect(submission).toMatchObject({
      first_name: "Jane",
      last_name: "Doe",
      email: "jane.doe@example.com",
      resume: "resume.pdf",
      location: "Austin, Texas, United States",
      authorized: "yes",
      sponsorship: "no",
      experience: "6-9",
      gender: "Decline To Self Identify",
      disability: "decline",
      privacy: "yes",
    });
    expect(submission?.updates).toBeUndefined();
    expect(String(submission?.cover_letter)).toContain("Dear Hiring Team");
    expect(String(submission?.why)).toContain("fleet control plane");
  });
});
