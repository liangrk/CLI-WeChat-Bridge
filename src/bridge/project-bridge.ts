import {
  createBridgeAdapter,
} from "./bridge-adapters.ts";
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
  nowIso,
  OutputBatcher,
  parseWechatControlCommand,
  truncatePreview,
} from "./bridge-utils.ts";
import type { InboundWechatMessage } from "../wechat/wechat-transport.ts";
import { getWorkspaceLockFilePath } from "../wechat/channel-config.ts";

export type ProjectBridgeOptions = {
  projectId: string;
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  authorizedUserId: string;
};

export type ActiveTask = {
  startedAt: number;
  inputPreview: string;
};

export class ProjectBridge {
  readonly projectId: string;
  private readonly options: ProjectBridgeOptions;
  private readonly stateStore: BridgeStateStore;
  private readonly adapter: BridgeAdapter;
  private readonly outputBatcher: OutputBatcher;

  private activeTask: ActiveTask | null = null;
  private lastOutputAt = 0;
  private lastHeartbeatAt = 0;
  private sendChain = Promise.resolve();
  private _disposed = false;

  constructor(
    options: ProjectBridgeOptions,
    private readonly onSendToWechat: (senderId: string, text: string) => Promise<void>,
  ) {
    this.projectId = options.projectId;
    this.options = options;

    this.stateStore = new BridgeStateStore({
      adapter: options.adapter,
      command: options.command,
      cwd: options.cwd,
      profile: options.profile,
      authorizedUserId: options.authorizedUserId,
      lockFilePath: getWorkspaceLockFilePath(options.cwd),
    });

    this.adapter = createBridgeAdapter({
      kind: options.adapter,
      command: options.command,
      cwd: options.cwd,
      profile: options.profile,
      initialSharedSessionId:
        this.stateStore.getState().sharedSessionId ?? this.stateStore.getState().sharedThreadId,
      initialResumeConversationId: this.stateStore.getState().resumeConversationId,
      initialTranscriptPath: this.stateStore.getState().transcriptPath,
    });

    this.outputBatcher = new OutputBatcher(async (text) => {
      await this.queueMessage(this.stateStore.getState().authorizedUserId, text);
    });
  }

  private queueMessage(senderId: string, text: string): Promise<void> {
    const tagged = `[${this.projectId}] ${text}`;
    this.sendChain = this.sendChain
      .then(() => this.onSendToWechat(senderId, tagged))
      .catch(() => undefined);
    return this.sendChain;
  }

  async start(): Promise<void> {
    this.wireAdapterEvents();
    await this.adapter.start();
    this.syncSharedSessionState();
  }

