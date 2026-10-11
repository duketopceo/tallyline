import type { Metadata } from "next";
import { LegalDoc, Section } from "@/components/legal-doc";

export const metadata: Metadata = {
  title: "Security · Tallyline",
  description: "How to report a vulnerability in Tallyline, and what happens next.",
};

const REPO = "https://github.com/duketopceo/docketry";

export default function SecurityPage() {
  return (
    <LegalDoc
      title="Security and responsible disclosure"
      updated="October 11, 2026"
      summary={
        <p>
          Found a security problem in Tallyline? Tell us privately at{" "}
          <a className="text-accent underline underline-offset-2" href="mailto:security@tallyline.app">
            security@tallyline.app
          </a>{" "}
          and we will work with you on a fix. Please do not open a public issue.
        </p>
      }
    >
      <Section id="report" title="How to report">
        <ul>
          <li>
            Email <a href="mailto:security@tallyline.app">security@tallyline.app</a>, or use{" "}
            <a href={`${REPO}/security/advisories/new`}>GitHub private vulnerability reporting</a>.
          </li>
          <li>Describe the problem, the steps to reproduce it, and which part is affected (web app, API, MCP server, CLI, a self-hosted deployment).</li>
          <li>Include the version or commit if you are testing a self-hosted install.</li>
        </ul>
      </Section>

      <Section id="expect" title="What to expect">
        <ul>
          <li>A reply within 72 hours confirming we received your report.</li>
          <li>A decision once we can reproduce it: accepted, need more information, or declined with our reasons.</li>
          <li>If accepted, a fix developed privately, then a published advisory that credits you unless you prefer otherwise.</li>
        </ul>
      </Section>

      <Section id="rules" title="Testing rules">
        <p>Good-faith research is welcome. Please:</p>
        <ul>
          <li>test against your own self-hosted install or your own workspace, never someone else&rsquo;s data;</li>
          <li>avoid anything that degrades the service for others: no load tests, spam or social engineering;</li>
          <li>stop and report as soon as you reach data that is not yours;</li>
          <li>give us reasonable time to ship a fix before you publish details.</li>
        </ul>
        <p>We will not pursue or support legal action against research that follows these rules.</p>
      </Section>

      <Section id="practices" title="How Tallyline is built">
        <ul>
          <li>Passwords, API keys and agent keys are stored only as hashes; keys are shown once at creation.</li>
          <li>Every workspace is isolated, and an automated test suite checks every API route for cross-workspace access.</li>
          <li>Every route&rsquo;s permissions are listed in a policy table that the test suite replays on each change.</li>
          <li>No third-party scripts or trackers run in the app.</li>
        </ul>
        <p>
          The full policy, including scope, lives in{" "}
          <a href={`${REPO}/blob/main/SECURITY.md`}>SECURITY.md</a>. Machine-readable contact details
          are at <a href="/.well-known/security.txt">/.well-known/security.txt</a>.
        </p>
      </Section>
    </LegalDoc>
  );
}
