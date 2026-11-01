import { APPEARANCE_COOKIE, type Appearance, parseAppearance } from "@tallyline/silver-lining";
import { cookies } from "next/headers";

/** The request's stored appearance (default: system). Server components only. */
export async function readAppearanceCookie(): Promise<Appearance> {
  return parseAppearance((await cookies()).get(APPEARANCE_COOKIE)?.value);
}
