import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_BASE_URL =
  process.env.WECHAT_ILINK_BASE_URL?.trim() || "https://ilinkai.weixin.qq.com";
export const BOT_TYPE = "3";

export const CHANNEL_DATA_DIR = process.env.CLAUDE_WECHAT_CHANNEL_DATA_DIR?.trim()
  ? path.resolve(process.env.CLAUDE_WECHAT_CHANNEL_DATA_DIR.trim())
  : path.join(os.homedir(), ".claude", "channels", "wechat");

export const CREDENTIALS_FILE = path.join(CHANNEL_DATA_DIR, "account.json");
export const SYNC_BUF_FILE = path.join(CHANNEL_DATA_DIR, "sync_buf.txt");
export const CONTEXT_CACHE_FILE = path.join(
  CHANNEL_DATA_DIR,
  "context_tokens.json",
);
export const BRIDGE_STATE_FILE = path.join(CHANNEL_DATA_DIR, "bridge-state.json");
export const BRIDGE_LOG_FILE = path.join(CHANNEL_DATA_DIR, "bridge.log");
export const BRIDGE_LOCK_FILE = path.join(CHANNEL_DATA_DIR, "bridge.lock.json");
export const CODEX_PANEL_ENDPOINT_FILE = path.join(
  CHANNEL_DATA_DIR,
  "codex-panel-endpoint.json",
);

const LEGACY_CHANNEL_DATA_DIR = path.join(
  MODULE_DIR,
  "~",
  ".claude",
  "channels",
  "wechat",
);
const LEGACY_CREDENTIALS_FILE = path.join(LEGACY_CHANNEL_DATA_DIR, "account.json");
const LEGACY_SYNC_BUF_FILE = path.join(LEGACY_CHANNEL_DATA_DIR, "sync_buf.txt");

export function ensureChannelDataDir(): void {
  fs.mkdirSync(CHANNEL_DATA_DIR, { recursive: true });
}

export function migrateLegacyChannelFiles(
  log?: (message: string) => void,
): string[] {
  const migrated: string[] = [];

  if (
    !fs.existsSync(LEGACY_CREDENTIALS_FILE) &&
    !fs.existsSync(LEGACY_SYNC_BUF_FILE)
  ) {
    return migrated;
  }

  ensureChannelDataDir();

  const copyIfNeeded = (fromPath: string, toPath: string, label: string) => {
    if (!fs.existsSync(fromPath) || fs.existsSync(toPath)) {
      return;
    }
    fs.copyFileSync(fromPath, toPath);
    migrated.push(label);
  };

  copyIfNeeded(LEGACY_CREDENTIALS_FILE, CREDENTIALS_FILE, "credentials");
  copyIfNeeded(LEGACY_SYNC_BUF_FILE, SYNC_BUF_FILE, "sync state");

  if (migrated.length && log) {
    log(
      `Migrated legacy ${migrated.join(
        " and ",
      )} from ${LEGACY_CHANNEL_DATA_DIR} to ${CHANNEL_DATA_DIR}.`,
    );
  }

  return migrated;
}
