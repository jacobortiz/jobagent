import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { installPageHelpers } from "./page-helpers.js";

export interface BrowserOptions {
  /** Directory for the persistent Chromium profile (cookies, logins survive between runs). */
  profileDir: string;
  headless: boolean;
  slowMo?: number;
}

/**
 * Launch a persistent browser context. Persistence matters for ATS sites that remember
 * the applicant or require a one-time email verification.
 */
export async function launchBrowser(opts: BrowserOptions): Promise<BrowserContext> {
  fs.mkdirSync(opts.profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(opts.profileDir, {
    headless: opts.headless,
    slowMo: opts.slowMo,
    viewport: { width: 1280, height: 1600 },
    acceptDownloads: false,
    // A plain desktop UA. We never try to disguise automation; sites that block it will
    // simply trigger the human-takeover path.
    locale: "en-US",
  });
  await installPageHelpers(context);
  return context;
}

export async function openPage(context: BrowserContext, url: string): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Give client-rendered ATS forms (Greenhouse/Ashby/Lever all hydrate with JS) a moment.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  return page;
}
