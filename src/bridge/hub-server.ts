import crypto from "node:crypto";
import net from "node:net";

import type {
  ApprovalRequest,
  BridgeAdapterState,
  BridgeEvent,
  HubSpokeInfo,
  HubSpokeStatus,
} from "./bridge-types.ts";
import type {
  LocalCompanionCommand,
  LocalCompanionMessage,
} from "../companion/local-companion-link.ts";
import { HUB_DEFAULT_PORT } from "../wechat/channel-config.ts";

// --- Constants ---

const HEARTBEAT_CHECK_INTERVAL_MS = 10_000;
const STALE_TIMEOUT_MS = 30_000;
const OFFLINE_TIMEOUT_MS = 60_000;
const REGISTRATION_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 10_000;

// --- Types ---

export type HubEvent =
  | { type: "spoke_online"; projectName: string; timestamp: string }
  | {
      type: "spoke_offline";
      projectName: string;
      reason: string;
      timestamp: string;
    }
  | {
      type: "spoke_event";
      projectName: string;
      event: BridgeEvent;
      timestamp: string;
    };

type HubEventSink = (event: HubEvent) => void;

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SpokeConnection = {
  socket: net.Socket;
  projectName: string;
  cwd: string;
  connectedAt: string;
  lastPingAt: number;
  adapterState?: BridgeAdapterState;
  pendingApproval?: ApprovalRequest;
  buffer: string;
  regTimer?: ReturnType<typeof setTimeout>;
};

export type HubServerOptions = {
  port?: number;
  log?: (message: string) => void;
  logError?: (message: string) => void;
};

// --- HubServer ---

