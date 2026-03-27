#!/usr/bin/env bun

import path from "node:path";

import { migrateLegacyChannelFiles } from "../wechat/channel-config.ts";
import {
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  WeChatSessionExpiredError,
  WeChatTransport,
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";
import {
  MESSAGE_START_GRACE_MS,
  formatStatusReport,
  nowIso,
  parseProjectPrefix,
  parseSystemCommand,
} from "./bridge-utils.ts";
import {
  loadProjectsRegistry,
  saveProjectsRegistry,
  addProject,
  removeProject,
  type ProjectsRegistry,
} from "./project-registry.ts";
import { ProjectBridge, type ActiveTask } from "./project-bridge.ts";
import { spawnCompanionWindow, isProcessAlive, type SpawnedCompanion } from "./companion-spawner.ts";
import type { BridgeAdapterKind } from "./bridge-types.ts";

function log(message: string): void {
  process.stderr.write(`[project-router] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[project-router] ERROR: ${message}\n`);
}

type RouterCliOptions = {
  projects: Array<{
    name: string;
    cwd: string;
    adapter?: BridgeAdapterKind;
  }>;
  config?: string;
};

function parseCliArgs(argv: string[]): RouterCliOptions {
  const projects: RouterCliOptions["projects"] = [];
  let config: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--project": {
        // --project name=/path/to/dir or --project name=/path --adapter claude
        if (!next) throw new Error("--project requires a value");
        const eqIndex = next.indexOf("=");
        if (eqIndex === -1) throw new Error("--project format: name=/path/to/dir");
        const name = next.slice(0, eqIndex);
        const cwd = path.resolve(next.slice(eqIndex + 1));
        projects.push({ name, cwd });
        i += 1;
        break;
      }
      case "--config":
        if (!next) throw new Error("--config requires a value");
        config = next;
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

  return { projects, config };
}

