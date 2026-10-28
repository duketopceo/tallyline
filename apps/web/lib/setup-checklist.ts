// The first-run checklist, derived from GET /v1/workspaces/:ws/system/status.
// Pure so it can be tested: the page renders whatever this returns. Steps are
// never "failed" for something optional; an unconfigured backup or email is an
// attention state with the next action, not an error.

export interface SystemStatus {
  version: string | null;
  revision: string | null;
  database: { ok: boolean; latencyMs: number | null };
  backup: { state: "not_configured" | "none_yet" | "ok" | "stale"; lastBackupAt: string | null; ageHours: number | null };
  signIn: { password: boolean; providers: { key: string; label: string }[] };
  ai: { configured: boolean; provider: { label: string; model: string } | null; problem: string | null };
  email: { transport: string; configured: boolean };
  publicUrl: { webUrl: string; apiBaseUrl: string; issues: string[] };
  workspace: { members: number; agents: number; issues: number };
}

export type StepState = "done" | "attention" | "todo";

export interface Step {
  id: string;
  title: string;
  /** one plain sentence: what is true now */
  detail: string;
  state: StepState;
  /** where to go next; absent when there is nothing to do */
  href?: string;
  action?: string;
  /** optional steps never block "all set" */
  optional?: boolean;
}

export function adminChecklist(s: SystemStatus): Step[] {
  const steps: Step[] = [];
  steps.push(
    s.database.ok
      ? { id: "database", title: "Database", detail: "Connected and answering.", state: "done" }
      : { id: "database", title: "Database", detail: "The server cannot reach its database. Nothing will save until this is fixed.", state: "attention", href: "/status", action: "Open status" },
  );
  steps.push(
    s.publicUrl.issues.length === 0
      ? { id: "address", title: "Public address", detail: `People reach Tallyline at ${s.publicUrl.webUrl}.`, state: "done" }
      : { id: "address", title: "Public address", detail: s.publicUrl.issues[0]!, state: "attention", href: "/settings/workspace", action: "Review", },
  );
  const methods = s.signIn.providers.length;
  steps.push({
    id: "sign-in",
    title: "Sign-in",
    detail: s.signIn.password
      ? methods > 0
        ? `Email and password, plus ${s.signIn.providers.map((p) => p.label).join(", ")}.`
        : "Email and password. Add Google, GitHub or your company login if people expect it."
      : methods > 0
        ? `Single sign-on only: ${s.signIn.providers.map((p) => p.label).join(", ")}.`
        : "Password sign-in is off and no other method is set up, so nobody can sign in.",
    state: !s.signIn.password && methods === 0 ? "attention" : "done",
    ...(methods === 0 ? { href: "/settings/providers", action: "Set up sign-in" } : {}),
  });
  steps.push(
    s.email.configured
      ? { id: "email", title: "Email", detail: "Reset and verification emails are sent.", state: "done" }
      : { id: "email", title: "Email", detail: "Emails are only written to the server log, so people cannot reset a password or verify an address by email.", state: "attention", href: "/settings/workspace", action: "See how" },
  );
  const b = s.backup;
  steps.push(
    b.state === "ok"
      ? { id: "backups", title: "Backups", detail: `Last backup ${b.ageHours === null ? "recently" : `${b.ageHours} hours ago`}.`, state: "done" }
      : b.state === "stale"
        ? { id: "backups", title: "Backups", detail: `The last backup was ${Math.round(b.ageHours ?? 0)} hours ago. Check that the backup timer is running.`, state: "attention", href: "/settings/workspace", action: "See how" }
        : b.state === "none_yet"
          ? { id: "backups", title: "Backups", detail: "Backups are set up but none has finished yet.", state: "attention" }
          : { id: "backups", title: "Backups", detail: "Not set up. If this server is lost, so is your data.", state: "attention", href: "/settings/workspace", action: "See how" },
  );
  steps.push(
    s.ai.problem
      ? { id: "ai", title: "AI assistant", detail: "A provider is saved but its key cannot be read. Enter the key again.", state: "attention", optional: true, href: "/settings/providers", action: "Fix" }
      : s.ai.configured
        ? { id: "ai", title: "AI assistant", detail: `Using ${s.ai.provider?.label ?? "your provider"}${s.ai.provider ? ` (${s.ai.provider.model})` : ""}.`, state: "done", optional: true }
        : { id: "ai", title: "AI assistant", detail: "Optional. Connect OpenRouter or any compatible service to get summaries and suggestions.", state: "todo", optional: true },
  );
  steps.push(
    s.workspace.members > 1
      ? { id: "people", title: "Invite your team", detail: `${s.workspace.members} people are in this workspace.`, state: "done" }
      : { id: "people", title: "Invite your team", detail: "You are the only person here so far.", state: "todo", href: "/settings/invites", action: "Invite" },
  );
  steps.push(
    s.workspace.agents > 0
      ? { id: "agents", title: "Connect an agent", detail: `${s.workspace.agents} agent${s.workspace.agents === 1 ? "" : "s"} connected.`, state: "done", optional: true }
      : { id: "agents", title: "Connect an agent", detail: "Optional. Let a coding agent pick up and report on issues.", state: "todo", optional: true, href: "/settings/agents", action: "Connect" },
  );
  steps.push(
    s.workspace.issues > 0
      ? { id: "first-issue", title: "Create your first issue", detail: `${s.workspace.issues} issue${s.workspace.issues === 1 ? "" : "s"} so far.`, state: "done" }
      : { id: "first-issue", title: "Create your first issue", detail: "Press C anywhere to add one.", state: "todo", href: "/my-issues", action: "Open my issues" },
  );
  return steps;
}

/** What a member who is not an admin sees: nothing about the server, just how to start. */
export function memberChecklist(issueCount: number | null): Step[] {
  return [
    {
      id: "first-issue",
      title: "Create an issue",
      detail: issueCount && issueCount > 0 ? `${issueCount} issues in your list.` : "Press C anywhere to add one.",
      state: issueCount && issueCount > 0 ? "done" : "todo",
      href: "/my-issues",
      action: "Open my issues",
    },
    { id: "palette", title: "Try the command palette", detail: "Press Cmd+K (or Ctrl+K) to jump anywhere or run a command.", state: "todo" },
    { id: "notifications", title: "Check your inbox", detail: "Mentions and assignments land in Notifications.", state: "todo", href: "/notifications", action: "Open" },
  ];
}

export function progress(steps: Step[]): { done: number; required: number; allSet: boolean } {
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.state === "done").length;
  return { done, required: required.length, allSet: done === required.length };
}
