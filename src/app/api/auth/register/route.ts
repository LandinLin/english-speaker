import { randomUUID } from "node:crypto";
import {
  adoptOrphanMessages,
  countOrphanMessages,
  countUsers,
  createUser,
  getUserByUsername,
} from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import {
  validatePassword,
  validateUsername,
} from "@/lib/validation";

export const runtime = "nodejs";

interface RegisterBody {
  username?: unknown;
  password?: unknown;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as RegisterBody;
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");

    const usernameError = validateUsername(username);
    if (usernameError) {
      return Response.json({ error: usernameError }, { status: 400 });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return Response.json({ error: passwordError }, { status: 400 });
    }

    if (await getUserByUsername(username)) {
      return Response.json(
        { error: "That username is already taken. Try another one!" },
        { status: 409 }
      );
    }

    // Orphan (pre-auth) messages are adopted ONLY by the first user.
    const isFirstUser = (await countUsers()) === 0;
    const orphanCount = await countOrphanMessages();
    if (!isFirstUser && orphanCount > 0) {
      console.warn(
        `⚠️ [auth] ${orphanCount} orphan messages found during non-first registration; leaving them unassigned.`
      );
    }

    const user = await createUser({
      id: randomUUID(),
      username,
      displayName: username,
      passwordHash: hashPassword(password),
    });

    if (isFirstUser && orphanCount > 0) {
      const adopted = await adoptOrphanMessages(user.id);
      console.log(`🏠 [auth] First user adopted ${adopted} existing messages.`);
    }

    // NOTE: deliberately no session here — registration does NOT log the
    // user in. They are redirected to /login to sign in manually.
    console.log(`👤 [auth] Registered user "${user.username}" (${user.id})`);

    return Response.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
      },
    });
  } catch (error) {
    console.error("❌ [auth/register] Failed:", error);
    return Response.json(
      { error: "Could not create your account. Please try again!" },
      { status: 500 }
    );
  }
}
