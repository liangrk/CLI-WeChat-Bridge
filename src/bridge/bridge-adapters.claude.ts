import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { buildLocalCompanionToken } from "../companion/local-companion-link.ts";
import { ensureWorkspaceChannelDir } from "../wechat/channel-config.ts";
import {
  buildClaudeFailureMessage,
  buildClaudeHookScript,
  buildClaudeHookSettings,
  buildClaudePermissionDecisionHookOutput,
  buildClaudePermissionApprovalRequest,
  extractClaudeResumeConversationId,
  findInjectedClaudePromptIndex,
  normalizeClaudeAssistantMessage,
  parseClaudeHookPayload,
  type ClaudeHookPayload,
  type PendingInjectedClaudePrompt,
} from "./claude-hooks.ts";
import type {
  ApprovalRequest,
  BridgeNoticeLevel,
  BridgeResumeSessionCandidate,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
} from "./bridge-types.ts";
import {
  detectCliApproval,
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";
import { AbstractPtyAdapter } from "./bridge-adapters.core.ts";
import * as shared from "./bridge-adapters.shared.ts";
import { isPidAlive } from "./bridge-state.ts";

type AdapterOptions = shared.AdapterOptions;
type ClaudePendingHookApproval = shared.ClaudePendingHookApproval;

const {
  CLAUDE_HOOK_LISTEN_HOST,
  CLAUDE_WECHAT_WORKING_NOTICE_DELAY_MS,
  INTERRUPT_SETTLE_DELAY_MS,
  MODULE_DIR,
  buildClaudeCliArgs,
  isClaudeInvalidResumeError,
  quotePosixCommandArg,
  quoteWindowsCommandArg,
  shouldIncludeClaudeNoAltScreen,
} = shared;

const CLAUDE_STALE_BUSY_CHECK_MS = 60_000;

export class ClaudeCompanionAdapter extends AbstractPtyAdapter {
  private hookServer: net.Server | null = null;
  private hookPort: number | null = null;
  private hookToken: string | null = null;
  private runtimeSessionId: string | null;
  private resumeConversationId: string | null;
  private transcriptPath: string | null;
  private pendingCliApprovalHints:
    | Pick<ApprovalRequest, "confirmInput" | "denyInput">
    | null = null;
  private pendingInjectedInputs: PendingInjectedClaudePrompt[] = [];
  private localTerminalInputListener: ((chunk: string | Buffer) => void) | null = null;
  private resizeListener: (() => void) | null = null;
  private settingsFilePath: string | null = null;
  private readonly pendingHookApprovals = new Map<string, ClaudePendingHookApproval>();
  private recoveringInvalidResume = false;
  private workingNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workingNoticeSent = false;
  private workingNoticeDelayMs = CLAUDE_WECHAT_WORKING_NOTICE_DELAY_MS;
  private pendingInputQueue: string[] = [];
  private queuedInputCount = 0;
  private staleBusyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHookActivityAt = 0;
  private lastPtyOutputAt = 0;
  private ptyApprovalRetryCount = 0;
  private ptyApprovalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PTY_APPROVAL_MAX_RETRIES = 3;
  private static readonly PTY_APPROVAL_RETRY_DELAY_MS = 1_500;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly HEARTBEAT_INTERVAL_MS = 60_000;
  private recoveringFromProcessDeath = false;

  constructor(options: AdapterOptions) {
    super(options);
    this.runtimeSessionId = options.initialSharedSessionId ?? options.initialSharedThreadId ?? null;
    this.resumeConversationId = options.initialResumeConversationId ?? null;
    this.transcriptPath = options.initialTranscriptPath ?? null;
    if (this.runtimeSessionId) {
      this.state.sharedSessionId = this.runtimeSessionId;
      this.state.activeRuntimeSessionId = this.runtimeSessionId;
    }
    if (this.resumeConversationId) {
      this.state.resumeConversationId = this.resumeConversationId;
    }
    if (this.transcriptPath) {
      this.state.transcriptPath = this.transcriptPath;
    }
  }

  override async start(): Promise<void> {
    if (this.pty) {
      return;
    }

    await this.startHookServer();
    try {
      await super.start();
    } catch (error) {
      await this.stopHookServer();
      throw error;
    }
  }

  override async sendInput(text: string): Promise<void> {
    if (!this.pty) {
      throw new Error("claude adapter is not running.");
    }

    if (this.pendingApproval) {
      this.pendingInputQueue.push(text);
      this.queuedInputCount++;
      return;
    }

    const isBusy = this.state.status === "busy";
    if (isBusy) {
      this.queuedInputCount++;
    }

    const normalizedText = normalizeOutput(text).trim();
    this.pendingInjectedInputs.push({
      normalizedText,
      createdAtMs: Date.now(),
    });
    this.pendingInjectedInputs = this.pendingInjectedInputs.slice(-8);
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.pendingCliApprovalHints = null;
    if (!isBusy) {
      this.clearWechatWorkingNotice(true);
      this.setStatus("busy");
    }
    this.writeToPty(text.replace(/\r?\n/g, "\r"));
    this.writeToPty("\r");
    if (!isBusy) {
      this.armWechatWorkingNotice();
      this.armStaleBusyWatchdog();
    }
  }

  getQueueInfo(): { queuedCount: number; pendingQueueLength: number } {
    return { queuedCount: this.queuedInputCount, pendingQueueLength: this.pendingInputQueue.length };
  }

  private flushPendingInputQueue(): void {
    if (this.pendingInputQueue.length === 0) {
      return;
    }
    const nextInput = this.pendingInputQueue.shift()!;
    const normalizedText = normalizeOutput(nextInput).trim();
    this.pendingInjectedInputs.push({
      normalizedText,
      createdAtMs: Date.now(),
    });
    this.pendingInjectedInputs = this.pendingInjectedInputs.slice(-8);
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(nextInput);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.pendingCliApprovalHints = null;
    this.clearWechatWorkingNotice(true);
    this.setStatus("busy");
    this.writeToPty(nextInput.replace(/\r?\n/g, "\r"));
    this.writeToPty("\r");
    this.armWechatWorkingNotice();
    this.armStaleBusyWatchdog();
  }

  override async listResumeSessions(_limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    throw new Error(
      'WeChat /resume is disabled in claude mode. Use /resume directly inside "wechat-claude"; WeChat will follow the active local session.',
    );
  }

  override async resumeSession(_threadId: string): Promise<void> {
    throw new Error(
      'WeChat /resume is disabled in claude mode. Use /resume directly inside "wechat-claude"; WeChat will follow the active local session.',
    );
  }

  override async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }
    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.clearPtyApprovalRetry();
    this.flushPendingClaudeHookApprovals();
    this.clearStaleBusyWatchdog();
    this.clearCompletionTimer();
    this.pendingInputQueue = [];
    this.queuedInputCount = 0;
    this.writeToPty("\u0003");
    this.scheduleTaskComplete(INTERRUPT_SETTLE_DELAY_MS);
    return true;
  }

  override async reset(): Promise<void> {
    this.clearWechatWorkingNotice(true);
    this.clearHeartbeat();
    this.clearStaleBusyWatchdog();
    this.pendingCliApprovalHints = null;
    this.pendingInputQueue = [];
    this.queuedInputCount = 0;
    this.runtimeSessionId = null;
    this.resumeConversationId = null;
    this.transcriptPath = null;
    this.state.sharedSessionId = undefined;
    this.state.sharedThreadId = undefined;
    this.state.activeRuntimeSessionId = undefined;
    this.state.resumeConversationId = undefined;
    this.state.transcriptPath = undefined;
    this.state.lastSessionSwitchAt = undefined;
    this.state.lastSessionSwitchSource = undefined;
    this.state.lastSessionSwitchReason = undefined;
    await super.reset();
  }

  override async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    if (this.pendingApproval.requestId) {
      const handled = this.respondToClaudeHookApproval(this.pendingApproval.requestId, action);
      if (handled) {
        this.clearWechatWorkingNotice();
        this.pendingCliApprovalHints = null;
        this.pendingApproval = null;
        this.state.pendingApproval = null;
        this.state.pendingApprovalOrigin = undefined;
        this.setStatus("busy");
        return true;
      }
    }

    const input =
      action === "confirm"
        ? this.pendingApproval.confirmInput ?? "\r"
        : this.pendingApproval.denyInput ?? "n\r";

    this.clearWechatWorkingNotice();
    this.pendingCliApprovalHints = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.setStatus("busy");
    this.writePtyApprovalWithRetry(input);
    return true;
  }

  override async dispose(): Promise<void> {
    this.detachLocalTerminal();
    this.clearWechatWorkingNotice(true);
    this.clearHeartbeat();
    this.clearStaleBusyWatchdog();
    this.clearPtyApprovalRetry();
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    await super.dispose();
    await this.stopHookServer();
  }

  protected buildSpawnArgs(): string[] {
    if (!this.settingsFilePath) {
      throw new Error("Claude companion settings are not ready.");
    }

    return buildClaudeCliArgs({
      settingsFilePath: this.settingsFilePath,
      resumeConversationId: this.resumeConversationId,
      profile: this.options.profile,
      includeNoAltScreen: shouldIncludeClaudeNoAltScreen(this.options.command),
      dangerouslySkipPermissions: this.options.dangerouslySkipPermissions,
    });
  }

  protected override afterStart(): void {
    this.attachLocalTerminal();
    this.resizePtyToTerminal();
    this.armHeartbeat();
  }

  protected override handleData(rawText: string): void {
    this.renderLocalOutput(rawText);

    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    if (
      this.resumeConversationId &&
      !this.hasAcceptedInput &&
      !this.recoveringInvalidResume &&
      isClaudeInvalidResumeError(text)
    ) {
      void this.recoverFromInvalidResume(this.resumeConversationId);
      return;
    }

    this.state.lastOutputAt = nowIso();
    this.lastPtyOutputAt = Date.now();
    const approval = detectCliApproval(text);
    if (approval) {
      this.clearWechatWorkingNotice();
      if (this.pendingApproval) {
        this.pendingApproval = {
          ...this.pendingApproval,
          confirmInput: this.pendingApproval.confirmInput ?? approval.confirmInput,
          denyInput: this.pendingApproval.denyInput ?? approval.denyInput,
        };
        this.state.pendingApproval = this.pendingApproval;
      } else {
        this.pendingCliApprovalHints = {
          confirmInput: approval.confirmInput,
          denyInput: approval.denyInput,
        };
      }
      return;
    }

    if (!this.hasAcceptedInput) {
      return;
    }

    // Emit stdout for WeChat delivery as a streaming backup alongside
    // the structured Stop hook's final_reply. The OutputBatcher handles
    // deduplication and chunking.
    this.emit({
      type: "stdout",
      text,
      timestamp: nowIso(),
    });

    if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
      this.armStaleBusyWatchdog();
    }
  }

  protected override handleExit(exitCode: number | undefined): void {
    this.detachLocalTerminal();
    this.clearWechatWorkingNotice(true);
    this.clearHeartbeat();
    this.pendingCliApprovalHints = null;
    void this.stopHookServer();
    if (this.recoveringInvalidResume && !this.shuttingDown) {
      this.clearCompletionTimer();
      this.clearStaleBusyWatchdog();
      this.pty = null;
      this.state.status = "stopped";
      this.state.pid = undefined;
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      return;
    }
    if (this.recoveringFromProcessDeath || this.shuttingDown) {
      super.handleExit(exitCode);
      return;
    }
    super.handleExit(exitCode);
    void this.handleClaudeProcessDeath();
  }

  private async startHookServer(): Promise<void> {
    if (this.hookServer) {
      return;
    }

    this.hookToken = buildLocalCompanionToken();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.setKeepAlive(true, 30_000);
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          buffer += chunk;
          while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex < 0) {
              break;
            }

            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) {
              continue;
            }

            try {
              const envelope = JSON.parse(line) as {
                token?: string;
                requestId?: string;
                payload?: string;
              };
              if (
                envelope.token === this.hookToken &&
                typeof envelope.requestId === "string" &&
                typeof envelope.payload === "string"
              ) {
                this.handleClaudeHookEnvelope({
                  requestId: envelope.requestId,
                  rawPayload: envelope.payload,
                  socket,
                });
              }
            } catch {
              // Ignore malformed hook payloads.
            }
          }
        });
        const cleanupPendingRequestsForSocket = () => {
          for (const [requestId, pending] of this.pendingHookApprovals.entries()) {
            if (pending.socket === socket) {
              this.pendingHookApprovals.delete(requestId);
              this.handleClosedClaudeHookApproval(requestId);
            }
          }
        };
        socket.once("close", cleanupPendingRequestsForSocket);
        socket.once("error", cleanupPendingRequestsForSocket);
      });

      this.hookServer = server;
      server.once("error", (error) => {
        reject(error);
      });
      server.listen(0, CLAUDE_HOOK_LISTEN_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate a local Claude hook port."));
          return;
        }

        this.hookPort = address.port;
        try {
          this.writeClaudeRuntimeFiles();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private async stopHookServer(): Promise<void> {
    this.flushPendingClaudeHookApprovals();
    if (!this.hookServer) {
      this.hookPort = null;
      this.settingsFilePath = null;
      return;
    }

    const server = this.hookServer;
    this.hookServer = null;
    this.hookPort = null;
    this.settingsFilePath = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private writeClaudeRuntimeFiles(): void {
    if (!this.hookPort || !this.hookToken) {
      throw new Error("Claude hook server is not ready.");
    }

    const { workspaceDir } = ensureWorkspaceChannelDir(this.options.cwd);
    const runtimeDir = path.join(workspaceDir, "claude-runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });

    const hookScriptPath = path.join(
      runtimeDir,
      process.platform === "win32" ? "hook.cmd" : "hook.sh",
    );
    const settingsFilePath = path.join(runtimeDir, "settings.json");
    const hookEntryPath = path.join(MODULE_DIR, "claude-hook.ts");

    fs.writeFileSync(
      hookScriptPath,
      buildClaudeHookScript({
        platform: process.platform,
        runtimeExecPath: process.execPath,
        hookEntryPath,
        hookPort: this.hookPort,
        hookToken: this.hookToken,
      }),
      "utf8",
    );
    if (process.platform !== "win32") {
      fs.chmodSync(hookScriptPath, 0o755);
    }

    const hookCommand =
      process.platform === "win32"
        ? quoteWindowsCommandArg(hookScriptPath)
        : quotePosixCommandArg(hookScriptPath);
    fs.writeFileSync(
      settingsFilePath,
      JSON.stringify(
        buildClaudeHookSettings(hookCommand, {
          skipPermissionHooks: this.options.dangerouslySkipPermissions ?? false,
        }),
        null,
        2,
      ),
      "utf8",
    );
    this.settingsFilePath = settingsFilePath;
  }

  private attachLocalTerminal(): void {
    if (this.localTerminalInputListener || !this.pty) {
      return;
    }

    this.localTerminalInputListener = (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.writeToPty(text);
    };
    process.stdin.on("data", this.localTerminalInputListener);
    process.stdin.resume();
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }

    this.resizeListener = () => {
      this.resizePtyToTerminal();
    };
    if (process.stdout.isTTY) {
      process.stdout.on("resize", this.resizeListener);
    }
  }

  private detachLocalTerminal(): void {
    if (this.localTerminalInputListener) {
      process.stdin.off("data", this.localTerminalInputListener);
      this.localTerminalInputListener = null;
    }
    if (this.resizeListener) {
      process.stdout.off("resize", this.resizeListener);
      this.resizeListener = null;
    }
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  }

  private resizePtyToTerminal(): void {
    if (!this.pty || !process.stdout.isTTY) {
      return;
    }

    try {
      this.pty.resize(process.stdout.columns || DEFAULT_COLS, process.stdout.rows || DEFAULT_ROWS);
    } catch {
      // Best effort resize sync.
    }
  }

  private renderLocalOutput(rawText: string): void {
    try {
      process.stdout.write(rawText);
    } catch {
      // Best effort local mirroring for the visible Claude companion.
    }
  }

  private armWechatWorkingNotice(): void {
    this.clearWechatWorkingNotice();
    if (
      this.workingNoticeSent ||
      !this.hasAcceptedInput ||
      this.state.status !== "busy" ||
      this.pendingApproval ||
      this.state.activeTurnOrigin !== "wechat"
    ) {
      return;
    }

    this.workingNoticeTimer = setTimeout(() => {
      this.workingNoticeTimer = null;
      if (
        this.workingNoticeSent ||
        !this.hasAcceptedInput ||
        this.state.status !== "busy" ||
        this.pendingApproval ||
        this.state.activeTurnOrigin !== "wechat"
      ) {
        return;
      }

      this.workingNoticeSent = true;
      this.emitClaudeNotice(`Claude is still working on:\n${this.currentPreview}`);
    }, this.workingNoticeDelayMs);
    this.workingNoticeTimer.unref?.();
  }

  private clearWechatWorkingNotice(resetSent = false): void {
    if (this.workingNoticeTimer) {
      clearTimeout(this.workingNoticeTimer);
      this.workingNoticeTimer = null;
    }
    if (resetSent) {
      this.workingNoticeSent = false;
    }
  }

  private emitClaudeNotice(text: string, level: BridgeNoticeLevel = "info"): void {
    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    this.emit({
      type: "notice",
      text: normalized,
      level,
      timestamp: nowIso(),
    });
  }

  private armStaleBusyWatchdog(): void {
    this.clearStaleBusyWatchdog();
    if (
      (this.state.status !== "busy" && this.state.status !== "awaiting_approval") ||
      this.state.activeTurnOrigin !== "wechat"
    ) {
      return;
    }

    this.staleBusyTimer = setTimeout(() => {
      this.staleBusyTimer = null;

      // Status changed away from busy/awaiting_approval — stop monitoring.
      if (
        (this.state.status !== "busy" && this.state.status !== "awaiting_approval") ||
        this.state.activeTurnOrigin !== "wechat"
      ) {
        return;
      }

      // Pending approval — always wait, never recover destructively.
      if (this.pendingApproval) {
        this.armStaleBusyWatchdog();
        return;
      }

      // Process still alive — just slow, re-arm instead of recovering.
      const pid = this.state.pid;
      if (pid && this.pty && isPidAlive(pid)) {
        this.armStaleBusyWatchdog();
        return;
      }

      // Process is dead — trigger recovery.
      this.recoverFromStaleBusyState();
    }, CLAUDE_STALE_BUSY_CHECK_MS);
    this.staleBusyTimer.unref?.();
  }

  private clearStaleBusyWatchdog(): void {
    if (this.staleBusyTimer) {
      clearTimeout(this.staleBusyTimer);
      this.staleBusyTimer = null;
    }
  }

  private recoverFromStaleBusyState(): void {
    this.clearWechatWorkingNotice(true);
    this.clearCompletionTimer();
    this.clearPtyApprovalRetry();
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.pendingInputQueue = [];
    this.queuedInputCount = 0;
    this.currentPreview = "(idle)";
    this.setStatus("idle");
    this.emit({
      type: "task_failed",
      message: "Claude appears to have stopped responding. Recovering from stale busy state. Your message may need to be resent.",
      timestamp: nowIso(),
    });
    this.emit({
      type: "task_complete",
      summary: "(stale busy recovery)",
      timestamp: nowIso(),
    });
  }

  // --- Heartbeat & Auto-Reconnect ---

  private armHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      this.checkClaudeProcessHealth();
    }, ClaudeCompanionAdapter.HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private checkClaudeProcessHealth(): void {
    const pid = this.state.pid;
    if (!pid || !this.pty) {
      return;
    }

    if (isPidAlive(pid)) {
      // Process still alive — re-arm heartbeat
      this.armHeartbeat();
      return;
    }

    // Process is dead — trigger auto-reconnect
    if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
      this.clearStaleBusyWatchdog();
      void this.handleClaudeProcessDeath();
    }
  }

  private async handleClaudeProcessDeath(): Promise<void> {
    if (this.recoveringFromProcessDeath || this.shuttingDown) {
      return;
    }
    this.recoveringFromProcessDeath = true;

    this.clearHeartbeat();
    this.clearStaleBusyWatchdog();
    this.clearCompletionTimer();
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.pendingInputQueue = [];
    this.queuedInputCount = 0;
    this.flushPendingClaudeHookApprovals();

    const hadPendingApproval = Boolean(this.pendingApproval);
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;

    this.emit({
      type: "notice",
      text: "Claude process died unexpectedly. Attempting to restart and resume session...",
      level: "warning",
      timestamp: nowIso(),
    });

    try {
      // Save resume state before dispose clears it
      const savedResumeId = this.resumeConversationId;
      const savedTranscriptPath = this.transcriptPath;

      // dispose() kills the old PTY process
      await this.dispose();

      // Restore resume state so the new process can continue the session
      this.resumeConversationId = savedResumeId;
      this.transcriptPath = savedTranscriptPath;
      this.state.resumeConversationId = savedResumeId ?? undefined;
      this.state.transcriptPath = savedTranscriptPath ?? undefined;

      // start() spawns a new Claude Code process with --resume
      await this.start();

      this.emit({
        type: "notice",
        text: hadPendingApproval
          ? "Claude restarted with session resumed. The previous approval was lost — Claude may re-request it."
          : "Claude restarted with session resumed.",
        level: "info",
        timestamp: nowIso(),
      });
    } catch (err) {
      this.emit({
        type: "fatal_error",
        message: `Failed to restart Claude: ${String(err)}`,
        timestamp: nowIso(),
      });
    } finally {
      this.recoveringFromProcessDeath = false;
    }
  }

  /**
   * Write approval input to PTY with retry for Windows ConPTY buffering issues.
   * On Windows, ConPTY may buffer PTY input when the terminal is not in the foreground.
   * Retry up to PTY_APPROVAL_MAX_RETRIES times at PTY_APPROVAL_RETRY_DELAY_MS intervals.
   */
  private writePtyApprovalWithRetry(input: string): void {
    this.clearPtyApprovalRetry();
    this.writeToPty(input);

    // Only retry if this is a PTY-based approval (no requestId) and status is still awaiting_approval
    if (!this.pendingApproval?.requestId && this.state.status === "awaiting_approval") {
      this.ptyApprovalRetryCount = 0;
      this.ptyApprovalRetryTimer = setTimeout(() => {
        this.ptyApprovalRetryTimer = null;
        if (
          this.state.status === "awaiting_approval" &&
          !this.pendingApproval?.requestId
        ) {
          this.writeToPty(input);
          this.ptyApprovalRetryCount++;
          if (this.ptyApprovalRetryCount < ClaudeCompanionAdapter.PTY_APPROVAL_MAX_RETRIES) {
            this.executePtyApprovalRetry(input);
          }
        }
      }, ClaudeCompanionAdapter.PTY_APPROVAL_RETRY_DELAY_MS);
      this.ptyApprovalRetryTimer?.unref?.();
    }
  }

  private clearPtyApprovalRetry(): void {
    if (this.ptyApprovalRetryTimer) {
      clearTimeout(this.ptyApprovalRetryTimer);
      this.ptyApprovalRetryTimer = null;
    }
    this.ptyApprovalRetryCount = 0;
  }
  private handleClaudeHookEnvelope(params: {
    requestId: string;
    rawPayload: string;
    socket: net.Socket;
  }): void {
    this.lastHookActivityAt = Date.now();
    const payload = parseClaudeHookPayload(params.rawPayload);
    if (!payload?.hook_event_name) {
      this.respondToClaudeHook(params.socket, params.requestId);
      return;
    }

    switch (payload.hook_event_name) {
      case "SessionStart":
        this.handleClaudeSessionStart(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "UserPromptSubmit":
        this.handleClaudeUserPromptSubmit(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "PermissionRequest":
        this.handleClaudePermissionRequest(params.requestId, payload, params.socket);
        return;
      case "Notification":
        if (payload.notification_type === "permission_prompt" && this.pendingApproval) {
          this.setStatus("awaiting_approval", "Claude approval is required.");
        }
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "Stop":
        this.handleClaudeStop(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "StopFailure":
        this.handleClaudeStopFailure(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      default:
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
    }
  }

  private handleClaudeSessionStart(payload: {
    session_id?: string;
    source?: string;
    transcript_path?: string;
  }): void {
    if (!payload.session_id) {
      return;
    }

    const previousRuntimeSessionId = this.runtimeSessionId;
    const previousResumeConversationId = this.resumeConversationId;
    const nextTranscriptPath =
      typeof payload.transcript_path === "string" && payload.transcript_path.trim()
        ? payload.transcript_path.trim()
        : null;
    const nextResumeConversationId = extractClaudeResumeConversationId(
      nextTranscriptPath ?? undefined,
    );

    this.runtimeSessionId = payload.session_id;
    this.state.sharedSessionId = payload.session_id;
    this.state.activeRuntimeSessionId = payload.session_id;
    this.state.sharedThreadId = undefined;
    this.resumeConversationId = nextResumeConversationId;
    this.state.resumeConversationId = nextResumeConversationId ?? undefined;
    this.transcriptPath = nextTranscriptPath;
    this.state.transcriptPath = nextTranscriptPath ?? undefined;

    if (previousRuntimeSessionId === payload.session_id) {
      return;
    }

    if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
      this.clearWechatWorkingNotice(true);
      this.pendingCliApprovalHints = null;
      this.flushPendingClaudeHookApprovals();
      this.clearCompletionTimer();
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.state.pendingApprovalOrigin = undefined;
      this.state.activeTurnOrigin = undefined;
      this.hasAcceptedInput = false;
      this.pendingInputQueue = [];
      this.queuedInputCount = 0;
      this.setStatus("idle");
      this.emit({
        type: "task_complete",
        summary: this.currentPreview,
        timestamp: nowIso(),
      });
      this.currentPreview = "(idle)";
    }

    const timestamp = nowIso();
    const isRestore =
      !previousRuntimeSessionId &&
      (payload.source === "resume" ||
        (nextResumeConversationId !== null &&
          nextResumeConversationId === previousResumeConversationId));
    const source: BridgeThreadSwitchSource = isRestore ? "restore" : "local";
    const reason: BridgeThreadSwitchReason = isRestore ? "startup_restore" : "local_follow";
    this.state.lastSessionSwitchAt = timestamp;
    this.state.lastSessionSwitchSource = source;
    this.state.lastSessionSwitchReason = reason;
    this.emit({
      type: "session_switched",
      sessionId: payload.session_id,
      source,
      reason,
      timestamp,
    });
  }

  private handleClaudeUserPromptSubmit(payload: { prompt?: string }): void {
    const prompt =
      typeof payload.prompt === "string" ? normalizeOutput(payload.prompt).trim() : "";
    if (!prompt) {
      return;
    }

    const injectedIndex = findInjectedClaudePromptIndex(prompt, this.pendingInjectedInputs);
    if (injectedIndex >= 0) {
      this.pendingInjectedInputs.splice(injectedIndex, 1);
      return;
    }

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(prompt);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "local";
    this.pendingCliApprovalHints = null;
    this.clearWechatWorkingNotice(true);

    if (prompt.startsWith("/")) {
      this.emit({
        type: "mirrored_user_input",
        text: prompt,
        origin: "local",
        timestamp: nowIso(),
      });
      return;
    }

    this.setStatus("busy");
    this.emit({
      type: "mirrored_user_input",
      text: prompt,
      origin: "local",
      timestamp: nowIso(),
    });
  }

  private async recoverFromInvalidResume(failedResumeConversationId: string): Promise<void> {
    if (this.recoveringInvalidResume) {
      return;
    }

    this.recoveringInvalidResume = true;
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.runtimeSessionId = null;
    this.resumeConversationId = null;
    this.transcriptPath = null;
    this.state.sharedSessionId = undefined;
    this.state.sharedThreadId = undefined;
    this.state.activeRuntimeSessionId = undefined;
    this.state.resumeConversationId = undefined;
    this.state.transcriptPath = undefined;
    this.state.lastSessionSwitchAt = undefined;
    this.state.lastSessionSwitchSource = undefined;
    this.state.lastSessionSwitchReason = undefined;
    this.emitClaudeNotice(
      `Saved Claude conversation ${failedResumeConversationId} is no longer available. Starting a fresh Claude session.`,
      "warning",
    );

    try {
      await super.reset();
    } finally {
      this.recoveringInvalidResume = false;
    }
  }

  private handleClaudePermissionRequest(
    requestId: string,
    payload: ClaudeHookPayload,
    socket: net.Socket,
  ): void {
    this.clearWechatWorkingNotice();
    this.flushPendingClaudeHookApprovals(true);

    const toolName =
      typeof payload.tool_name === "string" ? payload.tool_name.trim() : "";

    // ExitPlanMode has a known bug where hook "allow" doesn't exit plan mode
    // (https://github.com/anthropics/claude-code/issues/15755). Skip the hook
    // and let Claude Code's native terminal handle the approval via PTY.
    if (toolName === "ExitPlanMode") {
      this.respondToClaudeHook(socket, requestId, undefined);
      const request = buildClaudePermissionApprovalRequest(payload);
      this.pendingApproval = {
        ...request,
        requestId: undefined,
        confirmInput: this.pendingCliApprovalHints?.confirmInput ?? undefined,
        denyInput: this.pendingCliApprovalHints?.denyInput ?? undefined,
      };
      this.pendingCliApprovalHints = null;
      this.state.pendingApproval = this.pendingApproval;
      this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
      this.setStatus("awaiting_approval", "Claude plan approval is required.");
      this.armStaleBusyWatchdog();
      this.emit({
        type: "approval_required",
        request: this.pendingApproval,
        timestamp: nowIso(),
      });
      return;
    }

    this.pendingHookApprovals.set(requestId, {
      requestId,
      socket,
    });
    const request = buildClaudePermissionApprovalRequest(payload);
    this.pendingApproval = {
      ...request,
      requestId,
      confirmInput:
        this.pendingApproval?.confirmInput ?? this.pendingCliApprovalHints?.confirmInput,
      denyInput: this.pendingApproval?.denyInput ?? this.pendingCliApprovalHints?.denyInput,
    };
    this.pendingCliApprovalHints = null;
    this.state.pendingApproval = this.pendingApproval;
    this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
    this.setStatus("awaiting_approval", "Claude approval is required.");
    this.armStaleBusyWatchdog();
    this.emit({
      type: "approval_required",
      request: this.pendingApproval,
      timestamp: nowIso(),
    });
  }

  private handleClosedClaudeHookApproval(requestId: string): void {
    if (this.pendingApproval?.requestId !== requestId) {
      return;
    }

    // Always keep the approval alive for PTY fallback, even without hints.
    this.pendingApproval = {
      ...this.pendingApproval,
      requestId: undefined,
      confirmInput: this.pendingApproval.confirmInput ?? "y\r",
      denyInput: this.pendingApproval.denyInput ?? "n\r",
    };
    this.state.pendingApproval = this.pendingApproval;
    this.emitClaudeNotice(
      "Claude approval hook connection closed. Approval can still be resolved from WeChat or the local Claude terminal.",
      "warning",
    );
  }

  private handleClaudeStop(payload: { last_assistant_message?: string }): void {
    this.clearStaleBusyWatchdog();
    this.clearCompletionTimer();
    this.clearPtyApprovalRetry();
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.queuedInputCount = 0;
    this.setStatus("idle");
    this.emit({
      type: "final_reply",
      text: normalizeClaudeAssistantMessage(payload),
      timestamp: nowIso(),
    });
    this.emit({
      type: "task_complete",
      summary: this.currentPreview,
      timestamp: nowIso(),
    });
    this.currentPreview = "(idle)";
    this.flushPendingInputQueue();
  }

  private handleClaudeStopFailure(payload: {
    error?: string;
    error_details?: string;
    last_assistant_message?: string;
  }): void {
    this.clearStaleBusyWatchdog();
    this.clearCompletionTimer();
    this.clearPtyApprovalRetry();
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.queuedInputCount = 0;
    this.setStatus("idle");
    this.emit({
      type: "task_failed",
      message: buildClaudeFailureMessage(payload),
      timestamp: nowIso(),
    });
    this.currentPreview = "(idle)";
    this.flushPendingInputQueue();
  }

  private respondToClaudeHook(
    socket: net.Socket,
    requestId: string,
    stdout?: string,
  ): void {
    try {
      socket.end(`${JSON.stringify({ requestId, stdout })}\n`);
    } catch {
      try {
        socket.destroy();
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private respondToClaudeHookApproval(
    requestId: string,
    action: "confirm" | "deny",
  ): boolean {
    const pending = this.pendingHookApprovals.get(requestId);
    if (!pending) {
      return false;
    }

    this.pendingHookApprovals.delete(requestId);
    this.respondToClaudeHook(
      pending.socket,
      requestId,
      buildClaudePermissionDecisionHookOutput(action),
    );
    return true;
  }

  private cancelPendingClaudeHookApproval(requestId: string): void {
    const pending = this.pendingHookApprovals.get(requestId);
    if (!pending) {
      return;
    }

    this.respondToClaudeHook(pending.socket, requestId);
    this.pendingHookApprovals.delete(requestId);
  }

  private flushPendingClaudeHookApprovals(preserveActive = false): void {
    const activeRequestId = preserveActive ? this.pendingApproval?.requestId : undefined;
    for (const requestId of Array.from(this.pendingHookApprovals.keys())) {
      if (requestId === activeRequestId) {
        continue;
      }
      this.cancelPendingClaudeHookApproval(requestId);
    }
  }
}