function printUsageAndExit(): never {
  process.stdout.write(
    [
      "Usage: wechat-bridge-multi --project <name>=<cwd> [--project <name>=<cwd> ...]",
      "",
      "Start a multi-project WeChat bridge that routes messages by @project-id prefix.",
      "",
      "Examples:",
      "  wechat-bridge-multi --project api-server=/path/to/api --project frontend=/path/to/web",
      "  wechat-bridge-multi --config ./projects.json",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

async function main(): Promise<void> {
  migrateLegacyChannelFiles(log);

  const cliOptions = parseCliArgs(process.argv.slice(2));
  const transport = new WeChatTransport({ log, logError });

  const credentials = transport.getCredentials();
  if (!credentials) {
    throw new Error('No saved WeChat credentials found. Run "bun run setup" first.');
  }
  if (!credentials.userId) {
    throw new Error('Saved WeChat credentials are missing userId. Run "bun run setup" again.');
  }

  // Load or build project registry
  let registry: ProjectsRegistry;
  if (cliOptions.projects.length > 0) {
    // CLI-specified projects take priority; build registry from them
    registry = loadProjectsRegistry();
    for (const p of cliOptions.projects) {
      if (!registry.projects[p.name]) {
        registry = addProject(registry, p.name, {
          adapter: p.adapter ?? "claude",
          command: p.adapter ?? "claude",
          cwd: p.cwd,
        });
      }
    }
  } else {
    registry = loadProjectsRegistry();
  }

  const projectNames = Object.keys(registry.projects);
  if (projectNames.length === 0) {
    throw new Error("No projects configured. Use --project name=/path to add projects.");
  }

  log(`Starting multi-project bridge with ${projectNames.length} project(s): ${projectNames.join(", ")}`);

  // Create ProjectBridge instances
  const bridges = new Map<string, ProjectBridge>();
  const companions: SpawnedCompanion[] = [];
  let sendChain = Promise.resolve();

  const queueWechatMessage = (senderId: string, text: string) => {
    sendChain = sendChain
      .then(() => transport.sendText(senderId, text))
      .catch((err) => {
        logError(`Failed to send WeChat reply: ${String(err)}`);
      });
    return sendChain;
  };

  // Start all project bridges
  for (const name of projectNames) {
    const config = registry.projects[name];
    log(`Starting project "${name}" (${config.adapter}) at ${config.cwd}`);

    const bridge = new ProjectBridge(
      {
        projectId: name,
        adapter: config.adapter,
        command: config.command,
        cwd: config.cwd,
        profile: config.profile ?? undefined,
        authorizedUserId: credentials.userId,
      },
      queueWechatMessage,
    );

    await bridge.start();
    bridges.set(name, bridge);

    // Spawn companion window
    try {
      const companion = spawnCompanionWindow({
        projectId: name,
        adapter: config.adapter,
        cwd: config.cwd,
      });
      companions.push(companion);
      log(`Spawned companion window for "${name}" (pid=${companion.pid})`);
    } catch (err) {
      logError(`Failed to spawn companion for "${name}": ${String(err)}`);
    }
  }

  const cleanup = async () => {
    log("Shutting down...");
    for (const [name, bridge] of bridges) {
      try {
        await bridge.stop();
        log(`Stopped project "${name}".`);
      } catch {
        // Best effort.
      }
    }
  };

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });

  log("Multi-project bridge is ready.");
  log(`Projects: ${projectNames.map((n) => `@${n}`).join(", ")}`);
  log("Send messages with format: @<project-id> <message>");

  // Main polling loop
  try {
    while (true) {
      let pollResult;
      try {
        pollResult = await transport.pollMessages({
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          minCreatedAtMs: Date.now() - MESSAGE_START_GRACE_MS,
        });
      } catch (err) {
        if (err instanceof WeChatSessionExpiredError) {
          logError(err.message);
          break;
        }
        throw err;
      }

      for (const message of pollResult.messages) {
        try {
          await routeMessage(message, bridges, queueWechatMessage, registry, credentials.userId);
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          logError(errorText);
          await queueWechatMessage(message.senderId, `[router] Error: ${errorText}`);
        }
      }
    }
  } finally {
    await cleanup();
  }
}

async function routeMessage(
  message: InboundWechatMessage,
  bridges: Map<string, ProjectBridge>,
  queueWechatMessage: (senderId: string, text: string) => Promise<void>,
  registry: ProjectsRegistry,
  authorizedUserId: string,
): Promise<void> {
  if (message.senderId !== authorizedUserId) {
    await queueWechatMessage(message.senderId, "Unauthorized.");
    return;
  }

  const text = message.text.trim();

  // Check for global router commands first (no project prefix)
  const globalCommand = parseSystemCommand(text);
  if (globalCommand) {
    switch (globalCommand.type) {
      case "status": {
        // Show all project statuses
        const lines = ["[Router] Multi-project status:"];
        for (const [name, bridge] of bridges) {
          const adapterState = bridge.getAdapterState();
          lines.push(`  @${name}: ${adapterState.status} (${adapterState.cwd})`);
        }
        await queueWechatMessage(message.senderId, lines.join("\n"));
        return;
      }
      case "projects": {
        const lines = ["[Router] Registered projects:"];
        for (const [name, config] of Object.entries(registry.projects)) {
          const bridge = bridges.get(name);
          const status = bridge?.getAdapterState().status ?? "stopped";
          lines.push(`  @${name}: ${status} (${config.cwd})`);
        }
        await queueWechatMessage(message.senderId, lines.join("\n"));
        return;
      }
      default:
        break;
    }
  }

  // Check for project management commands
  const mgmtCommand = parseSystemCommand(text);
  if (mgmtCommand && mgmtCommand.type === "projects") {
    // Already handled above
    return;
  }

  // Try to parse project prefix: @projectId <message>
  const projectMsg = parseProjectPrefix(text);
  if (projectMsg) {
    const bridge = bridges.get(projectMsg.projectId);
    if (!bridge) {
      const available = Array.from(bridges.keys()).map((k) => `@${k}`).join(", ");
      await queueWechatMessage(
        message.senderId,
        `Unknown project "${projectMsg.projectId}". Available: ${available}`,
      );
      return;
    }

    if (bridge.isDisposed) {
      await queueWechatMessage(
        message.senderId,
        `Project "${projectMsg.projectId}" has been stopped.`,
      );
      return;
    }

    // Wrap the message to strip the @projectId prefix
    const wrappedMessage: InboundWechatMessage = {
      ...message,
      text: projectMsg.text || text,
    };

    const task = await bridge.handleInboundMessage(wrappedMessage);
    // Task tracking is internal to the bridge now
    return;
  }

  // No project prefix and no global command - show help
  const available = Array.from(bridges.keys()).map((k) => `@${k}`).join(", ");
  await queueWechatMessage(
    message.senderId,
    `Prefix messages with @<project-id>. Available projects: ${available}`,
  );
}

main().catch((err) => {
  logError(String(err));
  process.exit(1);
});
