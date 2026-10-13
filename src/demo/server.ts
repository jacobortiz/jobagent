/**
 * Tiny local server that hosts a realistic application form so the whole pipeline can be
 * exercised offline. The browser posts the final field values as JSON to /submit; the test
 * and the demo command read them back from /last.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface DemoServer {
  url: string;
  applyUrl: string;
  submissions: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startDemoServer(port = 0): Promise<DemoServer> {
  // src/demo/server.ts sits next to form.html; the compiled dist/ copy does not, so fall back to the source tree.
  const formPath = [path.join(here, "form.html"), path.resolve(here, "..", "..", "..", "src", "demo", "form.html")].find((p) => fs.existsSync(p));
  if (!formPath) throw new Error("demo form.html not found");
  const html = fs.readFileSync(formPath, "utf8");
  const submissions: Array<Record<string, unknown>> = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/jobs/demo" || url.pathname === "/jobs/demo/apply")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "POST" && url.pathname === "/submit") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          submissions.push(JSON.parse(body));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/last") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(submissions.at(-1) ?? null));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const base = `http://127.0.0.1:${actualPort}`;
  return {
    url: base,
    applyUrl: `${base}/jobs/demo/apply`,
    submissions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A minimal but valid single-page PDF, so the resume upload has a real file to send. */
export function writeTinyPdf(file: string, text = "Jane Doe - Resume"): void {
  const content = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out, "latin1");
}
