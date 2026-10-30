import { HttpError } from "../lib/errors.js";
import { complete, resolveProvider } from "./ai-providers.js";
import type { LLMProvider } from "./llm.js";

// S3-U4: every model call goes through the workspace's own provider (or the
// server's env provider when the workspace hasn't connected one), so the
// monthly cap and the usage ledger apply to assist and agent actions alike.

/** an LLMProvider bound to one workspace and one ledger action name */
export function workspaceLLM(workspaceId: string, action: string): LLMProvider {
  return {
    async complete(opts) {
      const r = await complete(workspaceId, action, opts);
      return r.text;
    },
  };
}

/** true when some provider would answer for this workspace */
export async function aiEnabledFor(workspaceId: string): Promise<boolean> {
  try {
    return (await resolveProvider(workspaceId)) !== null;
  } catch {
    // a stored key that can't be decrypted is still "configured"; calls
    // will fail with the plain AI_KEY_UNREADABLE message
    return true;
  }
}

/** route-layer kill switch: 503 with a pointer to Settings > AI */
export async function requireAi(workspaceId: string): Promise<void> {
  if (!(await aiEnabledFor(workspaceId))) {
    throw new HttpError(
      503,
      "LLM_DISABLED",
      "AI is off for this workspace. An admin can connect a provider in Settings, AI.",
    );
  }
}
