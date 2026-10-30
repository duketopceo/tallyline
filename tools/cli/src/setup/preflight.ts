import type { Sys } from "./sys.js";

// Checks before anything is installed. Each answers in plain words and, when it
// can, says the one thing to do. Nothing here changes the computer.

export type Level = "ok" | "warn" | "fail";
export type DockerState = "ready" | "stopped" | "missing";

export interface PreflightCheck {
  id: "system" | "memory" | "disk" | "web-port" | "api-port" | "docker";
  level: Level;
  message: string;
  fix?: string;
}

export interface Preflight {
  checks: PreflightCheck[];
  docker: DockerState;
  /** true when nothing blocks the install */
  ok: boolean;
}

const GB = 1024 ** 3;

export async function dockerState(sys: Sys): Promise<DockerState> {
  const v = await sys.run("docker", ["--version"]);
  if (v.code !== 0) return "missing";
  const info = await sys.run("docker", ["info"]);
  return info.code === 0 ? "ready" : "stopped";
}

export async function preflight(opts: {
  sys: Sys;
  dir: string;
  webPort: number;
  apiPort: number;
  /** ports already belong to this install, so being in use is expected */
  portsOwned: boolean;
}): Promise<Preflight> {
  const { sys } = opts;
  const checks: PreflightCheck[] = [];

  if (sys.platform === "darwin" || sys.platform === "linux") {
    checks.push({ id: "system", level: "ok", message: sys.platform === "darwin" ? "This is a Mac." : "This is a Linux computer." });
  } else if (sys.platform === "win32") {
    checks.push({
      id: "system",
      level: "fail",
      message: "Tallyline's setup does not run on Windows directly.",
      fix: "Install WSL (Windows Subsystem for Linux), then run this again inside it. See https://learn.microsoft.com/windows/wsl/install",
    });
  } else {
    checks.push({ id: "system", level: "warn", message: `This system (${sys.platform}) is untested.` });
  }

  const mem = sys.totalMemBytes() / GB;
  checks.push(
    mem < 2
      ? { id: "memory", level: "fail", message: `Only ${mem.toFixed(1)} GB of memory. Tallyline needs about 2 GB.`, fix: "Use a computer with more memory, or the hosted version." }
      : mem < 4
        ? { id: "memory", level: "warn", message: `${mem.toFixed(1)} GB of memory. That works, but it will feel tight.` }
        : { id: "memory", level: "ok", message: `${mem.toFixed(0)} GB of memory.` },
  );

  const free = await sys.freeDiskBytes(opts.dir.startsWith("/") ? "/" : opts.dir);
  if (free !== undefined) {
    const g = free / GB;
    checks.push(
      g < 3
        ? { id: "disk", level: "fail", message: `Only ${g.toFixed(1)} GB of free disk space. Tallyline needs about 3 GB.`, fix: "Free up some space and run this again." }
        : g < 6
          ? { id: "disk", level: "warn", message: `${g.toFixed(1)} GB of free disk space. Enough to start; keep an eye on it.` }
          : { id: "disk", level: "ok", message: `${g.toFixed(0)} GB of free disk space.` },
    );
  }

  for (const [id, port, what] of [
    ["web-port", opts.webPort, "the website"],
    ["api-port", opts.apiPort, "the server"],
  ] as const) {
    if (opts.portsOwned || (await sys.portFree(port))) {
      checks.push({ id, level: "ok", message: `Port ${port} is free for ${what}.` });
    } else {
      checks.push({
        id,
        level: "fail",
        message: `Something else is already using port ${port}, which Tallyline needs for ${what}.`,
        fix: id === "web-port" ? `Close that program, or run: tallyline setup --port ${port + 1}` : `Close that program, or run: tallyline setup --api-port ${port + 1}`,
      });
    }
  }

  const docker = await dockerState(sys);
  checks.push(
    docker === "ready"
      ? { id: "docker", level: "ok", message: "Docker is installed and running." }
      : docker === "stopped"
        ? { id: "docker", level: "warn", message: "Docker is installed but not running." }
        : { id: "docker", level: "warn", message: "Docker is not installed. Tallyline runs inside it." },
  );

  return { checks, docker, ok: !checks.some((c) => c.level === "fail") };
}
