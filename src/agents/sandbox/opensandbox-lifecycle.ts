import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveConfiguredSecretInputString } from "../../gateway/resolve-configured-secret-input-string.js";
import {
  buildOpenSandboxHeaders,
  buildOpenSandboxLifecycleBaseUrl,
  fetchOpenSandboxJson,
  OPEN_SANDBOX_HEALTH_PATH,
} from "./opensandbox-client.js";
import { createOpenSandboxDirectories, writeOpenSandboxFile } from "./opensandbox-fs.js";
import type { SandboxConfig } from "./types.js";

const DEFAULT_ENTRYPOINT = ["tail", "-f", "/dev/null"];

export type OpenSandboxRuntime = {
  scopeKey: string;
  sessionKey: string;
  sandboxId: string;
  lifecycleBaseUrl: string;
  execdBaseUrl: string;
  apiKey?: string;
  lastUsedAtMs: number;
};

type OpenSandboxStatusResponse = {
  status?: {
    state?: string;
  };
};

type OpenSandboxCreateResponse = {
  id?: string;
};

type OpenSandboxEndpointResponse = {
  endpoint?: string;
};

const OPEN_SANDBOX_RUNTIMES = new Map<string, OpenSandboxRuntime>();
const OPEN_SANDBOX_RUNTIME_CREATIONS = new Map<string, Promise<OpenSandboxRuntime>>();

export function resetOpenSandboxRuntimesForTests() {
  OPEN_SANDBOX_RUNTIMES.clear();
  OPEN_SANDBOX_RUNTIME_CREATIONS.clear();
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function pingExecd(params: { execdBaseUrl: string; apiKey?: string }) {
  try {
    const response = await fetch(`${params.execdBaseUrl}${OPEN_SANDBOX_HEALTH_PATH}`, {
      method: "GET",
      headers: buildOpenSandboxHeaders(params.apiKey),
    });
    return {
      ok: response.ok,
      detail: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: formatErrorMessage(error),
    };
  }
}

async function syncWorkspaceToRuntime(params: {
  runtime: Pick<OpenSandboxRuntime, "execdBaseUrl" | "apiKey">;
  localWorkspaceDir: string;
  remoteWorkspaceDir: string;
}) {
  await syncWorkspaceToOpenSandbox({
    execdBaseUrl: params.runtime.execdBaseUrl,
    apiKey: params.runtime.apiKey,
    localWorkspaceDir: params.localWorkspaceDir,
    remoteWorkspaceDir: params.remoteWorkspaceDir,
  });
}

async function waitForSandboxReady(params: {
  lifecycleBaseUrl: string;
  sandboxId: string;
  execdBaseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  let lastState = "Creating";
  let lastDetail = "awaiting sandbox status";
  while (Date.now() < deadline) {
    try {
      const status = await fetchOpenSandboxJson<OpenSandboxStatusResponse>(
        `${params.lifecycleBaseUrl}/sandboxes/${encodeURIComponent(params.sandboxId)}`,
        {
          method: "GET",
          headers: buildOpenSandboxHeaders(params.apiKey),
        },
      );
      lastState = status.status?.state?.trim() || lastState;
      lastDetail = `state: ${lastState}`;
      if (lastState === "Running") {
        const health = await pingExecd(params);
        if (health.ok) {
          return;
        }
        if (health.detail) {
          lastDetail = `state: ${lastState}; execd: ${health.detail}`;
        }
      }
    } catch (error) {
      lastDetail = `state: ${lastState}; status: ${formatErrorMessage(error)}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for OpenSandbox ${params.sandboxId} to become ready (${lastDetail}).`,
  );
}

async function getSandboxEndpoint(params: {
  lifecycleBaseUrl: string;
  sandboxId: string;
  apiKey?: string;
  protocol: "http" | "https";
  execdPort: number;
}) {
  const endpoint = await fetchOpenSandboxJson<OpenSandboxEndpointResponse>(
    `${params.lifecycleBaseUrl}/sandboxes/${encodeURIComponent(params.sandboxId)}/endpoints/${params.execdPort}`,
    {
      method: "GET",
      headers: buildOpenSandboxHeaders(params.apiKey),
    },
  );
  const raw = endpoint.endpoint?.trim();
  if (!raw) {
    throw new Error(`OpenSandbox did not return an execd endpoint for ${params.sandboxId}.`);
  }
  return `${params.protocol}://${raw}`;
}

async function resolveApiKey(params: { config?: OpenClawConfig; sandboxConfig: SandboxConfig }) {
  if (!params.config || !params.sandboxConfig.opensandbox.apiKey) {
    return undefined;
  }
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: process.env,
    value: params.sandboxConfig.opensandbox.apiKey,
    path: "agents.defaults.sandbox.opensandbox.apiKey",
  });
  if (resolved.unresolvedRefReason) {
    throw new Error(resolved.unresolvedRefReason);
  }
  return resolved.value;
}

async function syncWorkspaceToOpenSandbox(params: {
  execdBaseUrl: string;
  apiKey?: string;
  localWorkspaceDir: string;
  remoteWorkspaceDir: string;
}) {
  const workspaceRootRealPath = await fs.realpath(params.localWorkspaceDir);
  await syncWorkspaceDirectory({
    execdBaseUrl: params.execdBaseUrl,
    apiKey: params.apiKey,
    localWorkspaceDir: params.localWorkspaceDir,
    remoteWorkspaceDir: params.remoteWorkspaceDir,
    workspaceRootRealPath,
    activeDirectoryRealPaths: new Set<string>(),
  });
}

function ensurePathWithinWorkspace(params: {
  workspaceRootRealPath: string;
  targetRealPath: string;
  localPath: string;
}) {
  const relative = path.relative(params.workspaceRootRealPath, params.targetRealPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`OpenSandbox workspace sync rejected symlink escape: ${params.localPath}`);
  }
}

