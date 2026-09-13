"use client";

import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "installPromptDismissed";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  );
}

function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function recentlyDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < SEVEN_DAYS_MS;
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    // storage unavailable — banner just hides for this session
  }
}

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null
  );
  const [visible, setVisible] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);
  const ios = isIosDevice();

  useEffect(() => {
    if (isStandalone() || recentlyDismissed()) return;

    let timer: ReturnType<typeof setTimeout>;

    const handleBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      // Wait a beat so the banner doesn't pop immediately on first visit.
      timer = setTimeout(() => setVisible(true), 1500);
    };

    const handleInstalled = () => {
      setVisible(false);
      setShowIosHelp(false);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleInstalled);

    // iOS never fires beforeinstallprompt — show the manual hint.
    if (ios) {
      timer = setTimeout(() => setVisible(true), 2500);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleInstalled);
      clearTimeout(timer);
    };
  }, [ios]);

  const dismiss = useCallback(() => {
    rememberDismissed();
    setVisible(false);
  }, []);

  const handleInstall = useCallback(async () => {
    if (ios) {
      setShowIosHelp(true);
      return;
    }
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    setVisible(false);
    if (choice.outcome === "dismissed") rememberDismissed();
  }, [deferred, ios]);

  if (!visible && !showIosHelp) return null;

  return (
    <>
      {/* Bottom banner — sits above the mic button */}
      {visible && (
        <div className="fixed inset-x-3 bottom-28 z-40 mx-auto max-w-md animate-[fadeIn_0.3s_ease] rounded-2xl border border-blue-100 bg-white/95 p-3 shadow-xl backdrop-blur">
          <div className="flex items-center gap-3">
            <span className="text-3xl">📱</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-gray-800">
                Install English Buddy
              </p>
              <p className="text-xs text-gray-500">
                Practice speaking even when you&apos;re offline!
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-1.5">
              <button
                type="button"
                onClick={handleInstall}
                className="rounded-full bg-blue-500 px-4 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-blue-600"
              >
                Install
              </button>
              <button
                type="button"
                onClick={dismiss}
                className="rounded-full px-4 py-1 text-xs font-medium text-gray-400 transition-colors hover:text-gray-600"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* iOS manual-install modal */}
      {showIosHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5"
          onClick={() => setShowIosHelp(false)}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-4xl">📱</p>
            <h2 className="mt-2 text-lg font-bold text-gray-800">
              Add English Buddy to your Home Screen
            </h2>
            <div className="mt-4 space-y-3 text-left">
              <div className="flex items-center gap-3 rounded-2xl bg-blue-50 p-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500 text-lg text-white">
                  1
                </span>
                <p className="text-sm text-gray-700">
                  Tap the{" "}
                  <span className="font-bold">
                    Share{" "}
                    <span className="inline-block rounded-md border border-blue-300 px-1.5 text-base leading-none">
                      ⬆️
                    </span>
                  </span>{" "}
                  button in Safari&apos;s toolbar
                </p>
              </div>
              <div className="flex items-center gap-3 rounded-2xl bg-purple-50 p-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-500 text-lg text-white">
                  2
                </span>
                <p className="text-sm text-gray-700">
                  Choose{" "}
                  <span className="font-bold">
                    <span className="inline-block rounded-md border border-purple-300 px-1.5 text-base leading-none">
                      ➕
                    </span>{" "}
                    Add to Home Screen
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-3 rounded-2xl bg-amber-50 p-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-400 text-lg text-white">
                  3
                </span>
                <p className="text-sm text-gray-700">
                  Tap <span className="font-bold">Add</span>, then open Buddy
                  from your home screen like an app! 🎉
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowIosHelp(false);
                dismiss();
              }}
              className="mt-5 w-full rounded-full bg-blue-500 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-blue-600"
            >
              Got it!
            </button>
          </div>
        </div>
      )}
    </>
  );
}
