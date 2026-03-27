import fs from "node:fs";
import path from "node:path";

import { CHANNEL_DATA_DIR, PROJECTS_REGISTRY_FILE, ensureChannelDataDir } from "../wechat/channel-config.ts";
import type { BridgeAdapterKind } from "./bridge-types.ts";
import { nowIso } from "./bridge-utils.ts";

export type ProjectConfig = {
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string | null;
  addedAt: string;
};

export type ProjectsRegistry = {
  projects: Record<string, ProjectConfig>;
  defaultProject: string | null;
};

const DEFAULT_REGISTRY: ProjectsRegistry = {
  projects: {},
  defaultProject: null,
};

export function loadProjectsRegistry(): ProjectsRegistry {
  try {
    if (!fs.existsSync(PROJECTS_REGISTRY_FILE)) {
      return { ...DEFAULT_REGISTRY };
    }
    const raw = JSON.parse(fs.readFileSync(PROJECTS_REGISTRY_FILE, "utf-8"));
    return {
      projects: raw.projects ?? {},
      defaultProject: raw.defaultProject ?? null,
    };
  } catch {
    return { ...DEFAULT_REGISTRY };
  }
}

export function saveProjectsRegistry(registry: ProjectsRegistry): void {
  ensureChannelDataDir();
  fs.writeFileSync(
    PROJECTS_REGISTRY_FILE,
    JSON.stringify(registry, null, 2),
    "utf-8",
  );
}

export function addProject(
  registry: ProjectsRegistry,
  name: string,
  config: Omit<ProjectConfig, "addedAt">,
): ProjectsRegistry {
  if (registry.projects[name]) {
    throw new Error(`Project "${name}" already exists.`);
  }
  const updated: ProjectsRegistry = {
    ...registry,
    projects: {
      ...registry.projects,
      [name]: { ...config, addedAt: nowIso() },
    },
  };
  // Auto-set default if this is the first project
  if (Object.keys(updated.projects).length === 1 && !updated.defaultProject) {
    updated.defaultProject = name;
  }
  saveProjectsRegistry(updated);
  return updated;
}

export function removeProject(
  registry: ProjectsRegistry,
  name: string,
): ProjectsRegistry {
  if (!registry.projects[name]) {
    throw new Error(`Project "${name}" not found.`);
  }
  const { [name]: _, ...remaining } = registry.projects;
  const updated: ProjectsRegistry = {
    ...registry,
    projects: remaining,
    defaultProject: registry.defaultProject === name ? null : registry.defaultProject,
  };
  // Auto-set default to the only remaining project
  const keys = Object.keys(updated.projects);
  if (keys.length === 1 && !updated.defaultProject) {
    updated.defaultProject = keys[0];
  }
  saveProjectsRegistry(updated);
  return updated;
}

export function resolveDefaultAdapterCommand(adapter: BridgeAdapterKind): string {
  return adapter;
}
