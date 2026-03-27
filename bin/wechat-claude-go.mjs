#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTsEntry } from "./_run-entry.mjs";

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(BIN_DIR, "..");

const BRIDGE_COMMAND = "wechat-bridge-claude";
const POLL_INTERVAL_MS = 300;
const MAX_WAIT_MS = 15_000;

function log(message) {
  process.stderr.write(`[wechat-claude-go] ${message}\n`);
}

async function getEndpointFile(cwd) {
  const { getWorkspaceChannelPaths } = await import(
    pathToFileURL(path.join(PROJECT_DIR, "src/wechat/channel-config.ts")).href
  );
  return getWorkspaceChannelPaths(cwd).endpointFile;
}

function pathToFileURL(p) {
  // Avoid dynamic import of node:url in case of bundler issues
  if (process.platform === "win32") {
    return `file:///${p.replace(/\\/g, "/")}`;
  }
  return `file://${p}`;
}

async function endpointExists(cwd) {
  try {
    const endpointFile = await getEndpointFile(cwd);
    return fs.existsSync(endpointFile);
  } catch {
    return false;
  }
}

function waitForEndpoint(cwd) {
  return new Promise(async (resolve, reject) => {
    let endpointFile;
    try {
      endpointFile = await getEndpointFile(cwd);
    } catch (error) {
      reject(error);
      return;
    }

    const deadline = Date.now() + MAX_WAIT_MS;

    const check = () => {
      if (fs.existsSync(endpointFile)) {
        resolve();
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for bridge to start."));
        return;
      }

      setTimeout(check, POLL_INTERVAL_MS);
    };

    check();
  });
}

function spawnBridgeInNewWindow(cwd) {
  const platform = process.platform;
  const cwdArg = `--cwd ${cwd}`;

  if (platform === "win32") {
    spawn(
      "cmd.exe",
      ["/c", "start", "", "cmd", "/k", `${BRIDGE_COMMAND} ${cwdArg}`],
      { detached: true, stdio: "ignore", cwd },
    ).unref();
    return;
  }

  if (platform === "darwin") {
    spawn(
      "osascript",
      [
        "-e",
        `tell application "Terminal" to do script "${BRIDGE_COMMAND} ${cwdArg}"`,
      ],
      { detached: true, stdio: "ignore", cwd },
    ).unref();
    return;
  }

  // Linux: try common terminal emulators
  const terminals = [
    ["gnome-terminal", ["--", "bash", "-c", `${BRIDGE_COMMAND} ${cwdArg}; exec bash`]],
    ["konsole", ["-e", "bash", "-c", `${BRIDGE_COMMAND} ${cwdArg}; exec bash`]],
    ["xfce4-terminal", ["-e", `bash -c '${BRIDGE_COMMAND} ${cwdArg}; exec bash'`]],
    ["x-terminal-emulator", ["-e", "bash", "-c", `${BRIDGE_COMMAND} ${cwdArg}; exec bash`]],
  ];

  for (const [cmd, args] of terminals) {
    try {
      spawn(cmd, args, { detached: true, stdio: "ignore", cwd }).unref();
      return;
    } catch {
      continue;
    }
  }

  throw new Error(
    "Could not detect a supported terminal emulator. On Linux, please start wechat-bridge-claude manually.",
  );
}

async function main() {
  const cwd = process.cwd();

  if (!(await endpointExists(cwd))) {
    log("Starting bridge in a new window...");
    spawnBridgeInNewWindow(cwd);

    log("Waiting for bridge to be ready...");
    await waitForEndpoint(cwd);
    log("Bridge is ready.");
  } else {
    log("Bridge is already running.");
  }

  // Launch companion in the current terminal
  runTsEntry("src/companion/local-companion.ts", ["--adapter", "claude"]);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
