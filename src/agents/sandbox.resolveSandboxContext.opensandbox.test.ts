import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSandboxContext } from "./sandbox/context.js";

const opensandboxMocks = vi.hoisted(() => ({
  ensureOpenSandboxRuntime: vi.fn(),
}));

vi.mock("./sandbox/opensandbox.js", () => ({
  ensureOpenSandboxRuntime: opensandboxMocks.ensureOpenSandboxRuntime,
}));

const tempDirs: string[] = [];

async function makeTempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-opensandbox-context-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveSandboxContext (opensandbox)", () => {
  afterEach(async () => {
    opensandboxMocks.ensureOpenSandboxRuntime.mockReset();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("returns an opensandbox-backed sandbox context", async () => {
    const workspaceDir = await makeTempWorkspace();
    opensandboxMocks.ensureOpenSandboxRuntime.mockResolvedValue({
      sandboxId: "sbx-test",
      lifecycleBaseUrl: "http://127.0.0.1:8080/v1",
      execdBaseUrl: "http://127.0.0.1:8080/sandboxes/sbx-test/port/44772",
      apiKey: "token",
    });

    const sandbox = await resolveSandboxContext({
      config: {
        agents: {
          defaults: {
            sandbox: {
              backend: "opensandbox",
              mode: "all",
              opensandbox: {
                endpoint: "http://127.0.0.1:8080",
              },
            },
          },
          list: [{ id: "main" }],
        },
      },
      sessionKey: "agent:main:task",
      workspaceDir,
    });

    expect(sandbox?.backend).toBe("opensandbox");
    expect(sandbox?.containerName).toBe("sbx-test");
    expect(sandbox?.opensandbox).toMatchObject({
      sandboxId: "sbx-test",
      lifecycleBaseUrl: "http://127.0.0.1:8080/v1",
      execdBaseUrl: "http://127.0.0.1:8080/sandboxes/sbx-test/port/44772",
      apiKey: "token",
    });
    expect(opensandboxMocks.ensureOpenSandboxRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeKey: "agent:main",
        sessionKey: "agent:main:task",
        workspaceDir: expect.any(String),
      }),
    );
  });
});
