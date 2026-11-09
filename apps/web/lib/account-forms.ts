// Client-side checks for the account forms. The API repeats every rule; these
// only save a round trip and say what is wrong in plain words.

export const PASSWORD_MIN = 10;
export const NAME_MAX = 120;
const SLUG = /^[a-z0-9-]+$/;

export type ProfileBody = { name: string; avatarUrl: string | null };

export function validateProfile(
  name: string,
  avatarUrl: string,
): { ok: true; body: ProfileBody } | { ok: false; error: string } {
  const n = name.trim();
  if (n.length === 0) return { ok: false, error: "Enter a name." };
  if (n.length > NAME_MAX) return { ok: false, error: `Keep your name under ${NAME_MAX} characters.` };
  const a = avatarUrl.trim();
  if (a === "") return { ok: true, body: { name: n, avatarUrl: null } };
  let url: URL;
  try {
    url = new URL(a);
  } catch {
    return { ok: false, error: "The picture address must be a full web address starting with https://." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "The picture address must start with https://." };
  }
  if (a.length > 2048) return { ok: false, error: "That picture address is too long." };
  return { ok: true, body: { name: n, avatarUrl: a } };
}

export function validatePasswordChange(current: string, next: string, confirm: string): string | null {
  if (current === "") return "Enter your current password.";
  if (next.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for the new password.`;
  if (next === current) return "Choose a password different from the current one.";
  if (next !== confirm) return "The new password and its confirmation do not match.";
  return null;
}

export function validateSlug(slug: string): string | null {
  if (slug.length < 2) return "Use at least 2 characters.";
  if (slug.length > 48) return "Use at most 48 characters.";
  if (!SLUG.test(slug)) return "Use lowercase letters, numbers and hyphens only.";
  return null;
}
