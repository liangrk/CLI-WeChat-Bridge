import crypto from "node:crypto";
import fs from "node:fs";
import type net from "node:net";

import { CODEX_PANEL_ENDPOINT_FILE, ensureChannelDataDir } from "./channel-config.ts";
import type { BridgeAdapterState, BridgeEvent } from "./bridge-types.ts";

export type CodexPanelCommand =
  | { command: "send_input"; text: string }
  | { command: "interrupt" }
  | { command: "reset" }
  | { command: "dispose" }
  | { command: "resolve_approval"; action: "confirm" | "deny" };

export type CodexPanelEndpoint = {
  instanceId: string;
  port: number;
  token: string;
  cwd: string;
  command: string;
  profile?: string;
  startedAt: string;
};

export type CodexPanelMessage =
  | {
      type: "hello";
      token: string;
      panelPid: number;
    }
  | {
      type: "hello_ack";
    }
  | {
      type: "request";
      id: string;
      payload: CodexPanelCommand;
    }
  | {
      type: "response";
      id: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | {
      type: "event";
      event: BridgeEvent;
    }
  | {
      type: "state";
      state: BridgeAdapterState;
    };

export function buildCodexPanelToken(): string {
  return crypto.randomBytes(18).toString("hex");
}

export function writeCodexPanelEndpoint(endpoint: CodexPanelEndpoint): void {
  ensureChannelDataDir();
  fs.writeFileSync(
    CODEX_PANEL_ENDPOINT_FILE,
    JSON.stringify(endpoint, null, 2),
    "utf8",
  );
}

export function readCodexPanelEndpoint(): CodexPanelEndpoint | null {
  try {
    if (!fs.existsSync(CODEX_PANEL_ENDPOINT_FILE)) {
      return null;
    }
    return JSON.parse(
      fs.readFileSync(CODEX_PANEL_ENDPOINT_FILE, "utf8"),
    ) as CodexPanelEndpoint;
  } catch {
    return null;
  }
}

export function clearCodexPanelEndpoint(instanceId?: string): void {
  try {
    if (!fs.existsSync(CODEX_PANEL_ENDPOINT_FILE)) {
      return;
    }

    if (!instanceId) {
      fs.rmSync(CODEX_PANEL_ENDPOINT_FILE, { force: true });
      return;
    }

    const endpoint = readCodexPanelEndpoint();
    if (!endpoint || endpoint.instanceId === instanceId) {
      fs.rmSync(CODEX_PANEL_ENDPOINT_FILE, { force: true });
    }
  } catch {
    // Best effort cleanup.
  }
}

export function sendCodexPanelMessage(
  socket: net.Socket,
  message: CodexPanelMessage,
): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

export function attachCodexPanelMessageListener(
  socket: net.Socket,
  onMessage: (message: CodexPanelMessage) => void,
): () => void {
  let buffer = "";
  const onData = (chunk: string | Buffer) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      try {
        onMessage(JSON.parse(line) as CodexPanelMessage);
      } catch {
        // Ignore malformed local IPC frames.
      }
    }
  };

  socket.setEncoding("utf8");
  socket.on("data", onData);
  return () => {
    socket.off("data", onData);
  };
}
