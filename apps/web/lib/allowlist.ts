/** Login allowlist (D2): single operator now; comma-separated emails in env. */
export function isAllowedEmail(email: string): boolean {
  const raw = process.env.ALLOWED_EMAILS ?? "";
  const allowed = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(email.trim().toLowerCase());
}
