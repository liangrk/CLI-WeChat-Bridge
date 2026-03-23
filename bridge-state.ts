import fs from "node:fs";

import {
  BRIDGE_LOCK_FILE,
  BRIDGE_LOG_FILE,
  BRIDGE_STATE_FILE,
  ensureChannelDataDir,
} from "./channel-config.ts";
import type {
  BridgeAdapterKind,
  BridgeState,
  PendingApproval,
} from "./bridge-types.ts";
import { buildInstanceId } from "./bridge-utils.ts";

type BridgeStateOptions = {
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  authorizedUserId: string;
};

type BridgeLockPayload = {
  pid: number;
  instanceId: string;
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  startedAt: string;
};

function cloneState(state: BridgeState): BridgeState {
  return JSON.parse(JSON.stringify(state)) as BridgeState;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(): BridgeLockPayload | null {
  try {
    if (!fs.existsSync(BRIDGE_LOCK_FILE)) {
      return null;
    }
    return JSON.parse(
      fs.readFileSync(BRIDGE_LOCK_FILE, "utf-8"),
    ) as BridgeLockPayload;
  } catch {
    return null;
  }
}

export class BridgeStateStore {
  private state: BridgeState;
  private readonly lockPayload: BridgeLockPayload;
  private readonly bridgeStartedAtMs: number;
  private readonly instanceId: string;

  constructor(options: BridgeStateOptions) {
    ensureChannelDataDir();
    this.bridgeStartedAtMs = Date.now();
    this.instanceId = buildInstanceId();
    this.lockPayload = {
      pid: process.pid,
      instanceId: this.instanceId,
      adapter: options.adapter,
      command: options.command,
      cwd: options.cwd,
      startedAt: new Date(this.bridgeStartedAtMs).toISOString(),
    };

    this.acquireLock();

    const persisted = this.readStateFile();
    const persistedSharedThreadId =
      options.adapter === "codex" &&
      persisted?.adapter === "codex" &&
      persisted.cwd === options.cwd
        ? persisted.sharedThreadId
        : undefined;
    this.state = {
      instanceId: this.instanceId,
      adapter: options.adapter,
      command: options.command,
      cwd: options.cwd,
      profile: options.profile,
      authorizedUserId: options.authorizedUserId,
      bridgeStartedAtMs: this.bridgeStartedAtMs,
      ignoredBacklogCount: 0,
      sharedThreadId: persistedSharedThreadId,
      lastActivityAt: persisted?.lastActivityAt,
      pendingConfirmation: null,
    };

    this.save();

    if (persisted?.pendingConfirmation) {
      this.appendLog("Cleared stale pending confirmation from previous bridge session.");
    }
  }

  getState(): BridgeState {
    return cloneState(this.state);
  }

  touchActivity(timestamp = new Date().toISOString()): void {
    this.state.lastActivityAt = timestamp;
    this.save();
  }

  setPendingConfirmation(pending: PendingApproval): void {
    this.state.pendingConfirmation = pending;
    this.save();
  }

  clearPendingConfirmation(): void {
    if (!this.state.pendingConfirmation) {
      return;
    }
    this.state.pendingConfirmation = null;
    this.save();
  }

  incrementIgnoredBacklog(count = 1): void {
    this.state.ignoredBacklogCount += count;
    this.save();
  }

  setSharedThreadId(threadId: string): void {
    this.state.sharedThreadId = threadId;
    this.save();
  }

  clearSharedThreadId(): void {
    if (!this.state.sharedThreadId) {
      return;
    }
    this.state.sharedThreadId = undefined;
    this.save();
  }

  appendLog(message: string): void {
    ensureChannelDataDir();
    fs.appendFileSync(
      BRIDGE_LOG_FILE,
      `[${new Date().toISOString()}] ${message}\n`,
      "utf-8",
    );
  }

  releaseLock(): void {
    try {
      const currentLock = readLockFile();
      if (currentLock?.pid === process.pid) {
        fs.rmSync(BRIDGE_LOCK_FILE, { force: true });
      }
    } catch {
      // Best effort cleanup.
    }
  }

  private save(): void {
    ensureChannelDataDir();
    fs.writeFileSync(BRIDGE_STATE_FILE, JSON.stringify(this.state, null, 2), "utf-8");
  }

  private acquireLock(): void {
    const existing = readLockFile();
    if (
      existing &&
      existing.pid !== process.pid &&
      isPidAlive(existing.pid)
    ) {
      this.appendLog(
        `lock_conflict: pid=${existing.pid} instanceId=${existing.instanceId} adapter=${existing.adapter} cwd=${existing.cwd}`,
      );
      throw new Error(
        `Another bridge instance is already running (pid=${existing.pid}, instanceId=${existing.instanceId}, adapter=${existing.adapter}, cwd=${existing.cwd}, startedAt=${existing.startedAt}). Stop it before starting a new bridge.`,
      );
    }

    fs.writeFileSync(
      BRIDGE_LOCK_FILE,
      JSON.stringify(this.lockPayload, null, 2),
      "utf-8",
    );
  }

  private readStateFile(): Partial<BridgeState> | null {
    try {
      if (!fs.existsSync(BRIDGE_STATE_FILE)) {
        return null;
      }
      return JSON.parse(
        fs.readFileSync(BRIDGE_STATE_FILE, "utf-8"),
      ) as Partial<BridgeState>;
    } catch {
      return null;
    }
  }
}
