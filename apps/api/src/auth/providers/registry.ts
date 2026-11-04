import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { authProviders } from "../../db/schema.js";
import { config_ } from "../../env.js";
import { decryptSecret } from "../secrets.js";
import { appleProvider, appleWebReady } from "./apple.js";
import { githubProvider } from "./github.js";
import { googleProvider, oidcProvider } from "./oidc.js";
import type { OAuthProvider } from "./types.js";

// test seam — stub providers for round-trip tests (no IdP network)
let testProviders: OAuthProvider[] | null = null;
export function __setProvidersForTests(p: OAuthProvider[] | null) {
  testProviders = p;
}

// Registry (KTD3/KTD7): env-defined providers first, then enabled
// auth_providers rows. An env key shadows a DB row of the same key — the
// row still exists (flagged env_shadowed by the admin API) but never loads.
export async function resolveProviders(): Promise<OAuthProvider[]> {
  if (testProviders) return testProviders;
  const out: OAuthProvider[] = [];

  if (config_.githubClientId) {
    out.push(
      githubProvider({
        key: "github",
        label: "GitHub",
        clientId: config_.githubClientId,
        clientSecret: config_.githubClientSecret,
        source: "env",
      }),
    );
  }
  if (config_.googleClientId) {
    out.push(
      googleProvider({
        key: "google",
        label: "Google",
        clientId: config_.googleClientId,
        clientSecret: config_.googleClientSecret,
        source: "env",
      }),
    );
  }
  if (appleWebReady(config_)) {
    out.push(
      appleProvider({
        key: "apple",
        label: "Apple",
        clientId: config_.appleClientId,
        teamId: config_.appleTeamId,
        keyId: config_.appleKeyId,
        privateKeyPem: config_.applePrivateKey,
        source: "env",
      }),
    );
  }
  if (config_.oidcIssuer && config_.oidcClientId) {
    out.push(
      oidcProvider({
        key: "oidc",
        type: "oidc",
        label: config_.oidcDisplayName || "SSO",
        issuer: config_.oidcIssuer,
        clientId: config_.oidcClientId,
        clientSecret: config_.oidcClientSecret,
        scopes: config_.oidcScopes.split(/\s+/).filter(Boolean),
        source: "env",
      }),
    );
  }

  const envKeys = new Set(out.map((p) => p.key));
  const rows = await db
    .select()
    .from(authProviders)
    .where(eq(authProviders.enabled, true));
  for (const row of rows) {
    if (envKeys.has(row.key)) continue; // env shadows (ENV_SHADOWED in admin API)
    const secret = row.clientSecretEnc
      ? decryptSecret(row.clientSecretEnc, config_.authSecretKey)
      : "";
    if (row.type === "github") {
      out.push(githubProvider({
        key: row.key, label: row.label, clientId: row.clientId,
        clientSecret: secret, source: "db",
      }));
    } else if (row.type === "apple") {
      // DB-configured Apple needs team/key/pem in claim_map or endpoints — skip until env path
      continue;
    } else {
      out.push(oidcProvider({
        key: row.key,
        type: row.type === "google" ? "google" : "oidc",
        label: row.label,
        issuer: row.type === "google" ? "https://accounts.google.com" : (row.issuer ?? ""),
        clientId: row.clientId,
        clientSecret: secret,
        scopes: row.scopes,
        source: "db",
      }));
    }
  }
  return out;
}

export async function getProvider(key: string): Promise<OAuthProvider | null> {
  const all = await resolveProviders();
  return all.find((p) => p.key === key) ?? null;
}
