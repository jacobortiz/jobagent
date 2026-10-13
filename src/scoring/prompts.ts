import type { LoadedProfile } from "../config.js";
import type { Job } from "../types.js";
import { truncate } from "../util/text.js";

/**
 * Static instructions. Kept byte-stable so it (and the profile block that follows it)
 * can be served from the prompt cache across every job scored in a run.
 */
export const SCORING_INSTRUCTIONS = `You are a candid career advisor evaluating whether a specific job posting is worth this candidate applying to.

You will receive the candidate's profile (resume, preferences, constraints) in this system prompt and one job posting in the user message. Return a structured evaluation.

How to score fit_score (0-100):
- 85-100: strong match on seniority, core skills, domain and constraints; the candidate would be a top-quartile applicant.
- 70-84: good match with a couple of gaps a reasonable hiring manager would overlook.
- 50-69: partial match; applying is a long shot or the role misaligns with stated preferences.
- below 50: poor match or a hard constraint fails (location, authorization, seniority far off, excluded role type).

Rules:
- Hard constraints from the profile (work authorization, remote requirement, blocked companies, minimum salary when the posting states a range) cap the score below 50 when violated.
- Judge seniority honestly. "over" means the candidate is clearly more senior than the role wants; "under" means the role wants more experience than the candidate has.
- reasons, red_flags, missing_requirements and matched_requirements are short, specific bullet phrases grounded in the posting text. Never invent requirements that are not in the posting.
- recommendation is "apply" for 70+, "maybe" for 50-69, and "skip" below 50, unless a red flag justifies lowering it.
- tailored_summary: 2-3 sentences in first person the candidate could paste as a professional summary for this role. Use only facts from the resume.
- cover_letter: a complete cover letter in plain text (no markdown, no placeholders like [Company]), 180-260 words, addressed "Dear Hiring Team,". Concrete, warm, specific to the posting, consistent with the candidate's cover_letter_template guidance if provided. Never claim experience that is not in the resume. If recommendation is "skip", still write a brief letter but keep it short.
- summary: one sentence a human can read in a list view.`;

export function profileBlock(profile: LoadedProfile): string {
  const c = profile.candidate;
  const p = profile.preferences;
  const w = profile.work_authorization;
  const lines = [
    `# Candidate profile`,
    `Name: ${c.first_name} ${c.last_name}`,
    `Location: ${[c.location.city, c.location.state, c.location.country].filter(Boolean).join(", ")}`,
    c.current_title ? `Current title: ${c.current_title}${c.current_company ? ` at ${c.current_company}` : ""}` : "",
    c.years_of_experience !== undefined ? `Years of experience: ${c.years_of_experience}` : "",
    ``,
    `## Hard constraints`,
    `Authorized to work in: ${w.authorized_countries.join(", ")}`,
    `Requires visa sponsorship: ${w.requires_sponsorship ? "yes" : "no"}`,
    `Willing to relocate: ${w.willing_to_relocate ? "yes" : "no"}`,
    `Remote preference: ${p.remote}`,
    p.min_salary ? `Minimum base salary: ${p.min_salary}` : "",
    p.locations.length ? `Acceptable locations: ${p.locations.join("; ")}` : "",
    ``,
    `## Preferences`,
    p.titles_include.length ? `Target titles: ${p.titles_include.join("; ")}` : "",
    p.seniority.length ? `Target seniority: ${p.seniority.join(", ")}` : "",
    p.keywords_include.length ? `Wants: ${p.keywords_include.join("; ")}` : "",
    p.keywords_exclude.length ? `Avoids: ${p.keywords_exclude.join("; ")}` : "",
    p.narrative ? `Narrative: ${p.narrative.trim()}` : "",
    profile.documents.cover_letter_template ? `\n## Cover letter guidance\n${profile.documents.cover_letter_template.trim()}` : "",
    ``,
    `## Resume`,
    profile.resumeText.trim(),
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function jobMessage(job: Job): string {
  return [
    `# Job posting`,
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Location: ${job.location || "not stated"}${job.remote === true ? " (remote)" : job.remote === false ? " (on-site/hybrid)" : ""}`,
    job.department ? `Department: ${job.department}` : "",
    job.employmentType ? `Employment type: ${job.employmentType}` : "",
    job.salaryText ? `Compensation: ${job.salaryText}` : "",
    job.postedAt ? `Posted: ${job.postedAt.slice(0, 10)}` : "",
    `URL: ${job.url}`,
    ``,
    `## Description`,
    truncate(job.descriptionText, 20_000),
  ]
    .filter((l) => l !== "")
    .join("\n");
}
