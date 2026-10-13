/**
 * Strip key-shaped fragments before they land in a job row or the app log.
 * Matches `sk-…` tokens and `Bearer …` authorization values.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-…")
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer …");
}