export class HubServer {
  private server: net.Server | null = null;
  private spokes = new Map<string, SpokeConnection>();
  private pendingRequests = new Map<string, PendingRequest>();
  private eventSink: HubEventSink | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly port: number;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string) => void;

  constructor(options: HubServerOptions = {}) {
    this.port = options.port ?? HUB_DEFAULT_PORT;
    this.log = options.log ?? (() => {});
    this.logError = options.logError ?? (() => {});
  }

  setEventSink(sink: HubEventSink): void {
    this.eventSink = sink;
  }

  private emit(event: HubEvent): void {
    this.eventSink?.(event);
  }

  // --- Lifecycle ---

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on("error", (err) => {
        this.logError(`Hub server error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        const addr = this.server!.address();
        const actualPort =
          typeof addr === "object" && addr ? addr.port : this.port;
        this.log(`Hub server listening on 127.0.0.1:${actualPort}`);

        this.heartbeatTimer = setInterval(() => {
          this.checkHeartbeats();
        }, HEARTBEAT_CHECK_INTERVAL_MS);

        resolve(actualPort);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const [name, spoke] of this.spokes) {
      this.destroySpoke(spoke);
      this.emit({
        type: "spoke_offline",
        projectName: name,
        reason: "hub_shutdown",
        timestamp: nowIso(),
      });
    }
    this.spokes.clear();

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Hub shutting down"));
    }
    this.pendingRequests.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  // --- Message routing (called by bridge when WeChat messages arrive) ---

  async routeMessage(text: string): Promise<string | null> {
    const trimmed = text.trim();
    if (!trimmed) return null;

    // Check for [project-name] prefix
    const prefixMatch = trimmed.match(/^\[([^\]]+)\]\s*([\s\S]*)/);
    if (prefixMatch && prefixMatch[1] && prefixMatch[2] !== undefined) {
      const projectName = prefixMatch[1];
      const messageText = prefixMatch[2].trim();
      if (!messageText) return null;
      const spoke = this.spokes.get(projectName);
      if (!spoke) {
        return this.formatProjectNotFound(projectName);
      }
      await this.sendToSpoke(projectName, {
        command: "send_input",
        text: messageText,
      });
      return null;
    }

    // No prefix
    const onlineSpokes = this.getOnlineSpokes();
    if (onlineSpokes.length === 0) {
      return "当前没有在线项目。请在项目目录中运行 wechat-claude。";
    }
    if (onlineSpokes.length === 1 && onlineSpokes[0]) {
      const spoke = onlineSpokes[0];
      await this.sendToSpoke(spoke.projectName, {
        command: "send_input",
        text: trimmed,
      });
      return null;
    }
    return this.formatProjectList("请指定项目前缀。");
  }

  async routeCommand(
    command: string,
    args?: string,
  ): Promise<string | null> {
    switch (command) {
      case "projects":
        return this.formatProjectList();
      case "status":
        return this.formatStatusReport();
      case "stop": {
        const reply = await this.routeCommandToSpoke("interrupt", args);
        return reply;
      }
      case "reset": {
        const reply = await this.routeCommandToSpoke("reset", args);
        return reply;
      }
      default:
        return null;
    }
  }

  async routeApproval(
    action: "confirm" | "deny",
    text?: string,
  ): Promise<string | null> {
    for (const [name, spoke] of this.spokes) {
      if (spoke.pendingApproval) {
        await this.sendToSpoke(name, {
          command: "resolve_approval",
          action,
          text,
        });
        spoke.pendingApproval = undefined;
        return action === "confirm"
          ? `[${name}] 审批已确认。`
          : `[${name}] 审批已拒绝。`;
      }
    }
    return "当前没有待审批请求。";
  }

  // --- Send command to spoke ---

  async sendToSpoke(
    projectName: string,
    command: LocalCompanionCommand,
  ): Promise<unknown> {
    const spoke = this.spokes.get(projectName);
    if (!spoke) {
      throw new Error(`Spoke "${projectName}" not found`);
    }

    const id = crypto.randomBytes(8).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          new Error(`Timeout sending command to spoke "${projectName}"`),
        );
      }, COMMAND_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
      spoke.socket.write(
        `${JSON.stringify({ type: "request", id, payload: command })}\n`,
      );
    });
  }

  // --- Spoke info ---

  getSpokeInfo(projectName: string): HubSpokeInfo | undefined {
    const spoke = this.spokes.get(projectName);
    if (!spoke) return undefined;
    return this.toSpokeInfo(spoke);
  }

  getAllSpokeInfos(): HubSpokeInfo[] {
    return Array.from(this.spokes.values()).map((s) => this.toSpokeInfo(s));
  }

  getOnlineCount(): number {
    return this.spokes.size;
  }

  // --- Connection handling ---

  private handleConnection(socket: net.Socket): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.log(`New connection from ${remote}`);

    socket.setNoDelay(true);
    socket.setEncoding("utf8");

    const spoke: SpokeConnection = {
      socket,
      projectName: "",
      cwd: "",
      connectedAt: nowIso(),
      lastPingAt: Date.now(),
      buffer: "",
    };

    const onData = (data: string) => {
      spoke.buffer += data;
      this.processBuffer(spoke);
    };

    const onClose = () => {
      this.handleSpokeDisconnect(spoke);
    };

    const onError = (err: Error) => {
      this.logError(`Spoke error (${remote}): ${err.message}`);
      this.handleSpokeDisconnect(spoke);
    };

    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);

    // Timeout for registration
    spoke.regTimer = setTimeout(() => {
      if (!spoke.projectName) {
        this.log(`Connection from ${remote} timed out (no registration)`);
        socket.off("data", onData);
        socket.off("close", onClose);
        socket.off("error", onError);
        socket.destroy();
      }
    }, REGISTRATION_TIMEOUT_MS);
  }

  private processBuffer(spoke: SpokeConnection): void {
    while (true) {
      const idx = spoke.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = spoke.buffer.slice(0, idx).trim();
      spoke.buffer = spoke.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as LocalCompanionMessage;
        this.handleSpokeMessage(spoke, message);
      } catch {
        // Ignore malformed frames.
      }
    }
  }

  private handleSpokeMessage(
    spoke: SpokeConnection,
    message: LocalCompanionMessage,
  ): void {
    // Check for pending request response first
    if (message.type === "response" && message.id) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error ?? "Spoke command failed"));
        return;
      }
    }

    switch (message.type) {
      case "register": {
        if (spoke.regTimer) {
          clearTimeout(spoke.regTimer);
          spoke.regTimer = undefined;
        }

        const projectName = message.projectName;
        spoke.projectName = projectName;
        spoke.cwd = message.cwd;

        // Reconnection: close old connection if same project name
        const existing = this.spokes.get(projectName);
        if (existing && existing !== spoke) {
          this.log(
            `Spoke "${projectName}" reconnecting, closing old connection`,
          );
          this.destroySpoke(existing);
        }

        this.spokes.set(projectName, spoke);
        this.log(`Spoke registered: ${projectName} (${spoke.cwd})`);

        spoke.socket.write(
          `${JSON.stringify({ type: "register_ack", accepted: true })}\n`,
        );

        this.emit({
          type: "spoke_online",
          projectName,
          timestamp: nowIso(),
        });
        break;
      }

      case "ping":
        spoke.lastPingAt = Date.now();
        spoke.socket.write(`${JSON.stringify({ type: "pong" })}\n`);
        break;

      case "pong":
        spoke.lastPingAt = Date.now();
        break;

      case "event": {
        if (!spoke.projectName) return;

        // Track approval state
        if (message.event.type === "approval_required") {
          spoke.pendingApproval = message.event.request;
        }
        if (
          message.event.type === "task_complete" ||
          message.event.type === "task_failed"
        ) {
          spoke.pendingApproval = undefined;
        }

        this.emit({
          type: "spoke_event",
          projectName: spoke.projectName,
          event: message.event,
          timestamp: nowIso(),
        });
        break;
      }

      case "state":
        if (spoke.projectName) {
          spoke.adapterState = message.state;
        }
        break;

      case "hello":
        // Companion hello compatibility
        spoke.socket.write(`${JSON.stringify({ type: "hello_ack" })}\n`);
        break;
    }
  }

  private handleSpokeDisconnect(spoke: SpokeConnection): void {
    this.destroySpoke(spoke);
    if (spoke.projectName && this.spokes.get(spoke.projectName) === spoke) {
      this.spokes.delete(spoke.projectName);
      this.log(`Spoke disconnected: ${spoke.projectName}`);
      this.emit({
        type: "spoke_offline",
        projectName: spoke.projectName,
        reason: "disconnected",
        timestamp: nowIso(),
      });
    }
  }

  private destroySpoke(spoke: SpokeConnection): void {
    if (spoke.regTimer) {
      clearTimeout(spoke.regTimer);
      spoke.regTimer = undefined;
    }
    try {
      spoke.socket.off("data", () => {});
      spoke.socket.destroy();
    } catch {
      // Best effort.
    }
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [name, spoke] of this.spokes) {
      const elapsed = now - spoke.lastPingAt;
      if (elapsed > OFFLINE_TIMEOUT_MS) {
        this.log(`Spoke "${name}" heartbeat timeout`);
        this.destroySpoke(spoke);
        toRemove.push(name);
      }
    }

    for (const name of toRemove) {
      this.spokes.delete(name);
      this.emit({
        type: "spoke_offline",
        projectName: name,
        reason: "heartbeat_timeout",
        timestamp: nowIso(),
      });
    }
  }

  // --- Helpers ---

  private async routeCommandToSpoke(
    command: "interrupt" | "reset",
    args?: string,
  ): Promise<string | null> {
    const target = args?.trim();
    if (target) {
      const spoke = this.spokes.get(target);
      if (!spoke) return this.formatProjectNotFound(target);
      await this.sendToSpoke(target, { command });
      const label =
        command === "interrupt" ? "中断信号已发送" : "会话已重置";
      return `[${target}] ${label}。`;
    }

    const onlineSpokes = this.getOnlineSpokes();
    if (onlineSpokes.length === 1 && onlineSpokes[0]) {
      const spoke = onlineSpokes[0];
      await this.sendToSpoke(spoke.projectName, { command });
      const label =
        command === "interrupt" ? "中断信号已发送" : "会话已重置";
      return `[${spoke.projectName}] ${label}。`;
    }

    const cmdName = command === "interrupt" ? "/stop" : "/reset";
    return this.formatProjectList(
      `请指定要操作的项目，如 ${cmdName} project-name。`,
    );
  }

  private getOnlineSpokes(): SpokeConnection[] {
    return Array.from(this.spokes.values()).filter((s) => s.projectName);
  }

  private toSpokeInfo(spoke: SpokeConnection): HubSpokeInfo {
    return {
      projectName: spoke.projectName,
      cwd: spoke.cwd,
      status: "online" as HubSpokeStatus,
      connectedAt: spoke.connectedAt,
      lastPingAt: spoke.lastPingAt,
      adapterState: spoke.adapterState,
      pendingApproval: spoke.pendingApproval,
    };
  }

  private formatProjectList(prefix?: string): string {
    const spokes = this.getOnlineSpokes();
    if (spokes.length === 0) {
      return "当前没有在线项目。";
    }
    const lines = [prefix ?? "当前在线项目：", ""];
    for (const spoke of spokes) {
      const status = spoke.adapterState?.status ?? "unknown";
      lines.push(`  [${spoke.projectName}] - ${status}`);
    }
    return lines.join("\n");
  }

  private formatProjectNotFound(name: string): string {
    return `未找到项目 "${name}"。\n${this.formatProjectList()}`;
  }

  private formatStatusReport(): string {
    const spokes = this.getOnlineSpokes();
    if (spokes.length === 0) return "当前没有在线项目。";
    const lines = [`Hub 状态 (${spokes.length} 个在线项目)：`, ""];
    for (const spoke of spokes) {
      const state = spoke.adapterState;
      const status = state?.status ?? "unknown";
      const lastOutput = state?.lastOutputAt ?? "N/A";
      lines.push(`[${spoke.projectName}]`);
      lines.push(`  状态: ${status}`);
      lines.push(`  目录: ${spoke.cwd}`);
      lines.push(`  最后输出: ${lastOutput}`);
      if (spoke.pendingApproval) {
        lines.push(`  待审批: ${spoke.pendingApproval.commandPreview}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