async function syncWorkspaceDirectory(params: {
  execdBaseUrl: string;
  apiKey?: string;
  localWorkspaceDir: string;
  remoteWorkspaceDir: string;
  workspaceRootRealPath: string;
  activeDirectoryRealPaths: Set<string>;
}) {
  const directoryRealPath = await fs.realpath(params.localWorkspaceDir);
  ensurePathWithinWorkspace({
    workspaceRootRealPath: params.workspaceRootRealPath,
    targetRealPath: directoryRealPath,
    localPath: params.localWorkspaceDir,
  });
  if (params.activeDirectoryRealPaths.has(directoryRealPath)) {
    throw new Error(
      `OpenSandbox workspace sync detected a symlink directory cycle: ${directoryRealPath}`,
    );
  }
  params.activeDirectoryRealPaths.add(directoryRealPath);
  const entries = await fs.readdir(params.localWorkspaceDir, { withFileTypes: true });
  try {
    for (const entry of entries) {
      const localPath = path.join(params.localWorkspaceDir, entry.name);
      const remotePath = path.posix.join(params.remoteWorkspaceDir, entry.name);
      const stat = entry.isSymbolicLink() ? await fs.stat(localPath) : null;
      const isDirectory = entry.isDirectory() || stat?.isDirectory() === true;
      const isFile = entry.isFile() || stat?.isFile() === true;

      if (entry.isSymbolicLink()) {
        const targetRealPath = await fs.realpath(localPath);
        ensurePathWithinWorkspace({
          workspaceRootRealPath: params.workspaceRootRealPath,
          targetRealPath,
          localPath,
        });
      }

      if (isDirectory) {
        await createOpenSandboxDirectories({
          execdBaseUrl: params.execdBaseUrl,
          apiKey: params.apiKey,
          filePath: remotePath,
        });
        await syncWorkspaceDirectory({
          execdBaseUrl: params.execdBaseUrl,
          apiKey: params.apiKey,
          localWorkspaceDir: localPath,
          remoteWorkspaceDir: remotePath,
          workspaceRootRealPath: params.workspaceRootRealPath,
          activeDirectoryRealPaths: params.activeDirectoryRealPaths,
        });
        continue;
      }
      if (!isFile) {
        continue;
      }
      await writeOpenSandboxFile({
        execdBaseUrl: params.execdBaseUrl,
        apiKey: params.apiKey,
        filePath: remotePath,
        data: await fs.readFile(localPath),
      });
    }
  } finally {
    params.activeDirectoryRealPaths.delete(directoryRealPath);
  }
}

