import { describe, expect, it } from "vitest";
import { bestMatch, levenshtein, pickBoolean, similarity } from "../src/util/fuzzy.js";
import { decodeEntities, htmlToText, normalize } from "../src/util/text.js";

describe("text", () => {
  it("decodes entities including double-escaped ones once per pass", () => {
    expect(decodeEntities("&lt;p&gt;a &amp;amp; b&lt;/p&gt;")).toBe("<p>a &amp; b</p>");
    expect(decodeEntities("&#39;x&#x27; &nbsp;y")).toBe("'x'  y");
  });

  it("turns html into readable text", () => {
    const t = htmlToText("<h2>About</h2><p>One<br>Two</p><ul><li>A</li><li>B</li></ul><script>x()</script>");
    expect(t).toBe("About\n\nOne\nTwo\n\n• A\n• B");
  });

  it("normalizes labels", () => {
    expect(normalize("  Why do you want to work HERE?* ")).toBe("why do you want to work here");
  });
});

describe("fuzzy", () => {
  it("computes edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("scores similar strings highly and different ones low", () => {
    expect(similarity("LinkedIn Profile", "LinkedIn profile URL")).toBeGreaterThan(0.75);
    expect(similarity("United States", "United States of America")).toBeGreaterThanOrEqual(0.85);
    expect(similarity("Gender", "Veteran Status")).toBeLessThan(0.4);
  });

  it("picks the best option above a threshold", () => {
    const opts = ["Male", "Female", "Decline To Self Identify"];
    expect(bestMatch("Decline to self-identify", opts, (o) => o)?.item).toBe("Decline To Self Identify");
    expect(bestMatch("Purple", opts, (o) => o)).toBeNull();
  });

  it("maps booleans to yes/no style options", () => {
    const yn = ["Yes", "No"];
    expect(pickBoolean(true, yn, (o) => o)).toBe("Yes");
    expect(pickBoolean(false, yn, (o) => o)).toBe("No");
    const auth = ["I am authorized to work in the US", "I am not authorized"];
    expect(pickBoolean(true, auth, (o) => o)).toBe(auth[0]);
    expect(pickBoolean(false, auth, (o) => o)).toBe(auth[1]);
  });
});
