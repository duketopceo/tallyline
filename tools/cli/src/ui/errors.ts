// Plain-language error catalog. Interactive terminals only: scripts and pipes
// keep the stable `CODE: message` line (see golden.test.ts). Every entry says
// what happened, why it usually happens, and one thing to do next.

export interface Friendly {
  title: string;
  why?: string;
  fix?: string;
  /** stable id a person can quote when asking for help */
  ref: string;
}

interface Entry {
  title: string;
  why?: string;
  fix?: string;
}

const BY_API_CODE: Record<string, Entry> = {
  UNAUTHENTICATED: {
    title: "Tallyline didn't accept your sign-in",
    why: "Your session may have expired, or the key was turned off.",
    fix: "tallyline connect",
  },
  FORBIDDEN: {
    title: "You don't have permission to do that",
    why: "Your role in this workspace doesn't include that action.",
    fix: "Ask a workspace admin, or try a different account with tallyline connect.",
  },
  FORBIDDEN_AGENT: {
    title: "Agents can't do that part",
    why: "Approving or sending back reviews is always a person's decision.",
    fix: "Move the issue to in_review and comment; a person will take it from there.",
  },
  FORBIDDEN_SCOPE: {
    title: "This key can only read",
    why: "The key you are using doesn't have permission to make changes.",
    fix: "Use a key with write access, or run tallyline connect to sign in as yourself.",
  },
  NOT_FOUND: {
    title: "Couldn't find that",
    why: "The item may have been deleted, or the key may be mistyped.",
    fix: "tallyline list --search <words>   to look for it",
  },
  INVALID_TRANSITION: {
    title: "That issue can't move there yet",
    why: "Issues move through states in order (for example, review comes before done).",
    fix: "tallyline show <KEY>   to see where it is now",
  },
  STALE_DIFF: {
    title: "The plan changed since you previewed it",
    fix: "Run the import again to preview the new changes, then apply.",
  },
  RATE_LIMITED: {
    title: "That's a lot of requests at once",
    why: "Tallyline slows things down briefly to stay healthy.",
    fix: "Wait a few seconds and try again.",
  },
  NETWORK: {
    title: "Couldn't reach your Tallyline server",
    why: "Your computer may be offline, or the server is restarting or has moved.",
    fix: "tallyline doctor",
  },
};

const BY_STATUS: Record<number, Entry> = {
  400: { title: "Tallyline couldn't understand that request", fix: "Check the command with --help." },
  429: BY_API_CODE.RATE_LIMITED!,
  500: {
    title: "Something went wrong on the server",
    why: "This isn't something you did.",
    fix: "Try again in a minute. If it keeps happening, run tallyline doctor.",
  },
  502: { title: "The server isn't answering properly", fix: "tallyline doctor" },
  503: { title: "The server is busy or restarting", fix: "Try again in a minute." },
};

export function friendlyApiError(
  status: number,
  code: string,
  message: string,
): Friendly {
  const hit = BY_API_CODE[code] ?? BY_STATUS[status];
  const ref = status === 0 ? `TLY-${code}` : `TLY-${status}-${code}`;
  if (hit) return { ...hit, ref };
  return {
    title: message || "Something unexpected happened",
    fix: "tallyline doctor",
    ref,
  };
}

export function friendlyUsage(message: string, command?: string): Friendly {
  return {
    title: message,
    fix: command ? `tallyline help ${command}` : "tallyline help",
    ref: "TLY-USAGE",
  };
}

/** Missing-config messages get setup-flavoured help instead of env var names. */
export function friendlyMissingConfig(what: "workspace" | "token"): Friendly {
  return what === "token"
    ? {
        title: "You're not signed in yet",
        why: "Tallyline needs to know who you are.",
        fix: "tallyline connect",
        ref: "TLY-NO-TOKEN",
      }
    : {
        title: "No workspace chosen yet",
        why: "A workspace is your team's home in Tallyline.",
        fix: "tallyline connect",
        ref: "TLY-NO-WORKSPACE",
      };
}
