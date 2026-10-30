import type { ActorDirectory } from "@/lib/actors";

// U14 web feed: shapes and display rules for project status updates. The API
// (apps/api/src/routes/project-updates.ts) owns the contract; this mirrors it.
export const UPDATE_HEALTH = ["on_track", "at_risk", "off_track"] as const;
export type UpdateHealth = (typeof UPDATE_HEALTH)[number];

export interface ProjectUpdate {
  id: string;
  health: UpdateHealth;
  body: string;
  authorType: "human" | "agent" | "system";
  authorId: string | null;
  createdAt: string;
}

// Health is always shown as text beside the dot, never as color alone.
export const HEALTH_META: Record<UpdateHealth, { label: string; text: string; dot: string }> = {
  on_track: { label: "On track", text: "text-healthy", dot: "bg-healthy" },
  at_risk: { label: "At risk", text: "text-attention", dot: "bg-attention" },
  off_track: { label: "Off track", text: "text-urgent", dot: "bg-urgent" },
};

export interface UpdateAuthor {
  name: string;
  isAgent: boolean;
}

export function updateAuthor(
  u: Pick<ProjectUpdate, "authorType" | "authorId">,
  directory: ActorDirectory,
): UpdateAuthor {
  if (u.authorType === "system") return { name: "System", isAgent: false };
  const known = u.authorId ? directory[u.authorId] : undefined;
  return { name: known?.name ?? "Unknown", isAgent: u.authorType === "agent" };
}
