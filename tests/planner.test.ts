import { describe, expect, it } from "vitest";
import { answerLookup, genericizeQuestion, heuristicPlan, validateModelPlan, type PlannerContext } from "../src/apply/planner.js";
import { ProfileSchema, type LoadedProfile } from "../src/config.js";
import type { FormField, Job } from "../src/types.js";

const profile: LoadedProfile = {
  ...ProfileSchema.parse({
    candidate: {
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.com",
      phone: "+1 512 555 0100",
      location: { city: "Austin", state: "TX", country: "United States", postal_code: "78701" },
      linkedin: "https://www.linkedin.com/in/janedoe",
      github: "https://github.com/janedoe",
      current_title: "Senior Engineer",
      current_company: "Example Corp",
      years_of_experience: 7,
    },
    documents: { resume_pdf: "resume.pdf", resume_text: "Resume" },
    work_authorization: { authorized_countries: ["United States"], requires_sponsorship: false, willing_to_relocate: false },
    preferences: {},
    screening: { salary_expectation: "$170k", start_date: "Two weeks", how_did_you_hear: "Company website", eeo: { gender: "Decline to self-identify" } },
    custom_answers: [{ question: "Why do you want to work here?", answer: "Because robots." }],
  }),
  resumePdfPath: "/abs/resume.pdf",
  resumeText: "Resume",
};

const job: Job = {
  id: "j1",
  source: "greenhouse",
  sourceSlug: "acme",
  sourceId: "1",
  company: "Acme Robotics",
  title: "Engineer",
  location: "Austin",
  remote: true,
  url: "",
  applyUrl: "",
  descriptionText: "",
  descriptionHtml: "",
  postedAt: null,
  department: null,
  employmentType: null,
  salaryText: null,
};

const ctx: PlannerContext = { profile, job, evaluation: null, answers: [{ question: "What is your notice period?", answer: "2 weeks" }], today: new Date("2026-10-13") };

let n = 0;
const field = (partial: Partial<FormField> & { label: string }): FormField => ({
  ref: `f${++n}`,
  kind: "text",
  name: null,
  id: null,
  placeholder: null,
  autocomplete: null,
  required: false,
  options: [],
  section: null,
  value: null,
  accept: null,
  ...partial,
});

const opts = (...labels: string[]) => labels.map((l) => ({ label: l, value: l.toLowerCase() }));

