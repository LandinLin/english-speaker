import { getUserByUsername } from "@/lib/db";
import { startSession, verifyPassword } from "@/lib/auth";
import { checkLoginRateLimit, clearLoginAttempts } from "@/lib/authRateLimit";
import {
  validatePassword,
  validateUsername,
} from "@/lib/validation";

export const runtime = "nodejs";

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as LoginBody;
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");

    const ip = clientIp(request);
    // Limit per (ip, username) — see authRateLimit.ts for why not IP alone.
    const limit = checkLoginRateLimit(ip, username);
    if (limit.blocked) {
      console.warn(`🔒 [auth/login] Rate limit hit for ${username} @ IP ${ip}`);
      return Response.json(
        { error: "Too many tries. Please wait 15 minutes, then try again." },
        {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfterSec) },
        }
      );
    }

    if (validateUsername(username) || validatePassword(password)) {
      // Same generic error either way — don't reveal which field is wrong.
      return Response.json(
        { error: "Invalid username or password." },
        { status: 401 }
      );
    }

    const user = await getUserByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return Response.json(
        { error: "Invalid username or password." },
        { status: 401 }
      );
    }

    // Correct password — the failed streak no longer counts against them.
    clearLoginAttempts(ip, username);
    await startSession(user.id);
    console.log(`👤 [auth] User "${user.username}" logged in`);

    return Response.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      },
    });
  } catch (error) {
    console.error("❌ [auth/login] Failed:", error);
    return Response.json(
      { error: "Could not log in. Please try again!" },
      { status: 500 }
    );
  }
}
