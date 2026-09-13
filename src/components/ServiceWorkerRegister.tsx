"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js. Production only — caching the dev server would serve
 * stale Turbopack chunks and make development painful.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          console.log(
            "✅ [PWA] Service worker registered, scope:",
            registration.scope
          );
        })
        .catch((error) => {
          console.error("❌ [PWA] Service worker registration failed:", error);
        });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
  }, []);

  return null;
}
