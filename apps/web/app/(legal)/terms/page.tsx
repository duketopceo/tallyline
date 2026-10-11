import Link from "next/link";
import type { Metadata } from "next";
import { LegalDoc, Section } from "@/components/legal-doc";

export const metadata: Metadata = {
  title: "Terms · Tallyline",
  description: "The rules for using Tallyline Cloud and this website.",
};

export default function TermsPage() {
  return (
    <LegalDoc
      title="Terms of service"
      updated="October 11, 2026"
      summary={
        <p>
          The short version: the Tallyline software is free and open source under the MIT license.
          These terms cover the hosted service at tallyline.app. Use it lawfully, keep your keys
          safe, and understand that it is in beta.
        </p>
      }
    >
      <Section id="software" title="The software">
        <p>
          The Tallyline source code is licensed under the{" "}
          <a href="https://github.com/duketopceo/docketry/blob/main/LICENSE-MIT">MIT license</a>.
          You may run, change and share it under that license. These terms do not limit it, and they
          do not apply to installs you run yourself.
        </p>
      </Section>

      <Section id="account" title="Your account">
        <ul>
          <li>You must give accurate sign-in details and keep your password and keys secret.</li>
          <li>You are responsible for what happens under your account, including what agents do with keys you create.</li>
          <li>Workspace owners decide who joins their workspace and what agents can do in it.</li>
        </ul>
      </Section>

      <Section id="your-content" title="Your content">
        <p>
          What you and your agents put in Tallyline belongs to you. You give us permission to store,
          process and display it only to run the service for you. You can export or delete it.
        </p>
      </Section>

      <Section id="use" title="Acceptable use">
        <p>Do not use Tallyline to:</p>
        <ul>
          <li>break the law or infringe anyone&rsquo;s rights;</li>
          <li>send spam, malware, or abusive content, including through webhooks or agents;</li>
          <li>probe, overload or attack the service or other customers (security research under the <Link href="/security">disclosure policy</Link> is welcome);</li>
          <li>get around plan limits or rate limits.</li>
        </ul>
        <p>We may suspend a workspace that puts the service or other people at risk, and we will tell the owner why.</p>
      </Section>

      <Section id="plans" title="Plans and limits">
        <p>
          The hosted service may offer a free plan with limits (for example on members, agents and
          agent runs) and paid plans. When a limit is reached, Tallyline refuses the new action and
          says which limit it hit; it never deletes existing data because of a limit. Prices and
          payment terms will be shown before you pay anything.
        </p>
      </Section>

      <Section id="beta" title="Beta, availability and warranty">
        <p>
          Tallyline Cloud is in beta. It is provided &ldquo;as is&rdquo;, without warranties, and
          there is no uptime guarantee yet. Keep your own exports of anything you cannot afford to
          lose. Current service status is on the <Link href="/status">status page</Link>.
        </p>
      </Section>

      <Section id="liability" title="Liability">
        <p>
          To the extent the law allows, we are not liable for indirect or consequential losses, and
          our total liability is limited to what you paid us in the 12 months before the claim (zero
          on the free plan).
        </p>
      </Section>

      <Section id="ending" title="Ending">
        <p>
          You can stop using the service and delete your account at any time. We may end the service
          or these terms with reasonable notice, and we will give you time to export your data.
        </p>
      </Section>

      <Section id="changes" title="Changes and contact">
        <p>
          We will post changes here and update the date above; material changes will be announced
          to workspace owners first. Questions: <a href="mailto:legal@tallyline.app">legal@tallyline.app</a>.
        </p>
      </Section>
    </LegalDoc>
  );
}
