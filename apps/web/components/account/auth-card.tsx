import type { ReactNode } from "react";
import { TallyMark } from "@/components/tally-mark";

// the signed-out card shell shared by sign-in-adjacent pages
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-md border border-lining bg-surface-1 p-6">
        <div className="flex items-center gap-2">
          <TallyMark size={24} />
          <span className="text-[15px] font-semibold tracking-tight">tallyline</span>
        </div>
        <h1 className="mt-2 text-[17px] font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
