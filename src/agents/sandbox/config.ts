import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentConfig } from "../agent-scope.js";
import {
  DEFAULT_OPENSANDBOX_ENDPOINT,
  DEFAULT_OPENSANDBOX_EXECD_PORT,
  DEFAULT_OPENSANDBOX_IMAGE,
  DEFAULT_OPENSANDBOX_PROTOCOL,
  DEFAULT_OPENSANDBOX_READY_TIMEOUT_SECONDS,
  DEFAULT_OPENSANDBOX_TIMEOUT_SECONDS,
  DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
  DEFAULT_SANDBOX_BROWSER_CDP_PORT,
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_BROWSER_NETWORK,
  DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
  DEFAULT_SANDBOX_BROWSER_PREFIX,
  DEFAULT_SANDBOX_BROWSER_VNC_PORT,
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_IDLE_HOURS,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_MAX_AGE_DAYS,
  DEFAULT_SANDBOX_WORKDIR,
  DEFAULT_SANDBOX_WORKSPACE_ROOT,
} from "./constants.js";
import { resolveSandboxToolPolicyForAgent } from "./tool-policy.js";
import type {
  SandboxBackend,
  SandboxBrowserConfig,
  SandboxConfig,
  SandboxDockerConfig,
  SandboxWorkspaceAccess,
  SandboxPruneConfig,
  SandboxScope,
} from "./types.js";

export const DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS = [
  "dangerouslyAllowReservedContainerTargets",
  "dangerouslyAllowExternalBindSources",
  "dangerouslyAllowContainerNamespaceJoin",
] as const;

type DangerousSandboxDockerBooleanKey = (typeof DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS)[number];
type DangerousSandboxDockerBooleans = Pick<SandboxDockerConfig, DangerousSandboxDockerBooleanKey>;

function resolveDangerousSandboxDockerBooleans(
  agentDocker?: Partial<SandboxDockerConfig>,
  globalDocker?: Partial<SandboxDockerConfig>,
): DangerousSandboxDockerBooleans {
  const resolved = {} as DangerousSandboxDockerBooleans;
  for (const key of DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS) {
    resolved[key] = agentDocker?.[key] ?? globalDocker?.[key];
  }
  return resolved;
}

export function resolveSandboxBrowserDockerCreateConfig(params: {
  docker: SandboxDockerConfig;
  browser: SandboxBrowserConfig;
}): SandboxDockerConfig {
  const browserNetwork = params.browser.network.trim();
  const base: SandboxDockerConfig = {
    ...params.docker,
    // Browser container needs network access for Chrome, downloads, etc.
    network: browserNetwork || DEFAULT_SANDBOX_BROWSER_NETWORK,
    // For hashing and consistency, treat browser image as the docker image even though we
    // pass it separately as the final `docker create` argument.
    image: params.browser.image,
  };
  return params.browser.binds !== undefined ? { ...base, binds: params.browser.binds } : base;
}

export function resolveSandboxScope(params: {
  scope?: SandboxScope;
  perSession?: boolean;
}): SandboxScope {
  if (params.scope) {
    return params.scope;
  }
  if (typeof params.perSession === "boolean") {
    return params.perSession ? "session" : "shared";
  }
  return "agent";
}

export function resolveSandboxDockerConfig(params: {
  scope: SandboxScope;
  globalDocker?: Partial<SandboxDockerConfig>;
  agentDocker?: Partial<SandboxDockerConfig>;
}): SandboxDockerConfig {
  const agentDocker = params.scope === "shared" ? undefined : params.agentDocker;
  const globalDocker = params.globalDocker;

  const env = agentDocker?.env
    ? { ...(globalDocker?.env ?? { LANG: "C.UTF-8" }), ...agentDocker.env }
    : (globalDocker?.env ?? { LANG: "C.UTF-8" });

  const ulimits = agentDocker?.ulimits
    ? { ...globalDocker?.ulimits, ...agentDocker.ulimits }
    : globalDocker?.ulimits;

  const binds = [...(globalDocker?.binds ?? []), ...(agentDocker?.binds ?? [])];

  return {
    image: agentDocker?.image ?? globalDocker?.image ?? DEFAULT_SANDBOX_IMAGE,
    containerPrefix:
      agentDocker?.containerPrefix ??
      globalDocker?.containerPrefix ??
      DEFAULT_SANDBOX_CONTAINER_PREFIX,
    workdir: agentDocker?.workdir ?? globalDocker?.workdir ?? DEFAULT_SANDBOX_WORKDIR,
    readOnlyRoot: agentDocker?.readOnlyRoot ?? globalDocker?.readOnlyRoot ?? true,
    tmpfs: agentDocker?.tmpfs ?? globalDocker?.tmpfs ?? ["/tmp", "/var/tmp", "/run"],
    network: agentDocker?.network ?? globalDocker?.network ?? "none",
    user: agentDocker?.user ?? globalDocker?.user,
    capDrop: agentDocker?.capDrop ?? globalDocker?.capDrop ?? ["ALL"],
    env,
    setupCommand: agentDocker?.setupCommand ?? globalDocker?.setupCommand,
    pidsLimit: agentDocker?.pidsLimit ?? globalDocker?.pidsLimit,
    memory: agentDocker?.memory ?? globalDocker?.memory,
    memorySwap: agentDocker?.memorySwap ?? globalDocker?.memorySwap,
    cpus: agentDocker?.cpus ?? globalDocker?.cpus,
    ulimits,
    seccompProfile: agentDocker?.seccompProfile ?? globalDocker?.seccompProfile,
    apparmorProfile: agentDocker?.apparmorProfile ?? globalDocker?.apparmorProfile,
    dns: agentDocker?.dns ?? globalDocker?.dns,
    extraHosts: agentDocker?.extraHosts ?? globalDocker?.extraHosts,
    binds: binds.length ? binds : undefined,
    ...resolveDangerousSandboxDockerBooleans(agentDocker, globalDocker),
  };
}

