import type { BrowserContext, Page } from "playwright";

/**
 * When this project runs through tsx/esbuild, functions passed to `page.evaluate` may contain
 * calls to esbuild's `__name` helper, which does not exist inside the browser. Defining a
 * no-op-ish shim in the page makes serialized functions work under both tsx and plain tsc output.
 */
export const KEEP_NAMES_SHIM = `globalThis.__name = globalThis.__name || function (target, value) {
  try { Object.defineProperty(target, "name", { value: value, configurable: true }); } catch (e) {}
  return target;
};`;

export async function installPageHelpers(context: BrowserContext): Promise<void> {
  await context.addInitScript(KEEP_NAMES_SHIM);
}

export async function ensurePageHelpers(page: Page): Promise<void> {
  await page.evaluate(KEEP_NAMES_SHIM);
}
