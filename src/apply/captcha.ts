import type { Page } from "playwright";
import { ensurePageHelpers } from "./page-helpers.js";

export interface CaptchaCheck {
  present: boolean;
  kind: string | null;
}

/**
 * Detect common bot checks. We never attempt to solve or bypass them: when one is present
 * the agent pauses and hands the browser to the human.
 */
export async function detectCaptcha(page: Page): Promise<CaptchaCheck> {
  await ensurePageHelpers(page);
  const result = await page.evaluate(() => {
    const frames = Array.from(document.querySelectorAll("iframe"));
    const srcs = frames.map((f) => (f.getAttribute("src") ?? "").toLowerCase());
    const isVisible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const visibleSrc = frames.filter(isVisible).map((f) => (f.getAttribute("src") ?? "").toLowerCase());
    const probes: Array<[string, RegExp]> = [
      ["recaptcha", /recaptcha\/api2\/(anchor|bframe)/],
      ["hcaptcha", /hcaptcha\.com/],
      ["turnstile", /challenges\.cloudflare\.com/],
      ["arkose", /arkoselabs|funcaptcha/],
    ];
    for (const [kind, re] of probes) {
      // Invisible reCAPTCHA v3 badges are not a challenge; only count visible frames.
      if (visibleSrc.some((s) => re.test(s))) return { present: true, kind };
    }
    const bodyText = (document.body?.innerText ?? "").toLowerCase();
    if (/verify (that )?you are (a )?human|are you a robot|complete the security check|unusual traffic/.test(bodyText)) {
      return { present: true, kind: "challenge-page" };
    }
    if (srcs.length && document.querySelector(".g-recaptcha[data-size='normal'], .h-captcha")) {
      const el = document.querySelector(".g-recaptcha[data-size='normal'], .h-captcha") as HTMLElement | null;
      if (el && isVisible(el)) return { present: true, kind: "captcha-widget" };
    }
    return { present: false, kind: null };
  });
  return result;
}
