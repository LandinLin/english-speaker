"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";

// The D-ID SDK is heavy and browser-only — load it only when this tab opens.
const DigitalHumanCall = dynamic(
  () => import("@/components/DigitalHumanCall"),
  { ssr: false }
);

export default function VideoPage() {
  const router = useRouter();

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <DigitalHumanCall
        open
        onClose={() => router.push("/")}
      />
    </main>
  );
}
