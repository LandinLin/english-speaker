import type { ReactNode } from "react";
import BottomNav from "@/components/BottomNav";

export default function TabsLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="app-height flex flex-col bg-[#f7f8fa]"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        // Bottom padding handled by the nav's own safe-area inset.
      }}
    >
      <div className="min-h-0 flex-1">{children}</div>
      <BottomNav />
    </div>
  );
}
