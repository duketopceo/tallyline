import { config_ } from "../env.js";
import { OpenRouterError } from "@openrouter/sdk/models/errors";
import { HttpError } from "../lib/errors.js";
import { modelChain, openRouterClient } from "./ai-providers.js";

// ── LLM provider interface ────────────────────────────────────────────
// The seam every model adapter implements. OpenRouter is the first-party
// impl (official @openrouter/sdk); other providers plug in the same way.

export interface LLMCompleteOpts {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMProvider {
  complete(opts: LLMCompleteOpts): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

const DEFAULT_MAX_TOKENS = 512;

export function llmEnabled(): boolean {
  return config_.llmApiKey.length > 0;
}

export function requireLLM(): void {
  if (!llmEnabled()) {
    throw new HttpError(
      503,
      "LLM_DISABLED",
      "LLM assist is off — set TALLYLINE_LLM_API_KEY to enable",
    );
  }
}

export function createOpenRouterProvider(): LLMProvider {
  return {
    async complete(opts) {
      const chain = modelChain({ kind: "openrouter", model: config_.llmModel, fallbacks: config_.llmFallbacks });
      let text: string | undefined;
      try {
        const r = await openRouterClient(config_.llmApiKey, config_.llmBaseUrl).chat.send({
          chatRequest: {
            model: config_.llmModel,
            ...(chain ? { models: chain } : {}),
            maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: opts.temperature ?? 0.2,
            messages: [
              ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
              { role: "user" as const, content: opts.user },
            ],
            stream: false,
          },
        });
        const content = r.choices[0]?.message.content;
        text = typeof content === "string" ? content.trim() : undefined;
      } catch (e) {
        const status = e instanceof OpenRouterError ? e.statusCode : 0;
        throw new HttpError(502, "LLM_UPSTREAM", `LLM request failed (${status || "unreachable"})`);
      }
      if (!text) {
        throw new HttpError(502, "LLM_UPSTREAM", "LLM returned no content");
      }
      return text;
    },
  };
}
