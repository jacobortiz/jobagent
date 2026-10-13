/**
 * The review gate. Nothing is submitted without a decision from a Reviewer. The terminal
 * reviewer is interactive; the auto reviewer is for --auto-submit, the demo and tests.
 */
import readline from "node:readline/promises";
import type { FillResult, FormField, PlanItem } from "../types.js";
import { color, table } from "../util/log.js";
import { truncate } from "../util/text.js";

export type ReviewDecision =
  | { type: "submit" }
  | { type: "skip"; reason?: string }
  | { type: "edit"; ref: string; value: string }
  | { type: "takeover" }
  | { type: "abort" };

export interface ReviewContext {
  jobTitle: string;
  company: string;
  url: string;
  plan: PlanItem[];
  fills: FillResult[];
  fields: FormField[];
  screenshotPath: string | null;
  warnings: string[];
}

export interface Reviewer {
  /** Ask the human for a value. Return null to leave the field empty. */
  askHuman(item: PlanItem, field: FormField | undefined): Promise<string | null>;
  /** Final go / no-go on the filled form. */
  review(ctx: ReviewContext): Promise<ReviewDecision>;
  /** Block until the human signals they are done with the browser (CAPTCHA, takeover). */
  waitForHuman(message: string): Promise<void>;
}

export function renderPlan(plan: PlanItem[], fills: FillResult[] = []): string {
  const fillByRef = new Map(fills.map((f) => [f.ref, f]));
  const rows = plan.map((p) => {
    const fill = fillByRef.get(p.ref);
    const status =
      p.action === "skip" ? color.dim("skip") : p.action === "ask_human" ? color.yellow("needs you") : fill ? (fill.ok ? color.green("ok") : color.red("failed")) : color.dim("pending");
    const value = p.action === "upload" ? `📎 ${p.filePath ?? p.value}` : (p.value ?? "");
    return [
      p.required ? "*" : " ",
      truncate(p.label || "(unlabeled)", 40),
      truncate(value.replace(/\s+/g, " "), 60),
      `${p.source}${p.confidence < 0.7 ? color.yellow(" ?") : ""}`,
      status + (fill && !fill.ok && fill.message ? color.dim(` ${truncate(fill.message, 40)}`) : ""),
    ];
  });
  return table(rows, ["", "Field", "Value", "Source", "Status"]);
}

export class TerminalReviewer implements Reviewer {
  private rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  close(): void {
    this.rl.close();
  }

  async askHuman(item: PlanItem, field: FormField | undefined): Promise<string | null> {
    process.stdout.write("\n" + color.bold(`? ${item.label || "(unlabeled field)"}`) + (item.required ? color.red(" *") : "") + "\n");
    if (item.rationale) process.stdout.write(color.dim(`  ${item.rationale}\n`));
    if (field?.options.length) {
      field.options.slice(0, 30).forEach((o, i) => process.stdout.write(color.dim(`  ${i + 1}. ${o.label}\n`)));
      process.stdout.write(color.dim("  Type a number or the option text. Enter to leave blank.\n"));
    } else {
      process.stdout.write(color.dim("  Type an answer. Enter to leave blank.\n"));
    }
    const answer = (await this.rl.question("> ")).trim();
    if (!answer) return null;
    if (field?.options.length && /^\d+$/.test(answer)) {
      const idx = Number(answer) - 1;
      const opt = field.options[idx];
      if (opt) return opt.label;
    }
    return answer;
  }

  async review(ctx: ReviewContext): Promise<ReviewDecision> {
    process.stdout.write("\n" + color.bold(`Review: ${ctx.jobTitle} @ ${ctx.company}`) + "\n" + color.dim(ctx.url) + "\n\n");
    process.stdout.write(renderPlan(ctx.plan, ctx.fills) + "\n");
    if (ctx.screenshotPath) process.stdout.write(color.dim(`\nScreenshot: ${ctx.screenshotPath}\n`));
    for (const w of ctx.warnings) process.stdout.write(color.yellow(`! ${w}\n`));
    process.stdout.write(
      "\n" +
        `${color.bold("[s]")}ubmit  ${color.bold("[e]")}dit a field  ${color.bold("[b]")}rowser takeover  ${color.bold("[k]")} skip this job  ${color.bold("[q]")}uit (keep draft)\n`,
    );
    while (true) {
      const choice = (await this.rl.question("> ")).trim().toLowerCase();
      if (choice === "s" || choice === "submit") return { type: "submit" };
      if (choice === "k" || choice === "skip") {
        const reason = (await this.rl.question("Reason (optional): ")).trim();
        return { type: "skip", reason: reason || undefined };
      }
      if (choice === "b" || choice === "browser") return { type: "takeover" };
      if (choice === "q" || choice === "quit") return { type: "abort" };
      if (choice === "e" || choice === "edit") {
        const label = (await this.rl.question("Field label (or ref): ")).trim().toLowerCase();
        const item = ctx.plan.find((p) => p.ref === label || p.label.toLowerCase() === label) ?? ctx.plan.find((p) => p.label.toLowerCase().includes(label));
        if (!item) {
          process.stdout.write(color.red("No such field.\n"));
          continue;
        }
        const value = await this.rl.question(`New value for "${item.label}": `);
        return { type: "edit", ref: item.ref, value };
      }
      process.stdout.write("Please answer s, e, b, k or q.\n");
    }
  }

  async waitForHuman(message: string): Promise<void> {
    process.stdout.write("\n" + color.yellow("⏸ " + message) + "\n");
    await this.rl.question(color.dim("Press Enter when done... "));
  }
}

export interface AutoReviewerOptions {
  /** Submit when there are no unanswered required fields. */
  autoSubmit: boolean;
  /** Canned answers for ask_human prompts keyed by (lowercased) label. */
  answers?: Record<string, string>;
}

/** Non-interactive reviewer for --auto-submit, the demo and tests. */
export class AutoReviewer implements Reviewer {
  constructor(private readonly opts: AutoReviewerOptions) {}

  async askHuman(item: PlanItem): Promise<string | null> {
    return this.opts.answers?.[item.label.toLowerCase()] ?? null;
  }

  async review(ctx: ReviewContext): Promise<ReviewDecision> {
    if (!this.opts.autoSubmit) return { type: "skip", reason: "non-interactive and auto-submit disabled" };
    const blocking = ctx.warnings.filter((w) => /required/i.test(w));
    if (blocking.length) return { type: "skip", reason: `unanswered required fields: ${blocking.join("; ")}` };
    return { type: "submit" };
  }

  async waitForHuman(message: string): Promise<void> {
    throw new Error(`Human attention needed but running non-interactively: ${message}`);
  }
}
