"use client";

import { useState } from "react";
import { AGENT_IDS, agentGuide, connectCommand, type AgentId } from "@/lib/agent-connect";
import { Panel, ghostBtn } from "./ui";

function CopyBlock({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="mt-2">
      <pre
        aria-label={label}
        className="select-all overflow-x-auto rounded-sm border border-lining bg-surface-2 px-3 py-2 font-mono text-xs text-ink"
      >
        {value}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={copy} className={ghostBtn}>
          {state === "copied" ? "Copied" : `Copy ${label}`}
        </button>
        {state === "failed" && (
          <span className="text-xs text-ink-subtle">Clipboard unavailable. Select the text and copy it.</span>
        )}
      </div>
    </div>
  );
}

export function ConnectAgentSteps({ apiUrl }: { apiUrl: string }) {
  const [id, setId] = useState<AgentId>("claude");
  const g = agentGuide(id, apiUrl);
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Coding agent" className="flex flex-wrap gap-2">
        {AGENT_IDS.map((a) => {
          const on = a === id;
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setId(a)}
              className={`rounded-sm border px-3 py-1.5 text-sm ${
                on ? "border-lining-bright bg-surface-2 text-ink" : "border-lining text-ink-subtle hover:text-ink"
              }`}
            >
              {agentGuide(a, apiUrl).label}
            </button>
          );
        })}
      </div>

      <Panel id="connect-step-1" title="1. Add Tallyline to the agent" hint="With the Tallyline CLI installed, run:">
        <CopyBlock label="command" value={connectCommand(id)} />
        <p className="mt-3 text-xs text-ink-subtle">
          It adds only the tallyline entry, keeps a backup, and can be undone with{" "}
          <code className="font-mono">tallyline agent undo {id}</code>.
        </p>
      </Panel>

      <Panel id="connect-step-1b" title="Or add it by hand" hint={`Put this in ${g.path}, next to any servers already there:`}>
        <CopyBlock label="config" value={g.snippet} />
      </Panel>

      <Panel id="connect-step-2" title="2. Sign in">
        <p className="mt-2 text-sm text-ink">{g.signIn}</p>
        <p className="mt-2 text-xs text-ink-subtle">
          A browser window opens. Approve it, and the agent can read and update issues in this workspace.
        </p>
      </Panel>
    </div>
  );
}
