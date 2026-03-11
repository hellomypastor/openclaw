import fs from "node:fs/promises";
import { DEFAULT_BROWSER_EVALUATE_ENABLED } from "../../browser/constants.js";
import { ensureBrowserControlAuth, resolveBrowserControlAuth } from "../../browser/control-auth.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { syncSkillsToWorkspace } from "../skills.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../workspace.js";
import { ensureSandboxBrowser } from "./browser.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { ensureSandboxContainer } from "./docker.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { ensureOpenSandboxRuntime } from "./opensandbox.js";
import { maybePruneSandboxes } from "./prune.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir } from "./shared.js";
import type { SandboxContext, SandboxDockerConfig, SandboxWorkspaceInfo } from "./types.js";
import { ensureSandboxWorkspace } from "./workspace.js";

async function ensureSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  rawSessionKey: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<{
  agentWorkspaceDir: string;
  scopeKey: string;
  sandboxWorkspaceDir: string;
  workspaceDir: string;
}> {
  const { cfg, rawSessionKey } = params;

  const agentWorkspaceDir = resolveUserPath(
    params.workspaceDir?.trim() || DEFAULT_AGENT_WORKSPACE_DIR,
  );
  const workspaceRoot = resolveUserPath(cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const sandboxWorkspaceDir =
    cfg.scope === "shared" ? workspaceRoot : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;

  if (workspaceDir === sandboxWorkspaceDir) {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
    );
    if (cfg.workspaceAccess !== "rw") {
      try {
        await syncSkillsToWorkspace({
          sourceWorkspaceDir: agentWorkspaceDir,
          targetWorkspaceDir: sandboxWorkspaceDir,
          config: params.config,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
      }
    }
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  return { agentWorkspaceDir, scopeKey, sandboxWorkspaceDir, workspaceDir };
}

export async function resolveSandboxDockerUser(params: {
  docker: SandboxDockerConfig;
  workspaceDir: string;
  stat?: (workspaceDir: string) => Promise<{ uid: number; gid: number }>;
}): Promise<SandboxDockerConfig> {
  const configuredUser = params.docker.user?.trim();
  if (configuredUser) {
    return params.docker;
  }
  const stat = params.stat ?? ((workspaceDir: string) => fs.stat(workspaceDir));
  try {
    const workspaceStat = await stat(params.workspaceDir);
    const uid = Number.isInteger(workspaceStat.uid) ? workspaceStat.uid : null;
    const gid = Number.isInteger(workspaceStat.gid) ? workspaceStat.gid : null;
    if (uid === null || gid === null || uid < 0 || gid < 0) {
      return params.docker;
    }
    return { ...params.docker, user: `${uid}:${gid}` };
  } catch {
    return params.docker;
  }
}

function resolveSandboxSession(params: { config?: OpenClawConfig; sessionKey?: string }) {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: rawSessionKey,
  });
  if (!runtime.sandboxed) {
    return null;
  }

  const cfg = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  return { rawSessionKey, runtime, cfg };
}

function createOpenSandboxContext(params: {
  rawSessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  runtime: Awaited<ReturnType<typeof ensureOpenSandboxRuntime>>;
}): SandboxContext {
  const sandboxContext: SandboxContext = {
    enabled: true,
    backend: "opensandbox",
    sessionKey: params.rawSessionKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    workspaceAccess: params.cfg.workspaceAccess,
    containerName: params.runtime.sandboxId,
    containerWorkdir: params.cfg.opensandbox.workdir,
    docker: params.cfg.docker,
    opensandbox: {
      sandboxId: params.runtime.sandboxId,
      lifecycleBaseUrl: params.runtime.lifecycleBaseUrl,
      execdBaseUrl: params.runtime.execdBaseUrl,
      apiKey: params.runtime.apiKey,
    },
    tools: params.cfg.tools,
    browserAllowHostControl: false,
  };
  sandboxContext.fsBridge = createSandboxFsBridge({ sandbox: sandboxContext });
  return sandboxContext;
}

async function resolveSandboxBrowserAuth(params: {
  config?: OpenClawConfig;
  browserEnabled: boolean;
}) {
  if (!params.browserEnabled) {
    return undefined;
  }
  // Sandbox browser bridge server runs on a loopback TCP port; always wire up
  // the same auth that loopback browser clients will send (token/password).
  const cfgForAuth = params.config ?? loadConfig();
  let browserAuth = resolveBrowserControlAuth(cfgForAuth);
  try {
    const ensured = await ensureBrowserControlAuth({ cfg: cfgForAuth });
    browserAuth = ensured.auth;
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
  }
  return browserAuth;
}

function createDockerSandboxContext(params: {
  rawSessionKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  containerName: string;
  browser: Awaited<ReturnType<typeof ensureSandboxBrowser>>;
}): SandboxContext {
  const sandboxContext: SandboxContext = {
    enabled: true,
    backend: "docker",
    sessionKey: params.rawSessionKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    workspaceAccess: params.cfg.workspaceAccess,
    containerName: params.containerName,
    containerWorkdir: params.cfg.docker.workdir,
    docker: params.cfg.docker,
    tools: params.cfg.tools,
    browserAllowHostControl: params.cfg.browser.allowHostControl,
    browser: params.browser ?? undefined,
  };
  sandboxContext.fsBridge = createSandboxFsBridge({ sandbox: sandboxContext });
  return sandboxContext;
}

export async function resolveSandboxContext(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg } = resolved;

  await maybePruneSandboxes(cfg);

  const { agentWorkspaceDir, scopeKey, workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  if (cfg.backend === "opensandbox") {
    const runtime = await ensureOpenSandboxRuntime({
      config: params.config,
      cfg,
      scopeKey,
      sessionKey: rawSessionKey,
      workspaceDir,
    });
    return createOpenSandboxContext({
      rawSessionKey,
      workspaceDir,
      agentWorkspaceDir,
      cfg,
      runtime,
    });
  }

  const docker = await resolveSandboxDockerUser({
    docker: cfg.docker,
    workspaceDir,
  });
  const resolvedCfg = docker === cfg.docker ? cfg : { ...cfg, docker };

  const containerName = await ensureSandboxContainer({
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg: resolvedCfg,
  });

  const evaluateEnabled =
    params.config?.browser?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;

  const bridgeAuth = await resolveSandboxBrowserAuth({
    config: params.config,
    browserEnabled: resolvedCfg.browser.enabled,
  });
  const browser = await ensureSandboxBrowser({
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg: resolvedCfg,
    evaluateEnabled,
    bridgeAuth,
  });
  return createDockerSandboxContext({
    rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg: resolvedCfg,
    containerName,
    browser,
  });
}

export async function ensureSandboxWorkspaceForSession(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg } = resolved;

  const { workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  return {
    workspaceDir,
    containerWorkdir: cfg.backend === "opensandbox" ? cfg.opensandbox.workdir : cfg.docker.workdir,
  };
}
