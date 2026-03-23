import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildCodexApprovalRequest,
  extractCodexFinalTextFromItem,
  extractCodexUserMessageText,
  matchesCodexSessionMeta,
  resolveSpawnTarget,
} from "./bridge-adapters.ts";

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wechat-bridge-adapter-test-"),
  );
  tempDirectories.push(directory);
  return directory;
}

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf-8");
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) {
      continue;
    }

    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveSpawnTarget", () => {
  test("keeps an explicit executable path unchanged", () => {
    const tempDir = makeTempDirectory();
    const executableName = process.platform === "win32" ? "tool.exe" : "tool";
    const executablePath = path.join(tempDir, executableName);
    writeFile(executablePath);

    const target = resolveSpawnTarget(executablePath, "shell");

    expect(target.file).toBe(path.resolve(executablePath));
    expect(target.args).toEqual([]);
  });

  test("prefers cmd launcher over ps1 on Windows when vendor exe is missing", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const cmdPath = path.join(npmBinDirectory, "codex.cmd");
    const ps1Path = path.join(npmBinDirectory, "codex.ps1");
    writeFile(cmdPath);
    writeFile(ps1Path);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file.toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
    expect(target.args).toHaveLength(4);
    expect(target.args[3]).toContain("codex.cmd");
    expect(target.args[3]).not.toContain("codex.ps1");
  });

  test("prefers bundled vendor exe for codex on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const launcherPath = path.join(npmBinDirectory, "codex.cmd");
    const vendorExePath = path.join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      ".codex-test",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    writeFile(launcherPath);
    writeFile(vendorExePath);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file).toBe(vendorExePath);
    expect(target.args).toEqual([]);
  });

  test("prefers the installed package vendor exe before hidden staging directories", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const launcherPath = path.join(npmBinDirectory, "codex.cmd");
    const packageVendorExePath = path.join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    const hiddenVendorExePath = path.join(
      npmBinDirectory,
      "node_modules",
      "@openai",
      ".codex-test",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "codex",
      "codex.exe",
    );
    writeFile(launcherPath);
    writeFile(packageVendorExePath);
    writeFile(hiddenVendorExePath);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file).toBe(packageVendorExePath);
    expect(target.args).toEqual([]);
  });

  test("passes forwarded exec args through the cmd wrapper on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const npmBinDirectory = path.join(tempDir, "npm");
    const cmdPath = path.join(npmBinDirectory, "codex.cmd");
    writeFile(cmdPath);

    const target = resolveSpawnTarget("codex", "codex", {
      platform: "win32",
      env: {
        PATH: npmBinDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
      forwardArgs: ["exec", "--json", "hello"],
    });

    expect(target.file.toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
    expect(target.args[3]).toContain("codex.cmd");
    expect(target.args[3]).toContain("exec");
    expect(target.args[3]).toContain("--json");
    expect(target.args[3]).toContain("hello");
  });

  test("launches claude.exe directly on Windows", () => {
    if (process.platform !== "win32") {
      return;
    }

    const tempDir = makeTempDirectory();
    const binDirectory = path.join(tempDir, "bin");
    const claudeExePath = path.join(binDirectory, "claude.exe");
    writeFile(claudeExePath);

    const target = resolveSpawnTarget("claude", "claude", {
      platform: "win32",
      env: {
        PATH: binDirectory,
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATHEXT: ".COM;.EXE;.BAT;.CMD;.PS1",
      },
    });

    expect(target.file).toBe(claudeExePath);
    expect(target.args).toEqual([]);
  });
});

describe("matchesCodexSessionMeta", () => {
  test("matches the expected cwd and custom session source", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");

    expect(
      matchesCodexSessionMeta(
        {
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          source: { custom: "wechat_bridge" },
          timestamp: "2026-03-22T15:00:02.000Z",
        },
        {
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          startedAtMs,
          sessionSource: "wechat_bridge",
        },
      ),
    ).toBe(true);
  });

  test("rejects a session from the same cwd when the source does not match", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");

    expect(
      matchesCodexSessionMeta(
        {
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          source: { custom: "cli" },
          timestamp: "2026-03-22T15:00:02.000Z",
        },
        {
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          startedAtMs,
          sessionSource: "wechat_bridge",
        },
      ),
    ).toBe(false);
  });

  test("rejects a session that started too far before the bridge session", () => {
    const startedAtMs = Date.parse("2026-03-22T15:00:00.000Z");

    expect(
      matchesCodexSessionMeta(
        {
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          source: "wechat_bridge",
          timestamp: "2026-03-22T14:55:00.000Z",
        },
        {
          cwd: "C:\\Users\\unlin\\Desktop\\Github\\claude-code-wechat-channel",
          startedAtMs,
          sessionSource: "wechat_bridge",
        },
      ),
    ).toBe(false);
  });
});

describe("buildCodexApprovalRequest", () => {
  test("formats command execution approvals for WeChat", () => {
    const request = buildCodexApprovalRequest(
      "item/commandExecution/requestApproval",
      {
        command: "git push origin main",
        cwd: "C:\\repo",
        reason: "Network access is required to push this branch.",
      },
    );

    expect(request).toEqual({
      source: "cli",
      summary:
        "Codex needs approval before running a command: Network access is required to push this branch.",
      commandPreview: "git push origin main (C:\\repo)",
    });
  });

  test("formats file change approvals for WeChat", () => {
    const request = buildCodexApprovalRequest(
      "item/fileChange/requestApproval",
      {
        grantRoot: "C:\\repo\\generated",
        reason: "Extra write access is required for generated assets.",
      },
    );

    expect(request).toEqual({
      source: "cli",
      summary:
        "Codex needs approval before applying a file change: Extra write access is required for generated assets.",
      commandPreview: "C:\\repo\\generated",
    });
  });
});

describe("extractCodexFinalTextFromItem", () => {
  test("returns only final-answer agent messages", () => {
    expect(
      extractCodexFinalTextFromItem({
        type: "agentMessage",
        id: "msg_1",
        phase: "final_answer",
        text: "Final reply",
      }),
    ).toBe("Final reply");
  });

  test("ignores commentary and non-agent items", () => {
    expect(
      extractCodexFinalTextFromItem({
        type: "agentMessage",
        id: "msg_2",
        phase: "commentary",
        text: "Thinking...",
      }),
    ).toBeNull();

    expect(
      extractCodexFinalTextFromItem({
        type: "commandExecution",
        id: "cmd_1",
      }),
    ).toBeNull();
  });
});

describe("extractCodexUserMessageText", () => {
  test("extracts plain text user input", () => {
    expect(
      extractCodexUserMessageText({
        type: "userMessage",
        id: "msg_1",
        content: [
          {
            type: "text",
            text: "List the files in this directory.",
            text_elements: [],
          },
        ],
      }),
    ).toBe("List the files in this directory.");
  });

  test("summarizes non-text inputs for mirrored local prompts", () => {
    expect(
      extractCodexUserMessageText({
        type: "userMessage",
        id: "msg_2",
        content: [
          {
            type: "mention",
            name: "repo",
            path: "app://repo",
          },
          {
            type: "localImage",
            path: "C:\\repo\\diagram.png",
          },
        ],
      }),
    ).toBe("[mention: repo]\n[local image: C:\\repo\\diagram.png]");
  });
});
