/**
 * One JSON line per event, so `wrangler tail` and Workers Logs can filter on
 * `event` (e.g. `wrangler tail --search comment.`). Never pass a token in.
 */
type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};

/** Comment/DM text trimmed for logs: enough to debug a match, not a transcript. */
export function preview(text: string | undefined, max = 80): string | undefined {
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