describe("heuristicPlan", () => {
  it("maps identity fields deterministically", () => {
    const fields = [
      field({ label: "First Name", autocomplete: "given-name" }),
      field({ label: "Last Name" }),
      field({ label: "Email", kind: "email" }),
      field({ label: "Phone", kind: "tel" }),
      field({ label: "LinkedIn Profile" }),
      field({ label: "GitHub URL" }),
      field({ label: "Full Name" }),
    ];
    const { plan, unresolved } = heuristicPlan(fields, ctx);
    expect(unresolved).toHaveLength(0);
    expect(plan.map((p) => p.value)).toEqual(["Jane", "Doe", "jane@example.com", "+1 512 555 0100", "https://www.linkedin.com/in/janedoe", "https://github.com/janedoe", "Jane Doe"]);
    expect(plan.every((p) => p.source === "heuristic" && p.action === "fill")).toBe(true);
  });

  it("uploads the resume only from the profile path and skips unknown optional files", () => {
    const fields = [field({ label: "Resume/CV", kind: "file", required: true }), field({ label: "Cover Letter", kind: "file" }), field({ label: "Portfolio (PDF)", kind: "file" })];
    const { plan } = heuristicPlan(fields, ctx);
    expect(plan[0]).toMatchObject({ action: "upload", filePath: "/abs/resume.pdf" });
    expect(plan[1]!.action).toBe("skip");
    expect(plan[2]!.action).toBe("skip");
  });

  it("uses the generated cover letter file when the form only accepts a file", () => {
    const { plan } = heuristicPlan([field({ label: "Cover Letter", kind: "file" })], { ...ctx, coverLetterFile: "/tmp/cl.txt" });
    expect(plan[0]).toMatchObject({ action: "upload", filePath: "/tmp/cl.txt" });
  });

  it("answers screening booleans by picking the right option", () => {
    const fields = [
      field({ label: "Are you legally authorized to work in the United States?", kind: "radio", options: opts("Yes", "No") }),
      field({ label: "Will you now or in the future require sponsorship for employment visa status?", kind: "radio", options: opts("Yes", "No") }),
      field({ label: "Are you willing to relocate?", kind: "select", options: opts("Select...", "Yes", "No") }),
      field({ label: "Are you at least 18 years of age?", kind: "checkbox" }),
    ];
    const { plan } = heuristicPlan(fields, ctx);
    expect(plan.map((p) => p.value)).toEqual(["Yes", "No", "No", "true"]);
    expect(plan[0]!.action).toBe("select");
    expect(plan[3]!.action).toBe("check");
  });

  it("maps years of experience onto a range option", () => {
    const f = field({ label: "How many years of professional experience do you have?", kind: "select", options: opts("Select...", "0-2 years", "3-5 years", "6-9 years", "10+ years") });
    expect(heuristicPlan([f], ctx).plan[0]!.value).toBe("6-9 years");
    const ctx12 = { ...ctx, profile: { ...profile, candidate: { ...profile.candidate, years_of_experience: 12 } } };
    expect(heuristicPlan([f], ctx12).plan[0]!.value).toBe("10+ years");
  });

  it("uses the expanded state name for location comboboxes", () => {
    const { plan } = heuristicPlan([field({ label: "Location (City)", kind: "combobox", required: true })], ctx);
    expect(plan[0]).toMatchObject({ action: "select", value: "Austin, Texas" });
  });

  it("declines EEO questions, falling back to the closest decline option", () => {
    const fields = [
      field({ label: "Gender", kind: "select", options: opts("Select...", "Male", "Female", "Decline To Self Identify") }),
      field({ label: "Veteran Status", kind: "select", options: opts("I am not a protected veteran", "I identify as a protected veteran", "I don't wish to answer") }),
      field({ label: "Race", kind: "select", options: opts("Asian", "White", "Prefer not to say") }),
    ];
    const { plan } = heuristicPlan(fields, ctx);
    expect(plan.map((p) => p.value)).toEqual(["Decline To Self Identify", "I don't wish to answer", "Prefer not to say"]);
  });

  it("handles consent and marketing checkboxes differently", () => {
    const fields = [field({ label: "I agree to the privacy policy", kind: "checkbox", required: true }), field({ label: "Keep me updated about future opportunities", kind: "checkbox" })];
    const { plan } = heuristicPlan(fields, ctx);
    expect(plan.map((p) => p.value)).toEqual(["true", "false"]);
  });

  it("reuses saved and custom answers for free-form questions, even with the company name in them", () => {
    const fields = [field({ label: "Why do you want to work at Acme Robotics?", kind: "textarea", required: true }), field({ label: "Notice period" })];
    const { plan, unresolved } = heuristicPlan(fields, ctx);
    expect(unresolved).toHaveLength(0);
    expect(plan[0]).toMatchObject({ source: "answers", value: "Because robots." });
    expect(plan[1]!.value).toBe("2 weeks");
  });

  it("leaves genuinely unknown questions unresolved", () => {
    const fields = [field({ label: "Describe a time you disagreed with a teammate", kind: "textarea", required: true }), field({ label: "School", kind: "combobox" })];
    const { plan, unresolved } = heuristicPlan(fields, ctx);
    expect(plan).toHaveLength(0);
    expect(unresolved).toHaveLength(2);
  });

  it("does not confuse 'Company Name' with the candidate's name", () => {
    const { plan } = heuristicPlan([field({ label: "Current Company Name" })], ctx);
    expect(plan[0]!.value).toBe("Example Corp");
  });
});

describe("genericizeQuestion", () => {
  it("replaces the company name with 'here'", () => {
    expect(genericizeQuestion("Why do you want to work at Acme Robotics?", "Acme Robotics")).toBe("why do you want to work here");
    expect(genericizeQuestion("Why Acme?", "Acme Robotics, Inc.")).toBe("why here");
  });
});

