import { spawn } from "node:child_process";
import path from "node:path";
import type { BridgeAdapterKind } from "./bridge-types.ts";

export type CompanionSpawnOptions = {
  projectId: string;
  adapter: BridgeAdapterKind;
  cwd: string;
  companionCommand?: string;
};

export type SpawnedCompanion = {
  pid: number | undefined;
  projectId: string;
  process: ReturnType<typeof spawn>;
};

function resolveCompanionCommand(adapter: BridgeAdapterKind): string {
  switch (adapter) {
    case "claude":
      return "wechat-claude";
    case "codex":
      return "wechat-codex";
    default:
      return "wechat-claude";
  }
}

export function spawnCompanionWindow(options: CompanionSpawnOptions): SpawnedCompanion {
  const command = options.companionCommand ?? resolveCompanionCommand(options.adapter);
  const cwd = path.resolve(options.cwd);
  const title = options.projectId;

  let child: ReturnType<typeof spawn>;

  if (process.platform === "win32") {
    // Windows: use `start` to open a new cmd window with the project title
    child = spawn("cmd", ["/c", "start", `"${title}"`, "cmd", "/c", `${command} --adapter ${options.adapter} --cwd "${cwd}"`], {
      stdio: "ignore",
      detached: true,
      windowsHide: false,
    });
  } else {
    // Unix: try to use available terminal emulators
    const terminal = process.env.TERM_PROGRAM;
    const execCmd = `${command} --adapter ${options.adapter} --cwd "${cwd}"`;

    if (terminal === "iTerm.app") {
      child = spawn("osascript", ["-e", `tell application "iTerm" to create window with default profile command "${execCmd}"`], {
        stdio: "ignore",
        detached: true,
      });
    } else if (terminal === "Apple_Terminal") {
      child = spawn("osascript", ["-e", `tell application "Terminal" to do script "${execCmd}"`], {
        stdio: "ignore",
        detached: true,
      });
    } else {
      // Generic: try gnome-terminal, then xterm
      try {
        child = spawn("gnome-terminal", ["--title", title, "--", "bash", "-c", execCmd], {
          stdio: "ignore",
          detached: true,
        });
      } catch {
        child = spawn("xterm", ["-title", title, "-e", "bash", "-c", execCmd], {
          stdio: "ignore",
          detached: true,
        });
      }
    }
  }

  child.unref();

  return {
    pid: child.pid,
    projectId: options.projectId,
    process: child,
  };
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