  async stop(): Promise<void> {
    this._disposed = true;
    try {
      await this.outputBatcher.flushNow();
    } catch { /* best effort */ }
    try {
      await this.adapter.dispose();
    } catch { /* best effort */ }
    this.stateStore.releaseLock();
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  getAdapterState() {
    return this.adapter.getState();
  }

  getState() {
    return this.stateStore.getState();
  }

  getActiveTask(): ActiveTask | null {
    return this.activeTask;
  }

  async handleInboundMessage(message: InboundWechatMessage): Promise<ActiveTask | null> {
    const state = this.stateStore.getState();
    const systemCommand = parseWechatControlCommand(message.text, {
      adapter: this.options.adapter,
      hasPendingConfirmation: Boolean(state.pendingConfirmation),
    });

    if (message.senderId !== state.authorizedUserId) {
      await this.queueMessage(message.senderId, "Unauthorized.");
      return null;
    }

    switch (systemCommand?.type) {
      case "status":
        await this.queueMessage(
          message.senderId,
          formatStatusReport(this.stateStore.getState(), this.adapter.getState()),
        );
        return null;
      case "stop": {
        const interrupted = await this.adapter.interrupt();
        await this.queueMessage(
          message.senderId,
          interrupted ? "Interrupt signal sent." : "No running worker to interrupt.",
        );
        return null;
      }
      case "reset":
        await this.outputBatcher.flushNow();
        this.outputBatcher.clear();
        this.stateStore.clearPendingConfirmation();
        this.stateStore.clearSharedSessionId();
        await this.adapter.reset();
        await this.queueMessage(message.senderId, "Worker session has been reset.");
        return null;
      case "confirm": {
        const pending = state.pendingConfirmation;
        if (!pending) {
          await this.queueMessage(message.senderId, "No pending approval request.");
          return null;
        }
        if (this.options.adapter !== "claude" && pending.code !== systemCommand.code) {
          await this.queueMessage(message.senderId, "Confirmation code did not match.");
          return null;
        }
        const confirmed = await this.adapter.resolveApproval("confirm");
        if (!confirmed) {
          await this.queueMessage(message.senderId, "Could not apply this approval request.");
          return null;
        }
        this.stateStore.clearPendingConfirmation();
        await this.queueMessage(message.senderId, "Approval confirmed. Continuing...");
        return { startedAt: Date.now(), inputPreview: pending.commandPreview };
      }
      case "deny": {
        const pending = state.pendingConfirmation;
        if (!pending) {
          await this.queueMessage(message.senderId, "No pending approval request.");
          return null;
        }
        const denied = await this.adapter.resolveApproval("deny");
        if (!denied) {
          await this.queueMessage(message.senderId, "Could not deny this approval request.");
          return null;
        }
        this.stateStore.clearPendingConfirmation();
        await this.queueMessage(message.senderId, "Approval denied.");
        return null;
      }
      case "resume":
        await this.queueMessage(
          message.senderId,
          "/resume is disabled in multi-project mode. Use the companion terminal directly.",
        );
        return null;
    }

    if (state.pendingConfirmation) {
      await this.queueMessage(
        message.senderId,
        formatPendingApprovalReminder(state.pendingConfirmation, this.adapter.getState()),
      );
      return null;
    }

    const adapterState = this.adapter.getState();
    if (adapterState.status === "busy" || adapterState.status === "awaiting_approval") {
      try {
        await this.adapter.sendInput(message.text);
        await this.queueMessage(message.senderId, "Message queued.");
      } catch {
        await this.queueMessage(
          message.senderId,
          `${this.options.adapter} is still working. Wait or use /stop.`,
        );
      }
      return null;
    }

    const task: ActiveTask = {
      startedAt: Date.now(),
      inputPreview: truncatePreview(message.text, 180),
    };
    this.stateStore.appendLog(`Forwarded input to ${this.options.adapter}: ${truncatePreview(message.text)}`);
    await this.adapter.sendInput(message.text);
    return task;
  }

  private wireAdapterEvents(): void {
    const authorizedUserId = this.stateStore.getState().authorizedUserId;

    this.adapter.setEventSink((event) => {
      this.syncSharedSessionState();
      const adapterState = this.adapter.getState();
      const bridgeState = this.stateStore.getState();
      if (bridgeState.pendingConfirmation && !adapterState.pendingApproval) {
        this.stateStore.clearPendingConfirmation();
      }

      switch (event.type) {
        case "stdout":
        case "stderr":
          this.lastOutputAt = Date.now();
          this.outputBatcher.push(event.text);
          break;
        case "final_reply":
          void this.outputBatcher.flushNow().then(async () => {
            await this.queueMessage(
              authorizedUserId,
              formatFinalReplyMessage(this.options.adapter, event.text),
            );
          });
          break;
        case "status":
          if (event.message) {
            this.stateStore.appendLog(`${event.status}: ${event.message}`);
          }
          break;
        case "notice":
          this.lastOutputAt = Date.now();
          void this.outputBatcher.flushNow().then(async () => {
            await this.queueMessage(authorizedUserId, event.text);
          });
          break;
        case "approval_required":
          void this.outputBatcher.flushNow().then(async () => {
            const pending: PendingApproval = {
              ...event.request,
              code: buildOneTimeCode(),
              createdAt: nowIso(),
            };
            this.stateStore.setPendingConfirmation(pending);
            await this.queueMessage(
              authorizedUserId,
              formatApprovalMessage(pending, adapterState),
            );
          });
          break;
        case "mirrored_user_input":
          void this.outputBatcher.flushNow().then(async () => {
            await this.queueMessage(
              authorizedUserId,
              formatMirroredUserInputMessage(this.options.adapter, event.text),
            );
          });
          break;
        case "session_switched":
          void this.outputBatcher.flushNow().then(async () => {
            await this.queueMessage(
              authorizedUserId,
              formatSessionSwitchMessage({
                adapter: this.options.adapter,
                sessionId: event.sessionId,
                source: event.source,
                reason: event.reason,
              }),
            );
          });
          break;
        case "thread_switched":
          void this.outputBatcher.flushNow().then(async () => {
            await this.queueMessage(
              authorizedUserId,
              formatSessionSwitchMessage({
                adapter: this.options.adapter,
                sessionId: event.threadId,
                source: event.source,
                reason: event.reason,
              }),
            );
          });
          break;
        case "task_complete":
          void this.outputBatcher.flushNow().then(async () => {
            this.stateStore.clearPendingConfirmation();
            if (this.options.adapter === "shell") {
              const summary = buildCompletionSummary({
                adapter: this.options.adapter,
                activeTask: this.activeTask,
                exitCode: event.exitCode,
                recentOutput: this.outputBatcher.getRecentSummary(),
              });
              await this.queueMessage(authorizedUserId, summary);
            }
            this.activeTask = null;
            this.lastHeartbeatAt = 0;
          });
          break;
        case "task_failed":
          void this.outputBatcher.flushNow().then(async () => {
            this.stateStore.clearPendingConfirmation();
            this.activeTask = null;
            await this.queueMessage(
              authorizedUserId,
              formatTaskFailedMessage(this.options.adapter, event.message),
            );
          });
          break;
        case "fatal_error":
          this.stateStore.clearPendingConfirmation();
          this.activeTask = null;
          void this.queueMessage(authorizedUserId, `Bridge error: ${event.message}`);
          break;
      }
    });
  }

  private syncSharedSessionState(): void {
    const persistedState = this.stateStore.getState();
    const persistedSessionId = persistedState.sharedSessionId ?? persistedState.sharedThreadId;
    const adapterState = this.adapter.getState();
    const adapterSessionId = adapterState.sharedSessionId ?? adapterState.sharedThreadId;

    if (adapterSessionId && adapterSessionId !== persistedSessionId) {
      this.stateStore.setSharedSessionId(adapterSessionId);
    } else if (!adapterSessionId && persistedSessionId) {
      this.stateStore.clearSharedSessionId();
    }

    if (persistedState.adapter !== "claude") return;

    if (
      adapterState.resumeConversationId !== persistedState.resumeConversationId ||
      adapterState.transcriptPath !== persistedState.transcriptPath
    ) {
      if (adapterState.resumeConversationId || adapterState.transcriptPath) {
        this.stateStore.setClaudeResumeState(
          adapterState.resumeConversationId,
          adapterState.transcriptPath,
        );
      } else {
        this.stateStore.clearClaudeResumeState();
      }
    }
  }
}

function buildCompletionSummary(params: {
  adapter: BridgeAdapterKind;
  activeTask: ActiveTask | null;
  exitCode?: number;
  recentOutput: string;
}): string {
  const lines = [`${params.adapter} task complete.`];
  if (params.activeTask) {
    lines.push(`duration: ${formatDuration(Date.now() - params.activeTask.startedAt)}`);
    lines.push(`input: ${params.activeTask.inputPreview}`);
  }
  if (typeof params.exitCode === "number") {
    lines.push(`exit_code: ${params.exitCode}`);
  }
  lines.push(`recent_output:\n${params.recentOutput}`);
  return lines.join("\n");
}
