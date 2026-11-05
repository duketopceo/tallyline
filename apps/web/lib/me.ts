import { cache } from "react";
import { api, type Me } from "@/lib/api";

// One /v1/auth/me per server render: the settings layout and the overview page
// both need it, and api() opts out of fetch caching.
export const getMe = cache(() => api<Me>("/v1/auth/me"));