async function createRuntime(params: {
  config?: OpenClawConfig;
  cfg: SandboxConfig;
  scopeKey: string;
  sessionKey: string;
  workspaceDir: string;
}) {
  const lifecycleBaseUrl = buildOpenSandboxLifecycleBaseUrl(params.cfg.opensandbox.endpoint);
  const apiKey = await resolveApiKey({
    config: params.config,
    sandboxConfig: params.cfg,
  });
  const metadata = {
    ...params.cfg.opensandbox.metadata,
    openclaw_scope_key: params.scopeKey,
    openclaw_session_key: params.sessionKey,
  };
  const created = await fetchOpenSandboxJson<OpenSandboxCreateResponse>(
    `${lifecycleBaseUrl}/sandboxes`,
    {
      method: "POST",
      headers: buildOpenSandboxHeaders(apiKey, { "content-type": "application/json" }),
      body: JSON.stringify({
        image: { uri: params.cfg.opensandbox.image },
        entrypoint: DEFAULT_ENTRYPOINT,
        timeout: params.cfg.opensandbox.timeoutSeconds,
        resourceLimits: params.cfg.opensandbox.resourceLimits,
        env: {
          ...params.cfg.opensandbox.env,
          HOME: params.cfg.opensandbox.workdir,
        },
        metadata,
        extensions: params.cfg.opensandbox.extensions,
      }),
    },
  );
  const sandboxId = created.id?.trim();
  if (!sandboxId) {
    throw new Error("OpenSandbox createSandbox returned an empty sandbox id.");
  }
  const execdBaseUrl = await getSandboxEndpoint({
    lifecycleBaseUrl,
    sandboxId,
    apiKey,
    protocol: params.cfg.opensandbox.protocol,
    execdPort: params.cfg.opensandbox.execdPort,
  });
  await waitForSandboxReady({
    lifecycleBaseUrl,
    sandboxId,
    execdBaseUrl,
    apiKey,
    timeoutMs: params.cfg.opensandbox.readyTimeoutSeconds * 1000,
  });
  await syncWorkspaceToOpenSandbox({
    execdBaseUrl,
    apiKey,
    localWorkspaceDir: params.workspaceDir,
    remoteWorkspaceDir: params.cfg.opensandbox.workdir,
  });
  const runtime: OpenSandboxRuntime = {
    scopeKey: params.scopeKey,
    sessionKey: params.sessionKey,
    sandboxId,
    lifecycleBaseUrl,
    execdBaseUrl,
    apiKey,
    lastUsedAtMs: Date.now(),
  };
  OPEN_SANDBOX_RUNTIMES.set(params.scopeKey, runtime);
  return runtime;
}

export async function ensureOpenSandboxRuntime(params: {
  config?: OpenClawConfig;
  cfg: SandboxConfig;
  scopeKey: string;
  sessionKey: string;
  workspaceDir: string;
}) {
  const existing = OPEN_SANDBOX_RUNTIMES.get(params.scopeKey);
  if (existing) {
    existing.lastUsedAtMs = Date.now();
    const health = await pingExecd({
      execdBaseUrl: existing.execdBaseUrl,
      apiKey: existing.apiKey,
    });
    if (health.ok) {
      try {
        await syncWorkspaceToRuntime({
          runtime: existing,
          localWorkspaceDir: params.workspaceDir,
          remoteWorkspaceDir: params.cfg.opensandbox.workdir,
        });
      } catch (error) {
        OPEN_SANDBOX_RUNTIMES.delete(params.scopeKey);
        throw new Error(
          `Failed to sync workspace into cached OpenSandbox runtime ${existing.sandboxId}: ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }
      return existing;
    }
    OPEN_SANDBOX_RUNTIMES.delete(params.scopeKey);
  }
  const inFlight = OPEN_SANDBOX_RUNTIME_CREATIONS.get(params.scopeKey);
  if (inFlight) {
    return await inFlight;
  }
  const creation = createRuntime(params).finally(() => {
    OPEN_SANDBOX_RUNTIME_CREATIONS.delete(params.scopeKey);
  });
  OPEN_SANDBOX_RUNTIME_CREATIONS.set(params.scopeKey, creation);
  return await creation;
}

export async function deleteOpenSandboxRuntime(params: {
  lifecycleBaseUrl: string;
  sandboxId: string;
  apiKey?: string;
}) {
  const response = await fetch(
    `${params.lifecycleBaseUrl}/sandboxes/${encodeURIComponent(params.sandboxId)}`,
    {
      method: "DELETE",
      headers: buildOpenSandboxHeaders(params.apiKey),
    },
  );
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(body.trim() || `OpenSandbox delete failed (${response.status}).`);
  }
}