describe("answerLookup", () => {
  it("prefers company-specific answers and ignores other companies' answers", () => {
    const c: PlannerContext = {
      ...ctx,
      answers: [
        { question: "Why do you want to work here?", answer: "Generic" },
        { question: "Why do you want to work here?", answer: "Acme-specific", company: "Acme Robotics" },
        { question: "Why do you want to work here?", answer: "Other", company: "Globex" },
      ],
    };
    expect(answerLookup(field({ label: "Why do you want to work here?", kind: "textarea" }), c)?.value).toBe("Acme-specific");
  });
});

describe("validateModelPlan", () => {
  const fields = [
    field({ label: "Describe a project", kind: "textarea", required: true }),
    field({ label: "Preferred office", kind: "select", options: opts("Austin", "Denver", "Remote"), required: true }),
    field({ label: "Transcript", kind: "file", required: true }),
    field({ label: "Subscribe", kind: "checkbox" }),
    field({ label: "Nickname" }),
    field({ label: "Pronouns", kind: "select", options: opts("He/him", "She/her", "They/them") }),
  ];
  const [proj, office, transcript, subscribe, nickname, pronouns] = fields as [FormField, FormField, FormField, FormField, FormField, FormField];

  it("keeps valid decisions and normalizes actions", () => {
    const plan = validateModelPlan(
      [
        { ref: proj.ref, action: "fill", value: "I built a thing.", confidence: "high", rationale: "resume" },
        { ref: office.ref, action: "select", value: "remote", confidence: "medium", rationale: "prefers remote" },
        { ref: transcript.ref, action: "fill", value: "/etc/passwd", confidence: "high", rationale: "nope" },
        { ref: subscribe.ref, action: "check", value: "no", confidence: "high", rationale: "" },
        { ref: nickname.ref, action: "skip", value: "", confidence: "high", rationale: "optional" },
        { ref: pronouns.ref, action: "select", value: "Ze/zir", confidence: "high", rationale: "" },
      ],
      fields,
    );
    const byRef = new Map(plan.map((p) => [p.ref, p]));
    expect(byRef.get(proj.ref)).toMatchObject({ action: "fill", value: "I built a thing.", confidence: 0.9 });
    expect(byRef.get(office.ref)).toMatchObject({ action: "select", value: "Remote" });
    expect(byRef.get(transcript.ref)).toMatchObject({ action: "ask_human", value: null });
    expect(byRef.get(subscribe.ref)).toMatchObject({ action: "check", value: "false" });
    expect(byRef.get(nickname.ref)).toMatchObject({ action: "skip" });
    // Not a real option and the field is optional -> skip, never a guess.
    expect(byRef.get(pronouns.ref)).toMatchObject({ action: "skip" });
  });

  it("escalates required fields the model skipped, guessed badly, or ignored", () => {
    const plan = validateModelPlan(
      [
        { ref: proj.ref, action: "skip", value: "", confidence: "high", rationale: "dunno" },
        { ref: office.ref, action: "select", value: "Paris", confidence: "high", rationale: "" },
        { ref: "ghost", action: "fill", value: "x", confidence: "high", rationale: "" },
      ],
      fields,
    );
    const byRef = new Map(plan.map((p) => [p.ref, p]));
    expect(byRef.get(proj.ref)!.action).toBe("ask_human");
    expect(byRef.get(office.ref)!.action).toBe("ask_human");
    expect(byRef.get(transcript.ref)!.action).toBe("ask_human");
    expect(byRef.has("ghost")).toBe(false);
    expect(plan).toHaveLength(fields.length);
  });

  it("downgrades low-confidence answers", () => {
    const plan = validateModelPlan([{ ref: proj.ref, action: "fill", value: "maybe?", confidence: "low", rationale: "guess" }], [proj]);
    expect(plan[0]).toMatchObject({ action: "ask_human", value: null });
  });
});
