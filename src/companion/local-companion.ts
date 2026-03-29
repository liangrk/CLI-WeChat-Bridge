#!/usr/bin/env bun

import net from "node:net";
import path from "node:path";

import { createBridgeAdapter } from "../bridge/bridge-adapters.ts";
import {
  attachLocalCompanionMessageListener,
  buildLocalCompanionToken,
  readLocalCompanionEndpoint,
  sendLocalCompanionMessage,
  type LocalCompanionMessage,
} from "./local-companion-link.ts";
import { HUB_DEFAULT_PORT } from "../wechat/channel-config.ts";
import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";

function log(adapter: string, message: string): void {
  process.stderr.write(`[${adapter}-companion] ${message}\n`);
}

type LocalCompanionCliOptions = {
  adapter: "codex" | "claude";
  cwd: string;
  dangerouslySkipPermissions?: boolean;
};

function parseCliArgs(argv: string[]): LocalCompanionCliOptions {
  let adapter: "codex" | "claude" | null = null;
  let cwd = process.cwd();
  let dangerouslySkipPermissions = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: local-companion --adapter <codex|claude> [--cwd <path>]",
          "",
          'Starts the visible local companion and connects it to the matching running bridge for the current directory.',
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (arg === "--adapter") {
      if (!next || !["codex", "claude"].includes(next)) {
        throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
      }
      adapter = next as "codex" | "claude";
      i += 1;
      continue;
    }

    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === "--dangerously-skip-permissions") {
      dangerouslySkipPermissions = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!adapter) {
    throw new Error("Missing required --adapter <codex|claude>");
  }

  return { adapter, cwd, dangerouslySkipPermissions };
}

// --- Hub discovery ---

function tryConnectToHub(port: number): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(null);
    }, 2_000);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.setEncoding("utf8");
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

// --- Hub mode ---

const HUB_PING_INTERVAL_MS = 10_000;
const HUB_PONG_TIMEOUT_MS = 15_000;
const HUB_MAX_BACKOFF_MS = 30_000;

