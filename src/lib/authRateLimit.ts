/**
 * In-memory login rate limiter.
 *
 * Two buckets are maintained per request:
 *  - ip + username: max 5 attempts per 15 minutes (brute-force protection
 *    for a single account from a single network).
 *  - ip alone:      a loose cap of 20 per 15 minutes, so a shared network
 *    (family wifi, school NAT, local dev where every request is "unknown")
 *    can't be used to spray many different accounts.
 *
 * Keying by ip+username (instead of IP alone) means one child fumbling
 * their password no longer locks siblings/classmates behind the same IP.
 *
 * On every check it sweeps timestamps older than the window and evicts
 * empty buckets; the whole Map is hard-capped at 10,000 entries (oldest
 * buckets by most-recent attempt are dropped first).
 */

const MAX_PER_ACCOUNT = 5;
const MAX_PER_IP = 20;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 10_000;

const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  blocked: boolean;
  remaining: number;
  retryAfterSec: number;
}

function accountKey(ip: string, username: string): string {
  return `acct:${ip}\u0000${username.toLowerCase()}`;
}

function ipKey(ip: string): string {
  return `ip:${ip}`;
}

function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  for (const [key, timestamps] of buckets) {
    const fresh = timestamps.filter((ts) => ts > cutoff);
    if (fresh.length === 0) {
      buckets.delete(key);
    } else if (fresh.length !== timestamps.length) {
      buckets.set(key, fresh);
    }
  }
}

export function checkLoginRateLimit(
  ip: string,
  username: string,
  now = Date.now()
): RateLimitResult {
  prune(now);

  // Hard cap: evict oldest buckets when the map grows too large.
  if (buckets.size >= MAX_ENTRIES) {
    const sorted = [...buckets.entries()].sort(
      (a, b) => Math.max(...a[1]) - Math.max(...b[1])
    );
    const excess = buckets.size - MAX_ENTRIES + 1;
    for (let i = 0; i < excess; i++) {
      const key = sorted[i]?.[0];
      if (key) buckets.delete(key);
    }
  }

  const cutoff = now - WINDOW_MS;
  const aKey = accountKey(ip, username);
  const iKey = ipKey(ip);
  const accountAttempts = (buckets.get(aKey) ?? []).filter((ts) => ts > cutoff);
  const ipAttempts = (buckets.get(iKey) ?? []).filter((ts) => ts > cutoff);

  // Per-account lockout takes priority; retry hint comes from its oldest try.
  if (accountAttempts.length >= MAX_PER_ACCOUNT) {
    const oldest = accountAttempts[0];
    return {
      blocked: true,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }

  if (ipAttempts.length >= MAX_PER_IP) {
    const oldest = ipAttempts[0];
    return {
      blocked: true,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
    };
  }

  accountAttempts.push(now);
  ipAttempts.push(now);
  buckets.set(aKey, accountAttempts);
  buckets.set(iKey, ipAttempts);

  return {
    blocked: false,
    remaining: Math.max(
      0,
      MAX_PER_ACCOUNT - accountAttempts.length,
      MAX_PER_IP - ipAttempts.length
    ),
    retryAfterSec: 0,
  };
}

/** Forget the failed-attempt streak after a successful password check. */
export function clearLoginAttempts(ip: string, username: string): void {
  buckets.delete(accountKey(ip, username));
}

/** Test/maintenance helper. */
export function resetLoginRateLimit(): void {
  buckets.clear();
}
