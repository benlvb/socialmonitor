/**
 * Rewrite user text that looks like prompt delimiters before interpolation.
 * A message containing "--- END OF INSTRUCTIONS ---" must not hijack the classifier.
 */
export function defangPromptMarkers(text: string): string {
  return (text ?? "")
    .replace(/^---+/gm, "—")
    .replace(/^===+/gm, "≡")
    .replace(/^\[([A-Z][A-Za-z /_-]+)\]$/gm, "($1)");
}

// C0 control characters + DEL, built from escape text to keep source ASCII-clean.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

/** Collapse to a single line; strip control characters. For few-shot / shortlist rendering. */
export function flattenForPrompt(text: string, maxChars?: number): string {
  const flat = String(text ?? "")
    .replace(CONTROL_CHARS, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
  return maxChars ? flat.slice(0, maxChars) : flat;
}