async function runHubMode(
  initialSocket: net.Socket,
  options: LocalCompanionCliOptions,
  projectName: string,
): Promise<void> {
  const token = buildLocalCompanionToken();

  // Create adapter for local PTY
  const defaultCommand = options.adapter === "claude" ? "claude" : options.adapter;
  const adapter = createBridgeAdapter({
    kind: options.adapter,
    command: defaultCommand,
    cwd: options.cwd,
    renderMode: options.adapter === "codex" ? "panel" : "companion",
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
  });

  let socket = initialSocket;
  let detachListener: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let registered = false;
  let shuttingDown = false;

  const publishState = () => {
    if (registered) {
      sendLocalCompanionMessage(socket, {
        type: "state",
        state: adapter.getState(),
      });
    }
  };

  const sendResponse = (
    id: string,
    ok: boolean,
    result?: unknown,
    error?: string,
  ) => {
    sendLocalCompanionMessage(socket, { type: "response", id, ok, result, error });
  };

  const startHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      try {
        sendLocalCompanionMessage(socket, { type: "ping" });
      } catch {
        // Socket may be dead.
      }
    }, HUB_PING_INTERVAL_MS);

    // Pong timeout
    resetPongTimer();
  };

  const resetPongTimer = () => {
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      log(options.adapter, "Hub pong timeout, reconnecting...");
      handleDisconnect();
    }, HUB_PONG_TIMEOUT_MS);
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (pongTimer) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  };

  const register = (sock: net.Socket): Promise<boolean> => {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5_000);

      const onResponse = (message: LocalCompanionMessage) => {
        if (message.type === "register_ack") {
          clearTimeout(timeout);
          if (message.accepted) {
            registered = true;
            log(options.adapter, `Registered as "${projectName}"`);
          } else {
            log(
              options.adapter,
              `Registration rejected: ${message.reason ?? "unknown"}`,
            );
          }
          resolve(message.accepted);
        }
      };

      const listener = attachLocalCompanionMessageListener(sock, onResponse);

      sendLocalCompanionMessage(sock, {
        type: "register",
        projectName,
        cwd: options.cwd,
        token,
      });

      // Store listener for cleanup
      (sock as unknown as Record<string, unknown>)._regListener = listener;
    });
  };

  const wireSocket = (sock: net.Socket) => {
    detachListener?.();
    detachListener = attachLocalCompanionMessageListener(
      sock,
      (message: LocalCompanionMessage) => {
        switch (message.type) {
          case "register_ack":
            if (message.accepted) {
              registered = true;
              log(options.adapter, `Re-registered as "${projectName}"`);
            }
            break;

          case "pong":
            resetPongTimer();
            break;

          case "wechat_message":
            void (async () => {
              try {
                await adapter.sendInput(message.text);
              } catch {
                // Best effort.
              }
            })();
            break;

          case "request":
            if (!registered) return;
            void (async () => {
              try {
                switch (message.payload.command) {
                  case "send_input":
                    await adapter.sendInput(message.payload.text);
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
                      await adapter.resolveApproval(
                        message.payload.action,
                        message.payload.text,
                      ),
                    );
                    break;
                  default:
                    sendResponse(message.id, false, undefined, "Unsupported command");
                    break;
                }
              } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                sendResponse(message.id, false, undefined, text);
              }
            })();
            break;
        }
      },
    );
  };

  const handleDisconnect = () => {
    detachListener?.();
    detachListener = null;
    stopHeartbeat();
    registered = false;

    if (shuttingDown) return;

    void reconnectWithBackoff();
  };

  const reconnectWithBackoff = async () => {
    let attempt = 0;
    while (!shuttingDown) {
      const delay =
        attempt === 0 ? 0 : Math.min(Math.pow(2, attempt - 1) * 1000, HUB_MAX_BACKOFF_MS);
      if (delay > 0) {
        log(options.adapter, `Reconnecting in ${delay}ms (attempt ${attempt + 1})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      attempt++;

      if (shuttingDown) break;

      const newSocket = await tryConnectToHub(HUB_DEFAULT_PORT);
      if (newSocket) {
        socket = newSocket;
        const accepted = await register(socket);
        if (accepted) {
          wireSocket(socket);
          startHeartbeat();
          publishState();
          log(options.adapter, "Reconnected to Hub");
          return;
        }
        newSocket.destroy();
      }
    }
  };

  // Wire adapter events → Hub
  adapter.setEventSink((event) => {
    if (registered) {
      sendLocalCompanionMessage(socket, { type: "event", event });
      publishState();
    }
  });

  // Wire initial socket
  const accepted = await register(socket);
  if (!accepted) {
    throw new Error("Hub registration rejected");
  }

  wireSocket(socket);
  startHeartbeat();

  socket.once("close", handleDisconnect);
  socket.once("error", handleDisconnect);

  // Start adapter
  await adapter.start();
  publishState();

  log(
    options.adapter,
    `Hub mode active as "${projectName}".`,
  );

  // Graceful shutdown
  const closeCompanion = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopHeartbeat();
    detachListener?.();
    try {
      await adapter.dispose();
    } catch {
      // Best effort.
    }
    try {
      socket.end();
      socket.destroy();
    } catch {
      // Best effort.
    }
  };

  process.on("SIGINT", () => {
    void closeCompanion().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void closeCompanion().finally(() => process.exit(0));
  });

  // Keep alive
  await new Promise<void>(() => {});
}

// --- Single-project mode (original) ---

async function runSingleProjectMode(
  options: LocalCompanionCliOptions,
): Promise<void> {
  const endpoint = readLocalCompanionEndpoint(options.cwd);
  if (!endpoint || endpoint.kind !== options.adapter) {
    throw new Error(
      `No active ${options.adapter} bridge endpoint was found for ${options.cwd}. Start "wechat-bridge-${options.adapter}" in that directory first.`,
    );
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
    kind: endpoint.kind,
    command: endpoint.command,
    cwd: endpoint.cwd,
    profile: endpoint.profile,
    initialSharedSessionId:
      endpoint.sharedSessionId ?? endpoint.sharedThreadId,
    initialResumeConversationId: endpoint.resumeConversationId,
    initialTranscriptPath: endpoint.transcriptPath,
    renderMode: endpoint.kind === "codex" ? "panel" : "companion",
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
  });

  let shuttingDown = false;
  let helloAcknowledged = false;
  let detachListener: (() => void) | null = null;

  const publishState = () => {
    sendLocalCompanionMessage(socket, {
      type: "state",
      state: adapter.getState(),
    });
  };

  const sendResponse = (
    id: string,
    ok: boolean,
    result?: unknown,
    error?: string,
  ) => {
    sendLocalCompanionMessage(socket, {
      type: "response",
      id,
      ok,
      result,
      error,
    });
  };

  const closeCompanion = async (exitCode = 0) => {
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
    sendLocalCompanionMessage(socket, {
      type: "event",
      event,
    });
    publishState();
  });

  detachListener = attachLocalCompanionMessageListener(
    socket,
    (message: LocalCompanionMessage) => {
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
            case "list_resume_sessions":
            case "list_resume_threads":
              sendResponse(
                message.id,
                true,
                await adapter.listResumeSessions(message.payload.limit),
              );
              break;
            case "resume_session":
              await adapter.resumeSession(message.payload.sessionId);
              publishState();
              sendResponse(message.id, true);
              break;
            case "resume_thread":
              await adapter.resumeSession(message.payload.threadId);
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
                await adapter.resolveApproval(
                  message.payload.action,
                  message.payload.text,
                ),
              );
              break;
            case "dispose":
              sendResponse(message.id, true);
              await closeCompanion(0);
              break;
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          sendResponse(message.id, false, undefined, text);
        }
      })();
    },
  );

  socket.once("close", () => {
    void closeCompanion(0);
  });
  socket.once("error", () => {
    void closeCompanion(1);
  });

  sendLocalCompanionMessage(socket, {
    type: "hello",
    token: endpoint.token,
    companionPid: process.pid,
  });

  await adapter.start();
  publishState();
  log(options.adapter, `Connected to bridge ${endpoint.instanceId}.`);
}

// --- Main ---

async function main(): Promise<void> {
  migrateLegacyChannelFiles((message) => log("local", message));
  const options = parseCliArgs(process.argv.slice(2));
  const projectName = path.basename(options.cwd);

  // Try Hub first
  const hubSocket = await tryConnectToHub(HUB_DEFAULT_PORT);
  if (hubSocket) {
    log(options.adapter, `Hub found at port ${HUB_DEFAULT_PORT}`);
    await runHubMode(hubSocket, options, projectName);
    return;
  }

  // Fallback: single-project mode
  log(options.adapter, "Hub not found, using single-project mode");
  await runSingleProjectMode(options);
}

main().catch((error) => {
  log("local", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
