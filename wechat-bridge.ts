#!/usr/bin/env bun

import path from "node:path";

import { createBridgeAdapter } from "./bridge-adapters.ts";
import { migrateLegacyChannelFiles } from "./channel-config.ts";
import { BridgeStateStore } from "./bridge-state.ts";
import type {
  BridgeAdapter,
  BridgeAdapterKind,
  PendingApproval,
} from "./bridge-types.ts";
import {
  buildOneTimeCode,
  formatApprovalMessage,
  formatDuration,
  formatStatusReport,
  formatThreadSwitchMessage,
  MESSAGE_START_GRACE_MS,
  nowIso,
  OutputBatcher,
  parseSystemCommand,
  truncatePreview,
} from "./bridge-utils.ts";
import {
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  WeChatTransport,
  type InboundWechatMessage,
} from "./wechat-transport.ts";

type BridgeCliOptions = {
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
};

type ActiveTask = {
  startedAt: number;
  inputPreview: string;
};

function log(message: string): void {
  process.stderr.write(`[wechat-bridge] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[wechat-bridge] ERROR: ${message}\n`);
}

function parseCliArgs(argv: string[]): BridgeCliOptions {
  let adapter: BridgeAdapterKind | null = null;
  let commandOverride: string | undefined;
  let cwd = process.cwd();
  let profile: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--adapter":
        if (!next || !["codex", "claude", "shell"].includes(next)) {
          throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
        }
        adapter = next as BridgeAdapterKind;
        i += 1;
        break;
      case "--cmd":
        if (!next) {
          throw new Error("--cmd requires a value");
        }
        commandOverride = next;
        i += 1;
        break;
      case "--cwd":
        if (!next) {
          throw new Error("--cwd requires a value");
        }
        cwd = path.resolve(next);
        i += 1;
        break;
      case "--profile":
        if (!next) {
          throw new Error("--profile requires a value");
        }
        profile = next;
        i += 1;
        break;
      case "--help":
      case "-h":
        printUsageAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!adapter) {
    throw new Error("Missing required --adapter <codex|claude|shell>");
  }

  const defaultCommand = adapter === "shell" ? "powershell.exe" : adapter;
  return {
    adapter,
    command: commandOverride ?? defaultCommand,
    cwd,
    profile,
  };
}

