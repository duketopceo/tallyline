import type { ReactNode } from "react";

// Shell for the public legal/trust pages. Every page carries the draft
// notice until the owner has had them reviewed (PLAN-016).
export function LegalDoc({
  title,
  updated,
  updatedLabel = "Last updated",
  summary,
  draft = true,
  children,
}: {
  title: string;
  updated: string;
  updatedLabel?: string;
  summary: ReactNode;
  draft?: boolean;
  children: ReactNode;
}) {
  return (
    <article className="max-w-[72ch]">
      <h1 className="text-[24px] font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 font-mono text-[11px] text-ink-tertiary">{updatedLabel} {updated}</p>
      {draft && (
        <p
          role="note"
          className="mt-4 rounded-sm border border-lining bg-attention-soft px-3 py-2 text-[13px] text-ink"
        >
          <strong className="font-semibold">Draft, not legal advice.</strong> This page is a
          plain-language draft written for review. It has not been checked by a lawyer and may
          change before Tallyline offers a hosted service.
        </p>
      )}
      <div className="mt-6 text-[14px] leading-6 text-ink-muted">{summary}</div>
      <div className="mt-2">{children}</div>
    </article>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="text-[15px] font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-2 space-y-3 text-[14px] leading-6 text-ink-muted [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_li]:ml-5 [&_ul]:list-disc [&_ul]:space-y-1">
        {children}
      </div>
    </section>
  );
}
