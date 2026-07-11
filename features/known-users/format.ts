/**
 * Pure presentation helpers for known users. No server or DB imports, so both
 * Server Components and Client Components (owner dropdown, users table) can use
 * them.
 */

export interface KnownUserLabelParts {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  userId: string;
}

/** Human label for a known user: name, @username, or a fallback id. */
export function formatKnownUserLabel(user: KnownUserLabelParts): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  if (name && user.username) return `${name} (@${user.username})`;
  if (name) return name;
  if (user.username) return `@${user.username}`;
  return `User ${user.userId}`;
}