function printUsageAndExit(): never {
  process.stdout.write(
    [
      "Usage: wechat-bridge --adapter <codex|claude|shell> [--cmd <executable>] [--cwd <path>] [--profile <name-or-path>]",
      "",
      "Examples:",
      "  wechat-bridge-codex",
      "  wechat-bridge-claude --cwd C:\\Users\\unlin\\Desktop\\Github",
      "  wechat-bridge-shell --cmd pwsh.exe",
      "  bun run bridge:codex            # repo-local development entrypoint",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

async function main(): Promise<void> {
  migrateLegacyChannelFiles(log);

  const options = parseCliArgs(process.argv.slice(2));
  const transport = new WeChatTransport({ log, logError });

  const credentials = transport.getCredentials();
  if (!credentials) {
    throw new Error('No saved WeChat credentials found. Run "bun run setup" first.');
  }
  if (!credentials.userId) {
    throw new Error('Saved WeChat credentials are missing userId. Run "bun run setup" again.');
  }

  const stateStore = new BridgeStateStore({
    ...options,
    authorizedUserId: credentials.userId,
  });

  const adapter = createBridgeAdapter({
    kind: options.adapter,
    command: options.command,
    cwd: options.cwd,
    profile: options.profile,
    initialSharedThreadId: stateStore.getState().sharedThreadId,
  });
  let sendChain = Promise.resolve();
  let activeTask: ActiveTask | null = null;
  let lastOutputAt = 0;
  let lastHeartbeatAt = 0;

  const queueWechatMessage = (senderId: string, text: string) => {
    sendChain = sendChain
      .then(() => transport.sendText(senderId, text))
      .catch((err) => {
        logError(`Failed to send WeChat reply: ${String(err)}`);
      });
    return sendChain;
  };

  const outputBatcher = new OutputBatcher(async (text) => {
    await queueWechatMessage(stateStore.getState().authorizedUserId, text);
  });

  const cleanup = async () => {
    try {
      await outputBatcher.flushNow();
    } catch {
      // Best effort flush.
    }
    try {
      await adapter.dispose();
    } catch {
      // Best effort shutdown.
    }
    stateStore.releaseLock();
  };

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("exit", () => {
    stateStore.releaseLock();
  });

  try {
    wireAdapterEvents({
      adapter,
      options,
      stateStore,
      outputBatcher,
      queueWechatMessage,
      getActiveTask: () => activeTask,
      clearActiveTask: () => {
        activeTask = null;
        lastHeartbeatAt = 0;
      },
      updateLastOutputAt: () => {
        lastOutputAt = Date.now();
      },
      syncSharedThreadState: () => {
        syncSharedThreadState(stateStore, adapter);
      },
    });

    await adapter.start();
    syncSharedThreadState(stateStore, adapter);
    stateStore.appendLog(
      `Bridge started with adapter=${options.adapter} command=${options.command} cwd=${options.cwd}`,
    );

    log(`WeChat bridge is ready for adapter "${options.adapter}".`);
    log(`Working directory: ${options.cwd}`);
    if (options.profile) {
      log(`Profile: ${options.profile}`);
    }
    log(`Authorized WeChat user: ${credentials.userId}`);
    if (options.adapter === "codex") {
      log(
        'Start the visible Codex panel in a second terminal with: wechat-codex',
      );
    }

    while (true) {
      const pollResult = await transport.pollMessages({
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
        minCreatedAtMs: stateStore.getState().bridgeStartedAtMs - MESSAGE_START_GRACE_MS,
      });

      if (pollResult.ignoredBacklogCount > 0) {
        stateStore.incrementIgnoredBacklog(pollResult.ignoredBacklogCount);
        stateStore.appendLog(
          `ignored_startup_backlog: count=${pollResult.ignoredBacklogCount}`,
        );
      }

      for (const message of pollResult.messages) {
        stateStore.touchActivity(message.createdAt);
        let nextTask: ActiveTask | null = null;
        try {
          nextTask = await handleInboundMessage({
            message,
            options,
            stateStore,
            adapter,
            queueWechatMessage,
            outputBatcher,
          });
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          logError(errorText);
          stateStore.appendLog(`inbound_error: ${errorText}`);
          await queueWechatMessage(message.senderId, `Bridge error: ${errorText}`);
        }
        if (nextTask) {
          activeTask = nextTask;
          lastHeartbeatAt = 0;
        }
        syncSharedThreadState(stateStore, adapter);
      }

      const adapterState = adapter.getState();
      const lastSignalAt = Math.max(lastHeartbeatAt, lastOutputAt || activeTask?.startedAt || 0);

      if (
        activeTask &&
        options.adapter !== "codex" &&
        adapterState.status === "busy" &&
        Date.now() - lastSignalAt >= 30_000
      ) {
        lastHeartbeatAt = Date.now();
        await queueWechatMessage(
          stateStore.getState().authorizedUserId,
          `${options.adapter} is still running. Waiting for more output...`,
        );
      }
    }
  } finally {
    await cleanup();
  }
}

function syncSharedThreadState(
  stateStore: BridgeStateStore,
  adapter: BridgeAdapter,
): void {
  const persistedThreadId = stateStore.getState().sharedThreadId;
  const adapterThreadId = adapter.getState().sharedThreadId;

  if (adapterThreadId && adapterThreadId !== persistedThreadId) {
    stateStore.setSharedThreadId(adapterThreadId);
    return;
  }

  if (!adapterThreadId && persistedThreadId) {
    stateStore.clearSharedThreadId();
  }
}

function wireAdapterEvents(params: {
  adapter: BridgeAdapter;
  options: BridgeCliOptions;
  stateStore: BridgeStateStore;
  outputBatcher: OutputBatcher;
  queueWechatMessage: (senderId: string, text: string) => Promise<void>;
  getActiveTask: () => ActiveTask | null;
  clearActiveTask: () => void;
  updateLastOutputAt: () => void;
  syncSharedThreadState: () => void;
}): void {
  const {
    adapter,
    options,
    stateStore,
    outputBatcher,
    queueWechatMessage,
    getActiveTask,
    clearActiveTask,
    updateLastOutputAt,
    syncSharedThreadState,
  } = params;

  adapter.setEventSink((event) => {
    syncSharedThreadState();
    const authorizedUserId = stateStore.getState().authorizedUserId;

    switch (event.type) {
      case "stdout":
      case "stderr":
        updateLastOutputAt();
        outputBatcher.push(event.text);
        break;
      case "status":
        if (event.message) {
          log(`${event.status}: ${event.message}`);
          stateStore.appendLog(`${event.status}: ${event.message}`);
        }
        break;
      case "approval_required":
        void outputBatcher.flushNow().then(async () => {
          const pending: PendingApproval = {
            ...event.request,
            code: buildOneTimeCode(),
            createdAt: nowIso(),
          };
          stateStore.setPendingConfirmation(pending);
          stateStore.appendLog(
            `Approval requested (${pending.source}): ${pending.commandPreview}`,
          );
          await queueWechatMessage(
            authorizedUserId,
            formatApprovalMessage(pending, adapter.getState()),
          );
        });
        break;
      case "mirrored_user_input":
        void outputBatcher.flushNow().then(async () => {
          stateStore.appendLog(`mirrored_local_input: ${truncatePreview(event.text)}`);
          await queueWechatMessage(
            authorizedUserId,
            `Local Codex input:\n${truncatePreview(event.text, 500)}`,
          );
        });
        break;
      case "thread_switched":
        stateStore.appendLog(
          `thread_switched: ${event.threadId} source=${event.source} reason=${event.reason}`,
        );
        void outputBatcher.flushNow().then(async () => {
          await queueWechatMessage(
            authorizedUserId,
            formatThreadSwitchMessage(event),
          );
        });
        break;
      case "task_complete":
        void outputBatcher.flushNow().then(async () => {
          stateStore.clearPendingConfirmation();
          if (options.adapter !== "codex") {
            const summary = buildCompletionSummary({
              adapter: options.adapter,
              activeTask: getActiveTask(),
              exitCode: event.exitCode,
              recentOutput: outputBatcher.getRecentSummary(),
            });
            await queueWechatMessage(authorizedUserId, summary);
          }
          clearActiveTask();
        });
        break;
      case "fatal_error":
        logError(event.message);
        stateStore.appendLog(`fatal_error: ${event.message}`);
        stateStore.clearPendingConfirmation();
        clearActiveTask();
        void queueWechatMessage(authorizedUserId, `Bridge error: ${event.message}`);
        break;
    }
  });
}

function buildCompletionSummary(params: {
  adapter: BridgeAdapterKind;
  activeTask: ActiveTask | null;
  exitCode?: number;
  recentOutput: string;
}): string {
  const lines = [`${params.adapter} task complete.`];
  if (params.activeTask) {
    lines.push(
      `duration: ${formatDuration(Date.now() - params.activeTask.startedAt)}`,
    );
    lines.push(`input: ${params.activeTask.inputPreview}`);
  }
  if (typeof params.exitCode === "number") {
    lines.push(`exit_code: ${params.exitCode}`);
  }
  lines.push(`recent_output:\n${params.recentOutput}`);
  return lines.join("\n");
}

async function handleInboundMessage(params: {
  message: InboundWechatMessage;
  options: BridgeCliOptions;
  stateStore: BridgeStateStore;
  adapter: BridgeAdapter;
  queueWechatMessage: (senderId: string, text: string) => Promise<void>;
  outputBatcher: OutputBatcher;
}): Promise<ActiveTask | null> {
  const { message, options, stateStore, adapter, queueWechatMessage, outputBatcher } = params;
  const state = stateStore.getState();
  const systemCommand = parseSystemCommand(message.text);

  if (message.senderId !== state.authorizedUserId) {
    await queueWechatMessage(
      message.senderId,
      "Unauthorized. This bridge only accepts messages from the configured WeChat owner.",
    );
    return null;
  }

  switch (systemCommand?.type) {
    case "status":
      await queueWechatMessage(
        message.senderId,
        formatStatusReport(stateStore.getState(), adapter.getState()),
      );
      return null;
    case "resume": {
      if (options.adapter === "codex") {
        await queueWechatMessage(
          message.senderId,
          'WeChat /resume is disabled in codex mode. Use /resume directly inside "wechat-codex"; WeChat will follow the active local thread.',
        );
        return null;
      }

      await queueWechatMessage(
        message.senderId,
        "/resume is only supported when the bridge is running in codex mode.",
      );
      return null;
    }
    case "stop": {
      const interrupted = await adapter.interrupt();
      await queueWechatMessage(
        message.senderId,
        interrupted
          ? "Interrupt signal sent to the active worker."
          : "No running worker was available to interrupt.",
      );
      return null;
    }
    case "reset":
      await outputBatcher.flushNow();
      outputBatcher.clear();
      stateStore.clearPendingConfirmation();
      stateStore.clearSharedThreadId();
      await adapter.reset();
      stateStore.appendLog("Worker reset by owner.");
      await queueWechatMessage(message.senderId, "Worker session has been reset.");
      return null;
    case "confirm": {
      const pending = state.pendingConfirmation;
      if (!pending) {
        await queueWechatMessage(message.senderId, "No pending approval request.");
        return null;
      }
      if (pending.code !== systemCommand.code) {
        await queueWechatMessage(message.senderId, "Confirmation code did not match.");
        return null;
      }
      const confirmed = await adapter.resolveApproval("confirm");
      if (!confirmed) {
        await queueWechatMessage(
          message.senderId,
          "The worker could not apply this approval request.",
        );
        return null;
      }
      stateStore.clearPendingConfirmation();
      stateStore.appendLog(`Approval confirmed: ${pending.commandPreview}`);
      await queueWechatMessage(message.senderId, "Approval confirmed. Continuing...");
      return {
        startedAt: Date.now(),
        inputPreview: pending.commandPreview,
      };
    }
    case "deny": {
      const pending = state.pendingConfirmation;
      if (!pending) {
        await queueWechatMessage(message.senderId, "No pending approval request.");
        return null;
      }
      const denied = await adapter.resolveApproval("deny");
      if (!denied) {
        await queueWechatMessage(
          message.senderId,
          "The worker could not deny this approval request cleanly.",
        );
        return null;
      }
      stateStore.clearPendingConfirmation();
      stateStore.appendLog(`Approval denied: ${pending.commandPreview}`);
      await queueWechatMessage(message.senderId, "Approval denied.");
      return null;
    }
  }

  if (state.pendingConfirmation) {
    await queueWechatMessage(
      message.senderId,
      `Approval is pending for ${state.pendingConfirmation.commandPreview}. Reply with /confirm ${state.pendingConfirmation.code} or /deny.`,
    );
    return null;
  }

  const adapterState = adapter.getState();
  if (adapterState.status === "busy") {
    if (options.adapter === "codex" && adapterState.activeTurnOrigin === "local") {
      await queueWechatMessage(
        message.senderId,
        "codex is currently busy with a local terminal turn. Wait for it to finish or use /stop.",
      );
      return null;
    }

    await queueWechatMessage(
      message.senderId,
      `${options.adapter} is still working. Wait for the current reply or use /stop.`,
    );
    return null;
  }

  const activeTask = {
    startedAt: Date.now(),
    inputPreview: truncatePreview(message.text, 180),
  };
  stateStore.appendLog(`Forwarded input to ${options.adapter}: ${truncatePreview(message.text)}`);
  await adapter.sendInput(message.text);
  return activeTask;
}

main().catch((err) => {
  logError(String(err));
  process.exit(1);
});
