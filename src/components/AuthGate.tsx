"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/authStore";

const AUTH_PATHS = new Set(["/login", "/register"]);

function Splash() {
  return (
    <div className="app-height app-bg flex flex-col items-center justify-center gap-4">
      <div className="flex h-20 w-20 animate-pulse items-center justify-center rounded-full bg-white text-4xl shadow-sm">
        🐣
      </div>
      <p className="text-sm font-semibold text-gray-400">Loading English Buddy…</p>
    </div>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isAuthPage = AUTH_PATHS.has(pathname);

  // Client-side safety net (the server proxy handles the first load).
  useEffect(() => {
    if (status === "loading") return;
    if (!user && !isAuthPage) {
      router.replace("/login");
    } else if (user && isAuthPage) {
      router.replace("/");
    }
  }, [status, user, isAuthPage, router]);

  if (status === "loading") {
    return <Splash />;
  }

  if (!user && !isAuthPage) {
    return <Splash />;
  }

  if (user && isAuthPage) {
    return <Splash />;
  }

  return <>{children}</>;
}
