#!/usr/bin/env bun

import net from "node:net";

import { createBridgeAdapter } from "./bridge-adapters.ts";
import {
  attachCodexPanelMessageListener,
  readCodexPanelEndpoint,
  sendCodexPanelMessage,
  type CodexPanelMessage,
} from "./codex-panel-link.ts";
import { migrateLegacyChannelFiles } from "./channel-config.ts";

function log(message: string): void {
  process.stderr.write(`[codex-panel] ${message}\n`);
}

function parseCliArgs(argv: string[]): void {
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun run codex:panel",
          "",
          'Starts the visible Codex panel and connects it to the running "bun run bridge:codex" instance.',
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }
}

async function main(): Promise<void> {
  migrateLegacyChannelFiles(log);
  parseCliArgs(process.argv.slice(2));

  const endpoint = readCodexPanelEndpoint();
  if (!endpoint) {
    throw new Error('No active Codex bridge endpoint was found. Start "bun run bridge:codex" first.');
  }

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const nextSocket = net.connect({
      host: "127.0.0.1",
      port: endpoint.port,
    });

    nextSocket.once("connect", () => resolve(nextSocket));
    nextSocket.once("error", (error) => reject(error));
  });

  socket.setNoDelay(true);

  const adapter = createBridgeAdapter({
    kind: "codex",
    command: endpoint.command,
    cwd: endpoint.cwd,
    profile: endpoint.profile,
    initialSharedThreadId: endpoint.sharedThreadId,
    renderMode: "panel",
  });

  let shuttingDown = false;
  let helloAcknowledged = false;
  let detachListener: (() => void) | null = null;

  const publishState = () => {
    sendCodexPanelMessage(socket, {
      type: "state",
      state: adapter.getState(),
    });
  };

  const sendResponse = (id: string, ok: boolean, result?: unknown, error?: string) => {
    sendCodexPanelMessage(socket, {
      type: "response",
      id,
      ok,
      result,
      error,
    });
  };

  const closePanel = async (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    detachListener?.();
    detachListener = null;
    try {
      await adapter.dispose();
    } catch {
      // Best effort cleanup.
    }
    try {
      socket.end();
      socket.destroy();
    } catch {
      // Best effort cleanup.
    }
    process.exit(exitCode);
  };

  adapter.setEventSink((event) => {
    sendCodexPanelMessage(socket, {
      type: "event",
      event,
    });
    publishState();
  });

  detachListener = attachCodexPanelMessageListener(socket, (message: CodexPanelMessage) => {
    if (!helloAcknowledged) {
      if (message.type === "hello_ack") {
        helloAcknowledged = true;
      }
      return;
    }

    if (message.type !== "request") {
      return;
    }

    void (async () => {
      try {
        switch (message.payload.command) {
          case "send_input":
            await adapter.sendInput(message.payload.text);
            sendResponse(message.id, true);
            break;
          case "list_resume_threads":
            sendResponse(
              message.id,
              true,
              await adapter.listResumeThreads(message.payload.limit),
            );
            break;
          case "resume_thread":
            await adapter.resumeThread(message.payload.threadId);
            publishState();
            sendResponse(message.id, true);
            break;
          case "interrupt":
            sendResponse(message.id, true, await adapter.interrupt());
            break;
          case "reset":
            await adapter.reset();
            publishState();
            sendResponse(message.id, true);
            break;
          case "resolve_approval":
            sendResponse(
              message.id,
              true,
              await adapter.resolveApproval(message.payload.action),
            );
            break;
          case "dispose":
            sendResponse(message.id, true);
            await closePanel(0);
            break;
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        sendResponse(message.id, false, undefined, text);
      }
    })();
  });

  socket.once("close", () => {
    void closePanel(0);
  });
  socket.once("error", () => {
    void closePanel(1);
  });

  sendCodexPanelMessage(socket, {
    type: "hello",
    token: endpoint.token,
    panelPid: process.pid,
  });

  await adapter.start();
  publishState();
  log(`Connected to bridge ${endpoint.instanceId}.`);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
