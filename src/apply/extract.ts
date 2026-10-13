import type { Page } from "playwright";
import type { FormField } from "../types.js";
import { ensurePageHelpers } from "./page-helpers.js";

/**
 * Runs inside the page. Walks every input-like element, stamps a stable `data-ja-ref`
 * attribute so the filler can target it later, and returns a serializable description with
 * the best label we can infer. Must stay self-contained (no imports, no closures over Node
 * state) because Playwright serializes the function source.
 */
function extractInPage(): FormField[] {
  const REF_ATTR = "data-ja-ref";
  const w = window as unknown as { __jaRef?: number };
  w.__jaRef = w.__jaRef ?? 0;

  const clean = (s: string | null | undefined): string =>
    (s ?? "")
      .replace(/\s+/g, " ")
      .replace(/\s*\*+\s*$/, "")
      .replace(/^\*+\s*/, "")
      .replace(/\((required|optional)\)/i, "")
      .replace(/\brequired\b\s*$/i, "")
      .trim();

  const textOf = (el: Element | null): string => clean((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "");

  const isVisible = (el: Element): boolean => {
    const he = el as HTMLElement;
    const style = window.getComputedStyle(he);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const r = he.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const ref = (el: Element): string => {
    let r = el.getAttribute(REF_ATTR);
    if (!r) {
      r = `f${++w.__jaRef!}`;
      el.setAttribute(REF_ATTR, r);
    }
    return r;
  };

  const byIds = (ids: string | null): string => {
    if (!ids) return "";
    return clean(
      ids
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean)
        .join(" "),
    );
  };

  /** Text of the nearest preceding "labelish" element while walking up the tree. */
  const precedingText = (start: Element, maxDepth = 6): string => {
    let node: Element | null = start;
    for (let depth = 0; node && depth < maxDepth; depth++) {
      let sib: Element | null = node.previousElementSibling;
      while (sib) {
        if (!sib.querySelector("input,select,textarea,button") || sib.matches("label,legend")) {
          const t = textOf(sib);
          if (t && t.length <= 240) return t;
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
      if (node && (node.tagName === "FORM" || node.tagName === "BODY")) break;
    }
    return "";
  };

  const labelFor = (el: Element): { label: string; raw: string } => {
    const he = el as HTMLInputElement;
    const candidates: string[] = [];
    const push = (s: string | null | undefined) => {
      if (s && s.trim()) candidates.push(s.trim());
    };
    push(byIds(el.getAttribute("aria-labelledby")));
    push(el.getAttribute("aria-label"));
    if (he.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(he.id)}"]`);
      push(textOf(lab));
    }
    const wrapping = el.closest("label");
    if (wrapping) {
      const clone = wrapping.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("input,select,textarea").forEach((n) => n.remove());
      push(clean(clone.innerText ?? clone.textContent));
    }
    if (!candidates.length) push(precedingText(el));
    if (!candidates.length) push(el.getAttribute("placeholder"));
    if (!candidates.length) push(el.getAttribute("name")?.replace(/[_\-[\]]+/g, " "));
    const raw = candidates[0] ?? "";
    return { label: clean(raw), raw };
  };

  const sectionOf = (el: Element): string | null => {
    const fs = el.closest("fieldset");
    const legend = fs?.querySelector("legend");
    if (legend) return textOf(legend) || null;
    // Nearest preceding heading in document order.
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]"));
    let best: Element | null = null;
    for (const h of headings) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    }
    return best ? textOf(best) || null : null;
  };

  const requiredOf = (el: Element, rawLabel: string): boolean => {
    if ((el as HTMLInputElement).required) return true;
    if (el.getAttribute("aria-required") === "true") return true;
    if (/\*/.test(rawLabel)) return true;
    const container = el.closest("[class*=required], [data-required=true]");
    if (container && container !== document.body) return true;
    const lab = (el as HTMLInputElement).id ? document.querySelector(`label[for="${CSS.escape((el as HTMLInputElement).id)}"]`) : null;
    if (lab && (lab.querySelector("[class*=required], .asterisk") || /\*/.test(lab.textContent ?? ""))) return true;
    return false;
  };

  const fields: FormField[] = [];
  const seen = new Set<Element>();
  const groupedRadios = new Map<string, HTMLInputElement[]>();
  const groupedChecks = new Map<string, HTMLInputElement[]>();

  const all = Array.from(document.querySelectorAll("input, select, textarea, [role=combobox], [role=textbox][contenteditable], [contenteditable=true]"));

  for (const el of all) {
    if (seen.has(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (tag === "input" && ["hidden", "submit", "button", "reset", "image", "password"].includes(type)) continue;
    const isFile = tag === "input" && type === "file";
    if (!isFile && !isVisible(el)) continue;
    if (el.closest("[aria-hidden=true]") && !isFile) continue;

    if (tag === "input" && type === "radio") {
      const key = (el as HTMLInputElement).name || `radio-${ref(el.closest("fieldset,[role=radiogroup],div") ?? el)}`;
      const list = groupedRadios.get(key) ?? [];
      list.push(el as HTMLInputElement);
      groupedRadios.set(key, list);
      seen.add(el);
      continue;
    }
    if (tag === "input" && type === "checkbox") {
      const grp = el.closest("fieldset,[role=group]");
      const key = grp ? `grp-${ref(grp)}` : (el as HTMLInputElement).name || `chk-${ref(el)}`;
      const list = groupedChecks.get(key) ?? [];
      list.push(el as HTMLInputElement);
      groupedChecks.set(key, list);
      seen.add(el);
      continue;
    }
    seen.add(el);

    const { label, raw } = labelFor(el);
    let kind: FormField["kind"] = "unknown";
    let options: FormField["options"] = [];
    let value: string | null = null;

    if (tag === "select") {
      kind = "select";
      const sel = el as HTMLSelectElement;
      options = Array.from(sel.options).map((o) => ({ label: clean(o.textContent), value: o.value }));
      value = sel.selectedIndex >= 0 ? textOf(sel.options[sel.selectedIndex] ?? null) : null;
    } else if (tag === "textarea") {
      kind = "textarea";
      value = (el as HTMLTextAreaElement).value || null;
    } else if (el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox") {
      kind = "textarea";
      value = textOf(el) || null;
    } else if (isFile) {
      kind = "file";
      value = (el as HTMLInputElement).files?.[0]?.name ?? null;
    } else if (
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-autocomplete") === "list" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      (el.closest("[class*=select__control], [class*=combobox], [class*=autocomplete], [class*=Select-control]") !== null && tag === "input")
    ) {
      kind = "combobox";
      value = (el as HTMLInputElement).value || null;
      // react-select renders the chosen value in a sibling span rather than the input.
      if (!value) {
        const control = el.closest("[class*=select__control], [class*=Select-control]");
        const single = control?.querySelector("[class*=single-value], [class*=singleValue], [class*=Select-value-label]");
        value = textOf(single ?? null) || null;
      }
    } else if (tag === "input") {
      const map: Record<string, FormField["kind"]> = { email: "email", tel: "tel", url: "url", number: "number", date: "date", text: "text", search: "text" };
      kind = map[type] ?? "text";
      value = (el as HTMLInputElement).value || null;
      const listId = el.getAttribute("list");
      if (listId) {
        const dl = document.getElementById(listId);
        if (dl) options = Array.from(dl.querySelectorAll("option")).map((o) => ({ label: clean(o.textContent) || o.value, value: o.value }));
      }
    }

    fields.push({
      ref: ref(el),
      label,
      kind,
      name: el.getAttribute("name"),
      id: (el as HTMLElement).id || null,
      placeholder: el.getAttribute("placeholder"),
      autocomplete: el.getAttribute("autocomplete"),
      required: requiredOf(el, raw),
      options,
      section: sectionOf(el),
      value,
      accept: isFile ? el.getAttribute("accept") : null,
    });
  }

  const groupLabel = (inputs: HTMLInputElement[]): { label: string; raw: string } => {
    const first = inputs[0]!;
    // 1. Explicit accessible name on the group.
    const grp = first.closest("[role=radiogroup],[role=group]");
    if (grp) {
      const ll = byIds(grp.getAttribute("aria-labelledby")) || grp.getAttribute("aria-label");
      if (ll) return { label: clean(ll), raw: ll };
    }
    // 2. A fieldset dedicated to this group (its legend is the question). A fieldset that
    //    also holds other inputs is a section, and its legend is handled by sectionOf().
    const fs = first.closest("fieldset");
    const legend = fs?.querySelector("legend");
    if (fs && legend) {
      const others = Array.from(fs.querySelectorAll("input,select,textarea")).filter((i) => !inputs.includes(i as HTMLInputElement));
      if (others.length === 0) {
        const t = textOf(legend);
        return { label: clean(t), raw: legend.textContent ?? t };
      }
    }
    // Common ancestor of all inputs, then look for preceding text.
    let anc: Element | null = first.parentElement;
    while (anc && !inputs.every((i) => anc!.contains(i))) anc = anc.parentElement;
    const optionLabels = new Set(inputs.map((i) => labelFor(i).label));
    let node: Element | null = anc;
    for (let depth = 0; node && depth < 5; depth++) {
      // Text nodes/elements inside the ancestor that precede the first input and are not option labels.
      const texts = Array.from(node.children)
        .filter((c) => c.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)
        .filter((c) => !c.contains(first) && !c.querySelector("input"))
        .map(textOf)
        .filter((t) => t && !optionLabels.has(t) && t.length <= 240);
      if (texts.length) {
        const t = texts[texts.length - 1]!;
        return { label: clean(t), raw: t };
      }
      const pt = precedingText(node, 1);
      if (pt && !optionLabels.has(pt)) return { label: clean(pt), raw: pt };
      node = node.parentElement;
    }
    if (legend) {
      const t = textOf(legend);
      return { label: clean(t), raw: legend.textContent ?? t };
    }
    return { label: clean(first.name.replace(/[_\-[\]]+/g, " ")), raw: first.name };
  };

  for (const [, inputs] of groupedRadios) {
    const visible = inputs.filter((i) => isVisible(i) || isVisible(i.closest("label") ?? i));
    if (!visible.length) continue;
    const { label, raw } = groupLabel(visible);
    const options = visible.map((i) => ({ label: labelFor(i).label || i.value, value: i.value, ref: ref(i) }));
    const checked = visible.find((i) => i.checked);
    fields.push({
      ref: ref(visible[0]!),
      label,
      kind: "radio",
      name: visible[0]!.name || null,
      id: null,
      placeholder: null,
      autocomplete: null,
      required: visible.some((i) => requiredOf(i, raw)),
      options,
      section: sectionOf(visible[0]!),
      value: checked ? labelFor(checked).label || checked.value : null,
      accept: null,
    });
  }

  for (const [, inputs] of groupedChecks) {
    const visible = inputs.filter((i) => isVisible(i) || isVisible(i.closest("label") ?? i));
    if (!visible.length) continue;
    if (visible.length === 1) {
      const i = visible[0]!;
      const { label, raw } = labelFor(i);
      fields.push({
        ref: ref(i),
        label,
        kind: "checkbox",
        name: i.name || null,
        id: i.id || null,
        placeholder: null,
        autocomplete: null,
        required: requiredOf(i, raw),
        options: [],
        section: sectionOf(i),
        value: i.checked ? "true" : "false",
        accept: null,
      });
      continue;
    }
    const { label, raw } = groupLabel(visible);
    fields.push({
      ref: ref(visible[0]!),
      label,
      kind: "checkbox_group",
      name: visible[0]!.name || null,
      id: null,
      placeholder: null,
      autocomplete: null,
      required: visible.some((i) => requiredOf(i, raw)),
      options: visible.map((i) => ({ label: labelFor(i).label || i.value, value: i.value, ref: ref(i) })),
      section: sectionOf(visible[0]!),
      value: visible.filter((i) => i.checked).map((i) => labelFor(i).label).join("; ") || null,
      accept: null,
    });
  }

  // Keep document order so the plan reads top-to-bottom.
  const order = new Map<string, number>();
  document.querySelectorAll(`[${REF_ATTR}]`).forEach((el, i) => order.set(el.getAttribute(REF_ATTR)!, i));
  fields.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0));
  return fields;
}

export async function extractFields(page: Page): Promise<FormField[]> {
  await ensurePageHelpers(page);
  return page.evaluate(extractInPage);
}

/** Collect visible validation errors after a submit attempt. */
export async function collectValidationErrors(page: Page): Promise<string[]> {
  await ensurePageHelpers(page);
  return page.evaluate(() => {
    const out = new Set<string>();
    const sel = "[aria-invalid=true], [role=alert], .error, .field-error, .error-message, [class*=error]:not(input):not(select):not(textarea), [class*=Error]";
    document.querySelectorAll(sel).forEach((el) => {
      const he = el as HTMLElement;
      const r = he.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      let text = (he.innerText ?? "").trim();
      if (!text && el.getAttribute("aria-invalid") === "true") {
        const id = (el as HTMLInputElement).id;
        const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        text = `${(lab?.textContent ?? el.getAttribute("name") ?? "field").trim()}: invalid`;
      }
      if (text && text.length < 300) out.add(text.replace(/\s+/g, " "));
    });
    return Array.from(out).slice(0, 20);
  });
}
