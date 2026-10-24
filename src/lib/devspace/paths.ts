/**
 * Project path policy. Project files live in the database (CodeWorkspace), not
 * on the host filesystem, so there is no server path to escape to — but paths
 * are still validated strictly because they are mounted into the sandbox and
 * shown to users. Pure; unit-tested.
 */

export const MAX_FILE_BYTES = 200 * 1024;
export const MAX_FILES = 500;
export const MAX_PATH = 200;

/** Files nobody edits through the workspace (secrets/config). Agents never; users only if policy allows (it doesn't, here). */
const PROTECTED = [/^\.env(\..*)?$/, /(^|\/)\.env(\..*)?$/, /(^|\/)\.npmrc$/, /(^|\/)id_(rsa|ed25519)(\.pub)?$/, /\.(pem|key|p12|pfx)$/i, /(^|\/)\.git(\/|$)/, /(^|\/)secrets?(\/|\.|$)/i];

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * Normalize and validate a project-relative path. Rejects absolute paths,
 * traversal, backslashes, NUL/control characters, empty segments, and
 * anything outside a conservative character set.
 */
export function normalizePath(input: string): string {
  if (typeof input !== "string" || !input.length) throw new PathError("Path is required");
  if (input.length > MAX_PATH) throw new PathError(`Path longer than ${MAX_PATH} characters`);
  if (/[\x00-\x1f\\]/.test(input)) throw new PathError("Path contains control characters or backslashes");
  if (input.startsWith("/") || /^[a-z]:/i.test(input)) throw new PathError("Absolute paths are not allowed");
  const parts = input.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new PathError("Path traversal or empty segments are not allowed");
  if (!/^[A-Za-z0-9._\-/@+]+$/.test(input)) throw new PathError("Path contains unsupported characters");
  return parts.join("/");
}

export function isProtected(path: string): boolean {
  return PROTECTED.some((re) => re.test(path));
}

export function assertWritable(path: string, content: string) {
  if (isProtected(path)) throw new PathError(`${path} is a protected file (secrets/configuration) and cannot be edited from the workspace`);
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new PathError(`File exceeds the ${MAX_FILE_BYTES / 1024} KB limit`);
  if (content.includes("\u0000")) throw new PathError("Binary content is not supported");
}
