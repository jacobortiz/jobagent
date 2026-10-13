/** Minimal leveled logger with ANSI colors when attached to a TTY. */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let current: Level = (process.env.JOBAGENT_LOG as Level | undefined) ?? "info";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);

export const color = {
  dim: (s: string) => paint("2", s),
  bold: (s: string) => paint("1", s),
  green: (s: string) => paint("32", s),
  yellow: (s: string) => paint("33", s),
  red: (s: string) => paint("31", s),
  cyan: (s: string) => paint("36", s),
  magenta: (s: string) => paint("35", s),
};

export function setLogLevel(level: Level): void {
  current = level;
}

function emit(level: Level, prefix: string, args: unknown[]): void {
  if (ORDER[level] < ORDER[current]) return;
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(`${prefix} ${line}\n`);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", color.dim("·"), args),
  info: (...args: unknown[]) => emit("info", color.cyan("›"), args),
  success: (...args: unknown[]) => emit("info", color.green("✓"), args),
  warn: (...args: unknown[]) => emit("warn", color.yellow("!"), args),
  error: (...args: unknown[]) => emit("error", color.red("✗"), args),
};

/** Render rows as a padded text table. */
export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");
  const lines: string[] = [];
  if (header) {
    lines.push(color.bold(fmt(header)));
    lines.push(color.dim(widths.map((w) => "─".repeat(w)).join("  ")));
  }
  for (const row of rows) lines.push(fmt(row));
  return lines.join("\n");
}