function resolveSandboxBackend(params: {
  globalBackend?: SandboxBackend;
  agentBackend?: SandboxBackend;
}): SandboxBackend {
  return params.agentBackend ?? params.globalBackend ?? "docker";
}

function resolveOpenSandboxConfig(params: {
  globalOpenSandbox?: SandboxConfig["opensandbox"];
  agentOpenSandbox?: SandboxConfig["opensandbox"];
}) {
  return {
    endpoint:
      params.agentOpenSandbox?.endpoint ??
      params.globalOpenSandbox?.endpoint ??
      DEFAULT_OPENSANDBOX_ENDPOINT,
    apiKey: params.agentOpenSandbox?.apiKey ?? params.globalOpenSandbox?.apiKey,
    protocol:
      params.agentOpenSandbox?.protocol ??
      params.globalOpenSandbox?.protocol ??
      DEFAULT_OPENSANDBOX_PROTOCOL,
    image:
      params.agentOpenSandbox?.image ??
      params.globalOpenSandbox?.image ??
      DEFAULT_OPENSANDBOX_IMAGE,
    workdir:
      params.agentOpenSandbox?.workdir ??
      params.globalOpenSandbox?.workdir ??
      DEFAULT_SANDBOX_WORKDIR,
    timeoutSeconds:
      params.agentOpenSandbox?.timeoutSeconds ??
      params.globalOpenSandbox?.timeoutSeconds ??
      DEFAULT_OPENSANDBOX_TIMEOUT_SECONDS,
    readyTimeoutSeconds:
      params.agentOpenSandbox?.readyTimeoutSeconds ??
      params.globalOpenSandbox?.readyTimeoutSeconds ??
      DEFAULT_OPENSANDBOX_READY_TIMEOUT_SECONDS,
    resourceLimits:
      params.agentOpenSandbox?.resourceLimits ?? params.globalOpenSandbox?.resourceLimits ?? {},
    env: params.agentOpenSandbox?.env ?? params.globalOpenSandbox?.env ?? {},
    metadata: params.agentOpenSandbox?.metadata ?? params.globalOpenSandbox?.metadata ?? {},
    extensions: params.agentOpenSandbox?.extensions ?? params.globalOpenSandbox?.extensions ?? {},
    execdPort:
      params.agentOpenSandbox?.execdPort ??
      params.globalOpenSandbox?.execdPort ??
      DEFAULT_OPENSANDBOX_EXECD_PORT,
  };
}

