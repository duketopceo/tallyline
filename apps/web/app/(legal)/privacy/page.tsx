import type { Metadata } from "next";
import { LegalDoc, Section } from "@/components/legal-doc";

export const metadata: Metadata = {
  title: "Privacy · Tallyline",
  description: "What Tallyline collects, why, how long it is kept, and who to ask.",
};

export default function PrivacyPage() {
  return (
    <LegalDoc
      title="Privacy"
      updated="October 11, 2026"
      summary={
        <p>
          Tallyline is an issue tracker for people and AI agents. We collect what the product needs
          to work, we do not sell it, and we do not track you around the web. If you run Tallyline
          yourself, your data stays on your servers and nothing is sent to us.
        </p>
      }
    >
      <Section id="who" title="Who this covers">
        <p>
          This page covers the hosted service at tallyline.app (&ldquo;Tallyline Cloud&rdquo;) and
          this website. Self-hosted installs are run by whoever installed them; that operator decides
          how their data is handled. The self-hosted software sends no telemetry, ever.
        </p>
      </Section>

      <Section id="collect" title="What we collect">
        <ul>
          <li>
            <strong className="text-ink">Account details:</strong> your name, email address, and a
            password hash, or the identity your sign-in provider (GitHub, Google or your company SSO)
            shares with us.
          </li>
          <li>
            <strong className="text-ink">Workspace content:</strong> issues, comments, projects,
            cycles, labels and the activity log you and your agents create.
          </li>
          <li>
            <strong className="text-ink">Agent and integration data:</strong> agent names, hashed
            keys, run records, and the settings of integrations you connect (for example, which
            GitHub repositories are linked).
          </li>
          <li>
            <strong className="text-ink">Usage counts:</strong> per-workspace daily totals of
            members, agents, agent runs, API calls and storage. These are counts, not a record of
            what anyone did.
          </li>
          <li>
            <strong className="text-ink">Technical data:</strong> IP addresses held briefly for
            rate limiting and abuse prevention, and server error logs.
          </li>
        </ul>
      </Section>

      <Section id="use" title="How we use it">
        <ul>
          <li>To run the service: sign you in, show your workspace, deliver webhooks and run agents you dispatch.</li>
          <li>To keep it safe: rate limits, abuse prevention, and investigating security reports.</li>
          <li>To apply plan limits and, later, to bill for paid plans.</li>
          <li>To contact you about your account, security issues, or changes to these terms.</li>
        </ul>
        <p>
          We do not read your issues or comments for marketing, we do not train AI models on them,
          and we never sell personal data.
        </p>
      </Section>

      <Section id="cookies" title="Cookies and tracking">
        <p>This website and the app use only the cookies they need to work:</p>
        <ul>
          <li>
            <code className="font-mono text-[13px] text-ink">dok_session</code>: keeps you signed in
            (expires after 30 days).
          </li>
          <li>
            <code className="font-mono text-[13px] text-ink">dok_ws</code>: remembers which workspace
            you last opened.
          </li>
          <li>
            <code className="font-mono text-[13px] text-ink">sl-appearance</code>: remembers your theme
            on this device.
          </li>
        </ul>
        <p>
          There are no advertising cookies, no third-party analytics, no session replay and no
          tracking pixels.
        </p>
      </Section>

      <Section id="sharing" title="Who we share it with">
        <p>
          Only with the services that run Tallyline Cloud on our behalf (hosting, database and
          backups, and, once paid plans exist, a payment provider that handles card details so we
          never see them), and only what each needs. Integrations you connect, such as GitHub or
          Slack, receive what you ask Tallyline to send them. We will publish a list of these
          providers before the hosted service opens. We disclose data to authorities only when the
          law requires it.
        </p>
      </Section>

      <Section id="storage" title="Where it is stored and for how long">
        <p>
          The retention periods below are the ones we plan to apply when the hosted service opens;
          the owner will confirm them as part of reviewing this draft.
        </p>
        <ul>
          <li>Workspace content: for as long as the workspace exists. Deleting a workspace deletes its content.</li>
          <li>Sign-in sessions: up to 30 days, or until you sign out.</li>
          <li>Webhook delivery logs and raw integration events: about 30 days.</li>
          <li>Agent run logs: about 90 days.</li>
          <li>Backups roll off on a fixed schedule after deletion.</li>
        </ul>
        <p>Data is encrypted in transit. Secrets such as provider credentials are encrypted at rest.</p>
      </Section>

      <Section id="rights" title="Your choices">
        <p>
          You can ask for a copy of your data, ask us to correct it, or ask us to delete your account.
          Workspace owners can remove members and delete workspace content. Email us and we will
          answer within 30 days.
        </p>
      </Section>

      <Section id="contact" title="Contact">
        <p>
          Privacy questions: <a href="mailto:privacy@tallyline.app">privacy@tallyline.app</a>.
          Security reports: see the <a href="/security">security page</a>.
        </p>
      </Section>
    </LegalDoc>
  );
}
