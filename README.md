# jobagent

An open-source take on the "AI applies to jobs for you" idea, built so that **you stay in control**: it discovers postings from public job-board APIs, asks Claude how well each one fits you, writes a tailored summary and cover letter, fills the application form in a real browser, and then **stops and shows you everything before anything is submitted**.

```
discover ──▶ prefilter ──▶ score (Claude) ──▶ queue ──▶ apply (Playwright + Claude) ──▶ review gate ──▶ submit ──▶ track
```

- **Discovery**: Greenhouse, Lever and Ashby expose public JSON endpoints for every company's board. No scraping, no logins, no LinkedIn/Indeed automation (their terms forbid it).
- **Prefilter**: cheap rules (titles, locations, keywords, age, blocked companies) run before any model call, so you only pay to evaluate plausible matches.
- **Scoring**: Claude returns a structured evaluation per job: fit score, recommendation, reasons, red flags, missing requirements, a tailored summary, and a cover letter. Your profile sits in a cached system prompt, so scoring a batch is cheap.
- **Application agent**: Playwright opens the company's own application page. The agent extracts every field, maps the standard ones deterministically from your profile (name, email, resume, work authorization, EEO declines, …), reuses answers you have given before, and asks Claude only about the leftovers. Every model answer is validated against the real field. The model can never pick a file to upload.
- **Review gate**: you see a table of field → value and a screenshot; you can submit, edit a field, take over the browser, or skip. CAPTCHAs are never bypassed: the agent pauses and hands you the browser.
- **Tracker**: SQLite (Node's built-in driver, no native build) holds jobs, evaluations, applications and an event log. Answers you type during review are saved to `config/answers.yaml` and reused next time.

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`).
- An Anthropic API key (`ANTHROPIC_API_KEY`) for scoring and form planning. The offline demo and `--no-llm` mode work without one.
- Chromium for Playwright: `npx playwright install chromium` (one time).

## Setup

```bash
git clone <this repo> jobagent && cd jobagent
npm install
npx playwright install chromium

npx jobagent init            # creates config/profile.yaml, config/sources.yaml, data/
```

Edit `config/profile.yaml` (who you are, your documents, constraints, preferences, default screening answers) and `config/sources.yaml` (which company boards to poll; the slug is in the company's careers URL, e.g. `boards.greenhouse.io/stripe` → `stripe`). Put your resume PDF and a text/markdown copy where the profile points.

Try the whole pipeline offline first:

```bash
npx jobagent demo            # local test form, no API key, no network; add --headed to watch
```

## Daily use

```bash
export ANTHROPIC_API_KEY=sk-ant-...

npx jobagent discover                # fetch boards, store postings, run the prefilter
npx jobagent score                   # Claude evaluates everything that passed (default 25 per run)
npx jobagent queue                   # what's worth applying to (fit >= preferences.min_fit_score)
npx jobagent show <id>               # evaluation, reasons, tailored summary, cover letter
npx jobagent apply <id>              # opens a visible browser, fills, then asks you before submitting
npx jobagent applications            # what you've applied to and when
```

`jobagent run` does discover + score + prints the queue in one go; add `--apply` to walk through the queue interactively. Schedule it:

```cron
# cron (Linux/macOS): weekdays at 8:15
15 8 * * 1-5  cd /path/to/jobagent && ANTHROPIC_API_KEY=... npx jobagent run >> data/run.log 2>&1
```

```powershell
# Windows Task Scheduler: action = "node", arguments = "bin\jobagent.js run", start in = C:\path\to\jobagent
```

Useful flags for `apply`:

| Flag | Effect |
|---|---|
| `--dry-run` | Fill everything, save a screenshot, never submit |
| `--auto-submit` | Submit without the interactive prompt when no field needs you (use with care) |
| `--headless` | Hide the browser (you cannot take over, so CAPTCHAs will stop the run) |
| `--no-llm` | Heuristics and saved answers only; unknown fields are asked of you |
| `--url <url>` | Apply at a different URL than the stored one |

The browser profile persists in `data/browser-profile`, so a site that remembers you or needs a one-time email verification only asks once.

## How the agent decides what to type

1. **Heuristics** (`src/apply/planner.ts`): ~45 rules keyed on the field's label, name, autocomplete and placeholder. They cover identity and contact fields, links, resume/cover-letter uploads, location (with US state expansion so "Austin, TX" matches "Austin, Texas, United States" in autocompletes), work authorization and sponsorship, relocation, age, prior employment, referral source, salary, start date, pronouns, every EEO question (always a decline unless your profile says otherwise), consent checkboxes (checked) and marketing opt-ins (unchecked).
2. **Saved answers**: `custom_answers` in the profile and anything you typed during earlier reviews, matched by fuzzy question similarity with the company name genericized ("Why Acme?" ≈ "Why do you want to work here?").
3. **Claude** (one structured-output call per form) for what's left, with the posting, your profile and the tailored materials as context. Decisions are validated: option labels must exist, low confidence becomes a question for you, required fields are never silently skipped, file inputs are never model-controlled.
4. **You**: anything still open is asked in the terminal (and remembered), and the final form is yours to approve.

## Configuration reference

See `config/profile.example.yaml`; every key is commented. Highlights:

- `preferences.min_fit_score` (default 70): threshold for the apply queue.
- `preferences.remote`: `required` | `preferred` | `any` | `no`.
- `preferences.max_posting_age_days`: skip stale postings.
- `screening.eeo.*`: defaults are the decline options.
- `model.scoring` / `model.planning` (default `claude-opus-5-5`), `model.scoring_effort` (default `high`), `model.planning_effort` (default `medium`), `model.concurrency`.

Set `JOBAGENT_HOME` (or `-C <dir>`) to keep config and data somewhere other than the current directory. `JOBAGENT_LOG=debug` for verbose logging.

## Development

```bash
npm test                 # unit tests: parsers, prefilter, fuzzy matching, planner, tracker, scorer (stubbed client)
npm run test:e2e         # headless Chromium against the local demo form, asserts what the form received
npm run typecheck
npm run build            # tsc -> dist/
```

Layout:

```
src/
  cli.ts              commander entry point
  config.ts           zod schemas + loaders for profile / sources / answers
  db.ts               SQLite tracker (jobs, evaluations, applications, events)
  discovery/          greenhouse.ts lever.ts ashby.ts prefilter.ts index.ts
  scoring/            prompts.ts scorer.ts (structured outputs, cached profile, refusal fallback)
  apply/              browser.ts extract.ts planner.ts fill.ts review.ts captcha.ts agent.ts
  demo/               local application form + server for offline runs
tests/                vitest unit tests + e2e/
```

## Ground rules baked in

- Applies only through the company's own ATS pages (Greenhouse, Lever, Ashby). It does not log into or automate LinkedIn, Indeed or other aggregators.
- Never bypasses CAPTCHAs or bot checks; it pauses for you.
- Never submits without a human decision unless you explicitly pass `--auto-submit`, and even then refuses when a required field is unanswered.
- Never invents credentials: the model is told to ask you rather than guess, and demographic questions default to "decline".
- Your data goes to two places only: the Claude API (profile + posting + form fields) and the application forms you approve.

Volume is a feature of the scoring threshold, not the agent. A high `min_fit_score` and a short, honest `titles_include` list will serve you far better than spraying applications.
