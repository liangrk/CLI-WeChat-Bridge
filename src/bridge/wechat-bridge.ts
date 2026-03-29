#!/usr/bin/env bun

import path from "node:path";

import {
  createBridgeAdapter,
  resolveDefaultAdapterCommand,
} from "./bridge-adapters.ts";
import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";
import { BridgeStateStore } from "./bridge-state.ts";
import type {
  BridgeAdapter,
  BridgeAdapterKind,
  PendingApproval,
} from "./bridge-types.ts";
import {
  buildOneTimeCode,
  formatApprovalMessage,
  formatPendingApprovalReminder,
  formatDuration,
  formatFinalReplyMessage,
  formatMirroredUserInputMessage,
  formatSessionSwitchMessage,
  formatStatusReport,
  formatTaskFailedMessage,
  MESSAGE_START_GRACE_MS,
  nowIso,
  OutputBatcher,
  parseWechatControlCommand,
  truncatePreview,
} from "./bridge-utils.ts";
import {
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  WeChatSessionExpiredError,
  WeChatTransport,
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";

const POLL_RETRY_DELAY_MS = 2_000;
const POLL_RETRY_JITTER_MS = 1_000;
const POLL_MAX_CONSECUTIVE_FAILURES = 5;

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

  const defaultCommand = resolveDefaultAdapterCommand(adapter);
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
      "  wechat-bridge-claude --cwd ~/work/my-project",
      "  wechat-bridge-shell --cmd pwsh",
      "  wechat-bridge-shell --cmd bash",
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
    initialSharedSessionId:
      stateStore.getState().sharedSessionId ?? stateStore.getState().sharedThreadId,
    initialResumeConversationId: stateStore.getState().resumeConversationId,
    initialTranscriptPath: stateStore.getState().transcriptPath,
  });
  let sendChain = Promise.resolve();
  let replySendChain = Promise.resolve();
  let activeTask: ActiveTask | null = null;
  let lastOutputAt = 0;
  let lastHeartbeatAt = 0;

  // --- Rate-limit detection and pending message queue ---

  function isRateLimitError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    if (/\bHTTP\s+429\b/.test(msg)) return true;
    if (/\berrcode["\s:]*-?\d+/.test(msg) && /限[频流]|too\s+(many|frequent)|rate/i.test(msg)) return true;
    return false;
  }

  interface PendingMessage {
    senderId: string;
    text: string;
    channel: string;
  }

  let pendingMessages: PendingMessage[] = [];
  let rateLimitBackoffMs = 2_000;
  const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;
  let pendingPollTimer: ReturnType<typeof setTimeout> | null = null;
  let isRateLimited = false;

  function enqueuePending(senderId: string, text: string, channel: string): void {
    pendingMessages.push({ senderId, text, channel });
    log(`Rate limited, queued message (${pendingMessages.length} pending)`);
    startPendingPoll();
  }

  function startPendingPoll(): void {
    if (pendingPollTimer) return;
    pendingPollTimer = setTimeout(flushPendingQueue, rateLimitBackoffMs);
  }

  async function flushPendingQueue(): Promise<void> {
    pendingPollTimer = null;
    if (pendingMessages.length === 0) {
      isRateLimited = false;
      rateLimitBackoffMs = 2_000;
      return;
    }

    const msg = pendingMessages[0];
    try {
      await transport.sendText(msg.senderId, msg.text);
      pendingMessages.shift();
      log(`${msg.channel} pending sent (${pendingMessages.length} remaining)`);
      rateLimitBackoffMs = 2_000;
    } catch (err) {
      if (isRateLimitError(err)) {
        rateLimitBackoffMs = Math.min(rateLimitBackoffMs * 2, RATE_LIMIT_MAX_BACKOFF_MS);
        log(`Still rate limited, backing off to ${rateLimitBackoffMs}ms`);
      } else {
        logError(`Pending send failed: ${err instanceof Error ? err.message : err}`);
        pendingMessages.shift();
      }
    }

    if (pendingMessages.length > 0) {
      startPendingPoll();
    } else {
      isRateLimited = false;
      rateLimitBackoffMs = 2_000;
    }
  }

  const sendWithRetry = async (senderId: string, text: string, channel?: string) => {
    if (isRateLimited) {
      enqueuePending(senderId, text, channel ?? "queued");
      return;
    }

    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await transport.sendText(senderId, text);
        if (channel) log(`${channel} message sent: ${truncatePreview(text, 80)}`);
        return;
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        if (isRateLimitError(err)) {
          isRateLimited = true;
          enqueuePending(senderId, text, channel ?? "sendChain");
          return;
        }
        if (attempt < maxRetries) {
          logError(`WeChat send failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying: ${errorText}`);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        } else {
          logError(`Failed to send WeChat reply after ${maxRetries + 1} attempts: ${errorText}`);
        }
      }
    }
  };

  const queueWechatMessage = (senderId: string, text: string) => {
    sendChain = sendChain.then(() => sendWithRetry(senderId, text, "sendChain"));
    return sendChain;
  };

  // Channel B: independent send chain for final replies, not blocked by Channel A.
  const queueReplyMessage = (senderId: string, text: string) => {
    replySendChain = replySendChain.then(() => sendWithRetry(senderId, text, "reply"));
    return replySendChain;
  };

  const outputBatcher = new OutputBatcher(
    async (text) => {
      await queueWechatMessage(stateStore.getState().authorizedUserId, text);
    },
    1_000,
    1_200,
    (err, text) => {
      logError(`OutputBatcher flush failed, re-enqueuing: ${String(err)}`);
      void queueWechatMessage(stateStore.getState().authorizedUserId, text);
    },
  );

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
      queueReplyMessage,
      getActiveTask: () => activeTask,
      clearActiveTask: () => {
        activeTask = null;
        lastHeartbeatAt = 0;
      },
      updateLastOutputAt: () => {
        lastOutputAt = Date.now();
      },
      syncSharedSessionState: () => {
        syncSharedSessionState(stateStore, adapter);
      },
    });

    await adapter.start();
    syncSharedSessionState(stateStore, adapter);
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
    } else if (options.adapter === "claude") {
      log(
        'Start the visible Claude companion in a second terminal with: wechat-claude',
      );
    }

    let consecutivePollFailures = 0;

    while (true) {
      let pollResult;
      try {
        pollResult = await transport.pollMessages({
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          minCreatedAtMs: stateStore.getState().bridgeStartedAtMs - MESSAGE_START_GRACE_MS,
        });
        consecutivePollFailures = 0;
      } catch (err) {
        if (err instanceof WeChatSessionExpiredError) {
          logError(err.message);
          break;
        }

        consecutivePollFailures++;
        const errorText = err instanceof Error ? err.message : String(err);
        logError(`Poll error (attempt ${consecutivePollFailures}): ${errorText}`);
        stateStore.appendLog(`poll_error: attempt=${consecutivePollFailures} error=${errorText}`);

        if (consecutivePollFailures === POLL_MAX_CONSECUTIVE_FAILURES) {
          await queueWechatMessage(
            stateStore.getState().authorizedUserId,
            `Bridge is experiencing persistent connection errors (${consecutivePollFailures} failures). Will keep retrying. Use /status to check.`,
          );
        }

        const jitter = Math.floor(Math.random() * POLL_RETRY_JITTER_MS);
        await new Promise((resolve) => setTimeout(resolve, POLL_RETRY_DELAY_MS + jitter));
        continue;
      }

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
        syncSharedSessionState(stateStore, adapter);
      }

      const adapterState = adapter.getState();
      const lastSignalAt = Math.max(lastHeartbeatAt, lastOutputAt || activeTask?.startedAt || 0);

      if (
        activeTask &&
        options.adapter === "shell" &&
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

function syncSharedSessionState(
  stateStore: BridgeStateStore,
  adapter: BridgeAdapter,
): void {
  const persistedState = stateStore.getState();
  const persistedSessionId = persistedState.sharedSessionId ?? persistedState.sharedThreadId;
  const adapterState = adapter.getState();
  const adapterSessionId = adapterState.sharedSessionId ?? adapterState.sharedThreadId;

  if (adapterSessionId && adapterSessionId !== persistedSessionId) {
    stateStore.setSharedSessionId(adapterSessionId);
  } else if (!adapterSessionId && persistedSessionId) {
    stateStore.clearSharedSessionId();
  }

  if (persistedState.adapter !== "claude") {
    return;
  }

  if (
    adapterState.resumeConversationId !== persistedState.resumeConversationId ||
    adapterState.transcriptPath !== persistedState.transcriptPath
  ) {
    if (adapterState.resumeConversationId || adapterState.transcriptPath) {
      stateStore.setClaudeResumeState(
        adapterState.resumeConversationId,
        adapterState.transcriptPath,
      );
    } else {
      stateStore.clearClaudeResumeState();
    }
  }
}

function wireAdapterEvents(params: {
  adapter: BridgeAdapter;
  options: BridgeCliOptions;
  stateStore: BridgeStateStore;
  outputBatcher: OutputBatcher;
  queueWechatMessage: (senderId: string, text: string) => Promise<void>;
  queueReplyMessage: (senderId: string, text: string) => Promise<void>;
  getActiveTask: () => ActiveTask | null;
  clearActiveTask: () => void;
  updateLastOutputAt: () => void;
  syncSharedSessionState: () => void;
}): void {
  const {
    adapter,
    options,
    stateStore,
    outputBatcher,
    queueWechatMessage,
    queueReplyMessage,
    getActiveTask,
    clearActiveTask,
    updateLastOutputAt,
    syncSharedSessionState,
  } = params;

  adapter.setEventSink((event) => {
    syncSharedSessionState();
    const adapterState = adapter.getState();
    const authorizedUserId = stateStore.getState().authorizedUserId;

    const flushAndSend = async (text: string, label?: string) => {
      const tag = label ? `[${label}] ` : "";
      log(`${tag}flushAndSend: text length: ${text.length}`);
      try {
        await outputBatcher.flushNow();
      } catch (err) {
        logError(`${tag}flushAndSend: flush failed: ${String(err)}`);
      }
      await queueWechatMessage(authorizedUserId, text);
      log(`${tag}flushAndSend: queued to sendChain`);
    };

    switch (event.type) {
      case "stdout":
      case "stderr":
        updateLastOutputAt();
        outputBatcher.push(event.text);
        break;
      case "final_reply":
        log(`event: final_reply, text length: ${event.text.length}`);
        void queueReplyMessage(authorizedUserId, formatFinalReplyMessage(options.adapter, event.text));
        break;
      case "status":
        if (event.message) {
          log(`${event.status}: ${event.message}`);
          stateStore.appendLog(`${event.status}: ${event.message}`);
        }
        if (
          event.status === "awaiting_approval" &&
          !stateStore.getState().pendingConfirmation
        ) {
          const pendingApproval = adapter.getState().pendingApproval;
          if (pendingApproval) {
            const pending: PendingApproval = {
              ...pendingApproval,
              code: buildOneTimeCode(),
              createdAt: nowIso(),
            };
            stateStore.setPendingConfirmation(pending);
            stateStore.appendLog(
              `Approval requested (fallback): ${pending.commandPreview}`,
            );
            void flushAndSend(
              formatApprovalMessage(pending, adapterState),
              "approval",
            );
          }
        }
        break;
      case "notice":
        updateLastOutputAt();
        log(`event: notice (${event.level}): ${truncatePreview(event.text, 80)}`);
        stateStore.appendLog(`${event.level}_notice: ${truncatePreview(event.text)}`);
        void flushAndSend(event.text, "notice");
        break;
      case "approval_required": {
        log(`event: approval_required, tool: ${event.request.toolName ?? "unknown"}, source: ${event.request.source}`);
        const pending: PendingApproval = {
          ...event.request,
          code: buildOneTimeCode(),
          createdAt: nowIso(),
        };
        stateStore.setPendingConfirmation(pending);
        stateStore.appendLog(
          `Approval requested (${pending.source}): ${pending.commandPreview}`,
        );
        void flushAndSend(formatApprovalMessage(pending, adapterState), "approval");
        break;
      }
      case "mirrored_user_input":
        stateStore.appendLog(`mirrored_local_input: ${truncatePreview(event.text)}`);
        void flushAndSend(formatMirroredUserInputMessage(options.adapter, event.text), "mirror");
        break;
      case "session_switched":
        stateStore.appendLog(
          `session_switched: ${event.sessionId} source=${event.source} reason=${event.reason}`,
        );
        void flushAndSend(
          formatSessionSwitchMessage({
            adapter: options.adapter,
            sessionId: event.sessionId,
            source: event.source,
            reason: event.reason,
          }),
          "session",
        );
        break;
      case "thread_switched":
        stateStore.appendLog(
          `thread_switched: ${event.threadId} source=${event.source} reason=${event.reason}`,
        );
        void flushAndSend(
          formatSessionSwitchMessage({
            adapter: options.adapter,
            sessionId: event.threadId,
            source: event.source,
            reason: event.reason,
          }),
          "thread",
        );
        break;
      case "task_complete":
        stateStore.clearPendingConfirmation();
        clearActiveTask();
        log(`event: task_complete`);
        if (options.adapter === "shell") {
          const summary = buildCompletionSummary({
            adapter: options.adapter,
            activeTask: getActiveTask(),
            exitCode: event.exitCode,
            recentOutput: outputBatcher.getRecentSummary(),
          });
          void flushAndSend(summary, "complete");
        } else {
          void outputBatcher.flushNow().catch(() => {});
        }
        break;
      case "task_failed":
        stateStore.clearPendingConfirmation();
        clearActiveTask();
        log(`event: task_failed: ${truncatePreview(event.message, 80)}`);
        void flushAndSend(formatTaskFailedMessage(options.adapter, event.message), "failed");
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
  const systemCommand = parseWechatControlCommand(message.text, {
    adapter: options.adapter,
    hasPendingConfirmation: Boolean(state.pendingConfirmation),
  });

  if (message.senderId !== state.authorizedUserId) {
    await queueWechatMessage(
      message.senderId,
      "Unauthorized. This bridge only accepts messages from the configured WeChat owner.",
    );
    return null;
  }

  // AskUserQuestion: handle option selection and custom text before the command switch.
  const pendingAskUser = state.pendingConfirmation;
  if (
    pendingAskUser?.toolName === "AskUserQuestion" &&
    pendingAskUser.askUserQuestions &&
    pendingAskUser.askUserQuestions.length > 0
  ) {
    const input = message.text.trim();

    if (systemCommand?.type === "deny") {
      // Fall through to the switch deny handler below.
    } else if (systemCommand?.type === "confirm") {
      await queueWechatMessage(
        message.senderId,
        "Please select an option by number (e.g. 1) or type your answer. Reply with /deny to reject.",
      );
      return null;
    } else {
      const numericMatch = input.match(/^[\d,.\s]+$/);
      let responseText: string;

      if (numericMatch) {
        const indices = input
          .split(/[,.\s]+/)
          .map(Number)
          .filter((n) => n >= 1 && n <= pendingAskUser.askUserQuestions!.length);
        if (indices.length > 0) {
          responseText = indices
            .map((i) => pendingAskUser.askUserQuestions![i - 1].label)
            .join("\n");
        } else {
          responseText = input;
        }
      } else {
        responseText = input;
      }

      const confirmed = await adapter.resolveApproval("confirm", responseText);
      if (!confirmed) {
        await queueWechatMessage(
          message.senderId,
          "The worker could not apply this approval request.",
        );
        return null;
      }
      stateStore.clearPendingConfirmation();
      stateStore.appendLog(`AskUserQuestion answered: ${truncatePreview(responseText, 80)}`);
      await queueWechatMessage(message.senderId, "Option sent. Continuing...");
      return {
        startedAt: Date.now(),
        inputPreview: pendingAskUser.commandPreview,
      };
    }
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
      if (options.adapter === "claude") {
        await queueWechatMessage(
          message.senderId,
          'WeChat /resume is disabled in claude mode. Use /resume directly inside "wechat-claude"; WeChat will follow the active local session.',
        );
        return null;
      }

      await queueWechatMessage(
        message.senderId,
        `/resume is not available in ${options.adapter} mode.`,
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
      stateStore.clearSharedSessionId();
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
      if (options.adapter !== "claude" && pending.code !== systemCommand.code) {
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
      formatPendingApprovalReminder(state.pendingConfirmation, adapter.getState()),
    );
    return null;
  }

  const adapterState = adapter.getState();
  if (adapterState.status === "busy" || adapterState.status === "awaiting_approval") {
    if (options.adapter === "codex" && adapterState.activeTurnOrigin === "local") {
      await queueWechatMessage(
        message.senderId,
        "codex is currently busy with a local terminal turn. Wait for it to finish or use /stop.",
      );
      return null;
    }

    try {
      await adapter.sendInput(message.text);
      const queueInfo = ("getQueueInfo" in adapter && typeof adapter.getQueueInfo === "function")
        ? (adapter as { getQueueInfo(): { queuedCount: number; pendingQueueLength: number } }).getQueueInfo()
        : null;
      const queuedCount = queueInfo?.queuedCount ?? 0;
      const isApprovalQueue = queueInfo?.pendingQueueLength != null && queueInfo.pendingQueueLength > 0;
      if (isApprovalQueue) {
        await queueWechatMessage(
          message.senderId,
          queuedCount > 0
            ? `Message queued (position ${queuedCount}). Will be sent after approval is resolved.`
            : "Message queued. Will be sent after approval is resolved.",
        );
      } else {
        await queueWechatMessage(
          message.senderId,
          "Message queued.",
        );
      }
      return null;
    } catch {
      await queueWechatMessage(
        message.senderId,
        `${options.adapter} is still working. Wait for the current reply or use /stop.`,
      );
      return null;
    }
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
