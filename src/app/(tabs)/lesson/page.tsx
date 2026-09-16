"use client";

import { useRouter } from "next/navigation";
import LessonMode from "@/components/LessonMode";

export default function LessonPage() {
  const router = useRouter();

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <LessonMode onExit={() => router.push("/")} />
    </main>
  );
}
