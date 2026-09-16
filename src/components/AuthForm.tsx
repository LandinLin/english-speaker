"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { login, register } from "@/lib/authStore";
import {
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
} from "@/lib/validation";

export default function AuthForm({
  mode,
  registered = false,
  initialUsername = "",
}: {
  mode: "login" | "register";
  /** True right after a successful registration — show a "please log in" note. */
  registered?: boolean;
  initialUsername?: string;
}) {
  const router = useRouter();
  const isRegister = mode === "register";

  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Synchronous guard: `submitting` state doesn't update within the same
  // tick, so an eager double-click could otherwise fire two login POSTs
  // (each one consuming a rate-limit slot).
  const inFlight = useRef(false);

  const clientError = (): string | null => {
    if (!USERNAME_PATTERN.test(username.trim())) {
      return isRegister
        ? "Username can use letters (including Chinese), numbers, _ or -, 2–20 characters."
        : "Please enter your username.";
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
    }
    return null;
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || inFlight.current) return;
    setError(null);

    const validationError = clientError();
    if (validationError) {
      setError(validationError);
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      if (isRegister) {
        // Account created, but no auto-login: go to the login page and let
        // the child sign in manually.
        await register(username.trim(), password);
        router.replace(
          `/login?registered=1&u=${encodeURIComponent(username.trim())}`
        );
      } else {
        await login(username.trim(), password);
        router.replace("/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong!");
      inFlight.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-sm rounded-3xl bg-white p-7 shadow-sm">
      <div className="mb-5 flex flex-col items-center gap-2 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-purple-100 text-3xl">
          🐣
        </div>
        <h1 className="text-xl font-bold text-gray-800">
          {isRegister ? "Create your account" : "Welcome back!"}
        </h1>
        <p className="text-sm text-gray-400">
          {isRegister
            ? "Sign up to save your chats and badges."
            : "Log in to continue practicing English."}
        </p>
      </div>

      <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-gray-500">Username</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            maxLength={20}
            placeholder="e.g. li_ming or 小明"
            className="h-12 rounded-2xl border border-gray-200 bg-gray-50 px-4 text-sm text-gray-800 outline-none transition-colors focus:border-blue-400 focus:bg-white"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-gray-500">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={isRegister ? "new-password" : "current-password"}
            placeholder={
              isRegister ? `At least ${PASSWORD_MIN_LENGTH} characters` : ""
            }
            className="h-12 rounded-2xl border border-gray-200 bg-gray-50 px-4 text-sm text-gray-800 outline-none transition-colors focus:border-blue-400 focus:bg-white"
          />
          {isRegister && (
            <span className="text-[11px] text-gray-400">
              Use at least {PASSWORD_MIN_LENGTH} characters you can remember.
            </span>
          )}
        </label>

        {registered && (
          <p className="rounded-xl bg-green-50 px-3 py-2 text-xs font-medium text-green-700">
            🎉 Account created! Please log in with your new account.
          </p>
        )}

        {error && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-600">
            ⚠️ {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-1 h-12 rounded-2xl bg-blue-500 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-600 disabled:opacity-60"
        >
          {submitting
            ? "Please wait…"
            : isRegister
              ? "✨ Create account"
              : "Log in"}
        </button>
      </form>

      <p className="mt-5 text-center text-xs text-gray-400">
        {isRegister ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="font-semibold text-blue-500">
              Log in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link href="/register" className="font-semibold text-blue-500">
              Create an account
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