export function resolveSandboxBrowserConfig(params: {
  scope: SandboxScope;
  globalBrowser?: Partial<SandboxBrowserConfig>;
  agentBrowser?: Partial<SandboxBrowserConfig>;
}): SandboxBrowserConfig {
  const agentBrowser = params.scope === "shared" ? undefined : params.agentBrowser;
  const globalBrowser = params.globalBrowser;
  const binds = [...(globalBrowser?.binds ?? []), ...(agentBrowser?.binds ?? [])];
  // Treat `binds: []` as an explicit override, so it can disable `docker.binds` for the browser container.
  const bindsConfigured = globalBrowser?.binds !== undefined || agentBrowser?.binds !== undefined;
  return {
    enabled: agentBrowser?.enabled ?? globalBrowser?.enabled ?? false,
    image: agentBrowser?.image ?? globalBrowser?.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE,
    containerPrefix:
      agentBrowser?.containerPrefix ??
      globalBrowser?.containerPrefix ??
      DEFAULT_SANDBOX_BROWSER_PREFIX,
    network: agentBrowser?.network ?? globalBrowser?.network ?? DEFAULT_SANDBOX_BROWSER_NETWORK,
    cdpPort: agentBrowser?.cdpPort ?? globalBrowser?.cdpPort ?? DEFAULT_SANDBOX_BROWSER_CDP_PORT,
    cdpSourceRange: agentBrowser?.cdpSourceRange ?? globalBrowser?.cdpSourceRange,
    vncPort: agentBrowser?.vncPort ?? globalBrowser?.vncPort ?? DEFAULT_SANDBOX_BROWSER_VNC_PORT,
    noVncPort:
      agentBrowser?.noVncPort ?? globalBrowser?.noVncPort ?? DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
    headless: agentBrowser?.headless ?? globalBrowser?.headless ?? false,
    enableNoVnc: agentBrowser?.enableNoVnc ?? globalBrowser?.enableNoVnc ?? true,
    allowHostControl: agentBrowser?.allowHostControl ?? globalBrowser?.allowHostControl ?? false,
    autoStart: agentBrowser?.autoStart ?? globalBrowser?.autoStart ?? true,
    autoStartTimeoutMs:
      agentBrowser?.autoStartTimeoutMs ??
      globalBrowser?.autoStartTimeoutMs ??
      DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
    binds: bindsConfigured ? binds : undefined,
  };
}

export function resolveSandboxPruneConfig(params: {
  scope: SandboxScope;
  globalPrune?: Partial<SandboxPruneConfig>;
  agentPrune?: Partial<SandboxPruneConfig>;
}): SandboxPruneConfig {
  const agentPrune = params.scope === "shared" ? undefined : params.agentPrune;
  const globalPrune = params.globalPrune;
  return {
    idleHours: agentPrune?.idleHours ?? globalPrune?.idleHours ?? DEFAULT_SANDBOX_IDLE_HOURS,
    maxAgeDays: agentPrune?.maxAgeDays ?? globalPrune?.maxAgeDays ?? DEFAULT_SANDBOX_MAX_AGE_DAYS,
  };
}

export function resolveSandboxConfigForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
): SandboxConfig {
  const agent = cfg?.agents?.defaults?.sandbox;

  // Agent-specific sandbox config overrides global
  let agentSandbox: typeof agent | undefined;
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  if (agentConfig?.sandbox) {
    agentSandbox = agentConfig.sandbox;
  }

  const scope = resolveSandboxScope({
    scope: agentSandbox?.scope ?? agent?.scope,
    perSession: agentSandbox?.perSession ?? agent?.perSession,
  });

  const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, agentId);
  const backend = resolveSandboxBackend({
    globalBackend: agent?.backend,
    agentBackend: agentSandbox?.backend,
  });
  const workspaceAccess = agentSandbox?.workspaceAccess ?? agent?.workspaceAccess ?? "none";
  const browser = resolveSandboxBrowserConfig({
    scope,
    globalBrowser: agent?.browser,
    agentBrowser: agentSandbox?.browser,
  });
  const opensandbox = resolveOpenSandboxConfig({
    globalOpenSandbox: agent?.opensandbox as SandboxConfig["opensandbox"] | undefined,
    agentOpenSandbox: agentSandbox?.opensandbox as SandboxConfig["opensandbox"] | undefined,
  });

  validateResolvedSandboxConfig({
    backend,
    workspaceAccess,
    browserEnabled: browser.enabled,
  });

  return {
    backend,
    mode: agentSandbox?.mode ?? agent?.mode ?? "off",
    scope,
    workspaceAccess,
    workspaceRoot:
      agentSandbox?.workspaceRoot ?? agent?.workspaceRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT,
    docker: resolveSandboxDockerConfig({
      scope,
      globalDocker: agent?.docker,
      agentDocker: agentSandbox?.docker,
    }),
    opensandbox,
    browser,
    tools: {
      allow: toolPolicy.allow,
      deny: toolPolicy.deny,
    },
    prune: resolveSandboxPruneConfig({
      scope,
      globalPrune: agent?.prune,
      agentPrune: agentSandbox?.prune,
    }),
  };
}

function validateResolvedSandboxConfig(params: {
  backend: SandboxBackend;
  workspaceAccess: SandboxWorkspaceAccess;
  browserEnabled: boolean;
}) {
  if (params.backend !== "opensandbox") {
    return;
  }
  if (params.workspaceAccess !== "none") {
    throw new Error(
      `sandbox.backend=opensandbox currently supports only workspaceAccess=none (got ${params.workspaceAccess}).`,
    );
  }
  if (params.browserEnabled) {
    throw new Error("sandbox.browser.enabled is not supported when sandbox.backend=opensandbox.");
  }
}
