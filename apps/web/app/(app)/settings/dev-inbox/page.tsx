import { SettingsTabs } from "@/components/settings-tabs";
import { api } from "@/lib/api";

interface Message {
  id: string;
  to: string;
  from: string;
  subject: string;
  text: string;
  kind: string;
  sentAt: string;
}

// Captured mail from the log transport (dev only). Links are rendered as
// plain text so the reader copies them deliberately.
export default async function DevInboxPage() {
  const res = await api<{ messages: Message[] }>("/v1/dev/mail");
  const messages = res.data?.messages ?? [];
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-lining-faint px-4">
        <h1 className="text-sm font-semibold">Dev inbox</h1>
        <SettingsTabs />
      </header>
      <div className="mx-auto w-full max-w-3xl space-y-3 p-4">
        {!res.ok ? (
          <p className="text-[13px] text-ink-subtle">
            {res.status === 404
              ? "The dev inbox is off: it only exists with MAIL_TRANSPORT=log outside production."
              : "Only instance admins can read the dev inbox."}
          </p>
        ) : messages.length === 0 ? (
          <p className="text-[13px] text-ink-subtle">
            No mail yet. Password reset and email confirmation messages appear here while MAIL_TRANSPORT=log.
          </p>
        ) : (
          <ul className="space-y-3" aria-label="Captured mail">
            {messages.map((m) => (
              <li key={m.id} className="rounded-md border border-lining bg-surface-1 p-4">
                <p className="text-[13px] font-medium text-ink">{m.subject}</p>
                <p className="mt-1 font-mono text-[11px] text-ink-subtle">
                  to {m.to} · {m.kind} · <time dateTime={m.sentAt}>{m.sentAt}</time>
                </p>
                <pre className="mt-3 whitespace-pre-wrap break-all font-mono text-[12px] text-ink-muted">{m.text}</pre>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
