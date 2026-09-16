/**
 * Isomorphic validation rules for signup/login (shared by the form
 * and the API routes).
 */

// Letters (incl. Chinese), numbers, underscore and hyphen; 2–20 chars.
export const USERNAME_PATTERN = /^[\p{L}\p{N}_-]{2,20}$/u;
export const PASSWORD_MIN_LENGTH = 8;

export function validateUsername(username: string): string | null {
  if (!username) return "Please enter a username.";
  if (!USERNAME_PATTERN.test(username)) {
    return "Username can use letters (including Chinese), numbers, _ or -, 2–20 characters.";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  }
  return null;
}
