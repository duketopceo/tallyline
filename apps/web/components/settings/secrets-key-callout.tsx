import { Notice } from "./ui";
import { SECRETS_KEY_CALLOUT } from "@/lib/secrets-key";

/**
 * Settings → AI and Settings → Providers: a 503 SECRETS_KEY_MISSING is an
 * operator instruction, never a generic failure toast.
 */
export function SecretsKeyCallout() {
  return (
    <Notice tone="attention" title={SECRETS_KEY_CALLOUT.title}>
      <p>{SECRETS_KEY_CALLOUT.body}</p>
    </Notice>
  );
}
