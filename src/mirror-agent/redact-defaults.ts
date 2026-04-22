// Starter redaction regexes applied by the mirror-agent before events leave
// the host. Conservative on purpose — a narrow set of well-known formats.
// Users can add project-specific patterns via ~/.claude-net/redact.json or
// <cwd>/.claude-net/redact.json.
//
// IMPORTANT: redaction is a best-effort convenience, NOT a compliance control.
// Don't tell users it's safe to mirror regulated data — it's not.

export interface RedactRule {
  name: string;
  /** Regex source string (compiled with flags). */
  pattern: string;
  /** Regex flags (default "g"). */
  flags?: string;
  /**
   * Replacement string. Defaults to `«REDACTED:<name>»`. Non-global matches
   * only replace the first occurrence; use the default "g" for sweeping.
   */
  replacement?: string;
}

export const DEFAULT_REDACT_RULES: RedactRule[] = [
  {
    name: "aws-access-key",
    // AKIA + 16 alphanumeric. Well-known public prefix for AWS access keys.
    pattern: "\\bAKIA[0-9A-Z]{16}\\b",
  },
  {
    name: "github-pat",
    // Classic ghp_..., ghs_..., ghu_..., gho_... tokens (36 chars total body).
    pattern: "\\bgh[pousr]_[A-Za-z0-9]{36,}\\b",
  },
  {
    name: "anthropic-key",
    pattern: "\\bsk-ant-[A-Za-z0-9_\\-]{20,}\\b",
  },
  {
    name: "openai-key",
    // sk-... with at least 20 chars body. Broader than the Anthropic rule so
    // it only fires when the prefix + length are convincing.
    pattern: "\\bsk-(?!ant-)[A-Za-z0-9]{20,}\\b",
  },
  {
    name: "private-key-pem",
    // Match the BEGIN line; the whole block doesn't need to be redacted line
    // by line since seeing the header alone is enough to warn users.
    pattern: "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  },
  {
    name: "jwt",
    // Three base64url-ish segments. Narrow enough that random base64 strings
    // don't accidentally match.
    pattern:
      "\\beyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}\\b",
  },
];
