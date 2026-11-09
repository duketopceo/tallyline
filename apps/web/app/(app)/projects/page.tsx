import { redirect } from "next/navigation";

// The per-project list moved into the overview, which aggregates in the API.
export default function ProjectsPage() {
  redirect("/overview");
}
