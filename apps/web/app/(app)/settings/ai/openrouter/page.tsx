import { OpenRouterCallback } from "@/components/settings/openrouter-callback";
import { PageHeader } from "@/components/settings/ui";

// OpenRouter sends the browser back here with ?code=…&state=… after the
// admin approves. The page hands both to the API through the same-origin
// bridge; the key itself never reaches the browser.
export default async function OpenRouterCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Connect OpenRouter" />
      <OpenRouterCallback code={one(sp.code)} state={one(sp.state)} />
    </main>
  );
}
