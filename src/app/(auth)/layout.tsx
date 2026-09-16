import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="app-height flex items-center justify-center overflow-y-auto bg-gradient-to-b from-blue-50 to-purple-50 px-4 py-8">
      {children}
    </div>
  );
}
