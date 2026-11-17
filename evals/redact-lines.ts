// The lines that feed the summary and the report are redacted BEFORE they are
// read. The safe writer redacts the files again, but the Markdown escapes
// signs inside a text (an underscore of a key, for one), and an escaped key no
// longer looks like a key to the redactor of the writer. Redacting first keeps
// the secret out of the report whatever the escape does. Pure.
import type { Redactor } from "../src/security/redact.js";
import { execucaoSchema, type ExecutionLine } from "./record.js";

function redactValue(value: unknown, redact: Redactor): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redact));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        redactValue(item, redact),
      ]),
    );
  }
  return value;
}

/** Every string of every line redacted; the result is checked by the schema. */
export function redactLines(
  lines: readonly ExecutionLine[],
  redact: Redactor,
): ExecutionLine[] {
  return lines.map((line) => execucaoSchema.parse(redactValue(line, redact)));
}
