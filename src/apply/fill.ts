import type { Locator, Page } from "playwright";
import type { FillResult, FormField, PlanItem } from "../types.js";
import { bestMatch } from "../util/fuzzy.js";
import { log } from "../util/log.js";

const byRef = (page: Page, ref: string): Locator => page.locator(`[data-ja-ref="${ref}"]`).first();

/** Execute a plan against the live page. Each item is independent; failures are reported, not thrown. */
export async function executePlan(page: Page, plan: PlanItem[], fields: FormField[]): Promise<FillResult[]> {
  const fieldByRef = new Map(fields.map((f) => [f.ref, f]));
  const results: FillResult[] = [];
  for (const item of plan) {
    if (item.action === "skip" || item.action === "ask_human") continue;
    const field = fieldByRef.get(item.ref);
    if (!field) {
      results.push({ ref: item.ref, ok: false, message: "field no longer on page" });
      continue;
    }
    try {
      await fillOne(page, item, field);
      results.push({ ref: item.ref, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] ?? err.message : String(err);
      log.warn(`fill failed for "${field.label}": ${message}`);
      results.push({ ref: item.ref, ok: false, message });
    }
    await page.waitForTimeout(80);
  }
  return results;
}

async function fillOne(page: Page, item: PlanItem, field: FormField): Promise<void> {
  const loc = byRef(page, item.ref);
  const value = item.value ?? "";

  switch (item.action) {
    case "upload": {
      if (!item.filePath) throw new Error("upload without a resolved file path");
      await loc.setInputFiles(item.filePath);
      return;
    }
    case "check": {
      if (field.kind === "checkbox_group") {
        const wanted = value.split(";").map((s) => s.trim()).filter(Boolean);
        for (const w of wanted) {
          const opt = bestMatch(w, field.options, (o) => o.label, 0.7);
          if (!opt || !opt.item.ref) throw new Error(`no checkbox option matches "${w}"`);
          await byRef(page, opt.item.ref).check({ force: true });
        }
        return;
      }
      await loc.setChecked(value === "true", { force: true });
      return;
    }
    case "select": {
      if (field.kind === "radio") {
        const opt = bestMatch(value, field.options, (o) => o.label, 0.6) ?? bestMatch(value, field.options, (o) => o.value, 0.9);
        if (!opt || !opt.item.ref) throw new Error(`no radio option matches "${value}"`);
        const radio = byRef(page, opt.item.ref);
        // Many ATS styles hide the native radio behind a styled label; clicking the label is more reliable.
        const label = radio.locator("xpath=ancestor::label[1]");
        if ((await label.count()) > 0) await label.click();
        else await radio.check({ force: true });
        return;
      }
      if (field.kind === "select") {
        const opt = bestMatch(value, field.options, (o) => o.label, 0.6);
        if (!opt) throw new Error(`no option matches "${value}"`);
        await loc.selectOption({ value: opt.item.value });
        return;
      }
      if (field.kind === "combobox") {
        await fillCombobox(page, loc, value);
        return;
      }
      if (field.kind === "checkbox_group") {
        return fillOne(page, { ...item, action: "check" }, field);
      }
      // A select action on a plain text field: just type it.
      await loc.fill(value);
      return;
    }
    case "fill": {
      if (field.kind === "combobox") {
        await fillCombobox(page, loc, value);
        return;
      }
      if (field.kind === "select" || field.kind === "radio" || field.kind === "checkbox_group") {
        return fillOne(page, { ...item, action: "select" }, field);
      }
      if (field.kind === "checkbox") {
        return fillOne(page, { ...item, action: "check", value: /^(true|yes|1)$/i.test(value) ? "true" : "false" }, field);
      }
      if (field.kind === "file") throw new Error("refusing to upload a model-chosen path");
      const isContentEditable = await loc.evaluate((el) => el.getAttribute("contenteditable") === "true");
      if (isContentEditable) {
        await loc.click();
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.type(value);
        return;
      }
      if (field.kind === "date") {
        await loc.fill(toIsoDate(value));
        return;
      }
      await loc.click({ timeout: 5000 }).catch(() => undefined);
      await loc.fill(value);
      // Some frameworks only commit on blur.
      await loc.press("Tab").catch(() => undefined);
      return;
    }
    default:
      return;
  }
}

const OPTION_SELECTOR = '[role="option"]:visible, [class*="select__option"]:visible, [class*="menu"] [class*="option"]:visible, [role="listbox"] li:visible';

/**
 * Type into an autocomplete widget and pick the closest visible option. Autocompletes usually
 * want a prefix ("Austin") rather than the full value ("Austin, Texas"), so we try the first
 * segment first and the full value second, matching the suggestions against the full value.
 */
async function fillCombobox(page: Page, input: Locator, value: string): Promise<void> {
  const probes = Array.from(new Set([value.split(/[,(]/)[0]?.trim() || value, value]));
  let lastSeen: string[] = [];
  for (const probe of probes) {
    await input.click();
    await input.fill("").catch(() => undefined);
    await page.keyboard.type(probe, { delay: 20 });
    const options = page.locator(OPTION_SELECTOR);
    try {
      await options.first().waitFor({ state: "visible", timeout: 3000 });
    } catch {
      continue;
    }
    // Let the list settle (remote autocompletes stream results in).
    await page.waitForTimeout(250);
    const texts = (await options.allInnerTexts()).map((t) => t.trim());
    lastSeen = texts;
    const idx = texts.map((t, i) => ({ t, i })).filter((o) => o.t && !/no (results|options)|loading/i.test(o.t));
    const best = bestMatch(value, idx, (o) => o.t, 0.5);
    if (best) {
      await options.nth(best.item.i).click();
      return;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  if (lastSeen.length) throw new Error(`no suggestion resembles "${value}" (saw: ${lastSeen.slice(0, 5).join(" | ")})`);
  // No dropdown ever appeared; maybe it's a free-text input with optional suggestions. Keep the typed value.
  await input.fill(value).catch(() => undefined);
  await page.keyboard.press("Enter").catch(() => undefined);
  const typed = await input.inputValue().catch(() => "");
  if (!typed) throw new Error("no suggestions appeared");
}

function toIsoDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toISOString().slice(0, 10);
}

/** Click the form's submit control and wait for the page to settle. */
export async function clickSubmit(page: Page): Promise<boolean> {
  const candidates = [
    page.locator('form button[type="submit"]:visible'),
    page.locator('form input[type="submit"]:visible'),
    page.getByRole("button", { name: /submit application|submit|apply now|send application|apply/i }),
    page.locator('button[type="submit"]:visible'),
  ];
  for (const c of candidates) {
    if ((await c.count()) > 0) {
      await c.first().scrollIntoViewIfNeeded();
      await c.first().click();
      await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

const CONFIRMATION = /thank you for (applying|your application|submitting)|application (has been )?(submitted|received|sent)|we('ve| have) received your application|successfully submitted/i;

export async function looksSubmitted(page: Page): Promise<boolean> {
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  if (CONFIRMATION.test(text)) return true;
  if (/confirmation|thank[-_]?you|success/i.test(page.url())) return true;
  return false;
}
