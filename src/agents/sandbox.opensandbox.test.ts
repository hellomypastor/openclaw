import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenSandboxTestConfig,
  cleanupTempDirs,
  makeTempDir,
  sseResponse,
} from "./sandbox.opensandbox-test-helpers.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import {
  ensureOpenSandboxRuntime,
  resetOpenSandboxRuntimesForTests,
  runOpenSandboxCommand,
} from "./sandbox/opensandbox.js";

type FetchRecord = {
  input: string;
  method: string;
  bodyText?: string;
};

describe("opensandbox runtime", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetOpenSandboxRuntimesForTests();
    await cleanupTempDirs();
  });

  it("creates an opensandbox runtime, syncs workspace contents, and reuses healthy cache entries", async () => {
    const workspaceDir = await makeTempDir("openclaw-opensandbox-runtime-");
    await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "root.txt"), "root-data");
    await fs.writeFile(path.join(workspaceDir, "nested", "child.txt"), "child-data");

    const requests: FetchRecord[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const record: FetchRecord = {
        input: url,
        method,
      };

      if (typeof init?.body === "string") {
        record.bodyText = init.body;
      } else if (init?.body instanceof FormData) {
        const metadata = init.body.get("metadata");
        const file = init.body.get("file");
        record.bodyText = [
          metadata instanceof Blob ? await metadata.text() : "",
          file instanceof Blob ? await file.text() : "",
        ].join("\n");
      }

      requests.push(record);

      if (url === "http://opensandbox.test/v1/sandboxes" && method === "POST") {
        return Response.json({ id: "sbx-test" });
      }
      if (
        url === "http://opensandbox.test/v1/sandboxes/sbx-test/endpoints/44772" &&
        method === "GET"
      ) {
        return Response.json({ endpoint: "opensandbox.test" });
      }
      if (url === "http://opensandbox.test/v1/sandboxes/sbx-test" && method === "GET") {
        return Response.json({ status: { state: "Running" } });
      }
      if (url === "http://opensandbox.test/health/ping" && method === "GET") {
        return new Response("ok", { status: 200 });
      }
      if (url === "http://opensandbox.test/directories" && method === "POST") {
        return Response.json({});
      }
      if (url === "http://opensandbox.test/files/upload" && method === "POST") {
        return Response.json({});
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = resolveSandboxConfigForAgent(buildOpenSandboxTestConfig());

    const runtime = await ensureOpenSandboxRuntime({
      cfg,
      scopeKey: "agent:main",
      sessionKey: "agent:main:task",
      workspaceDir,
    });
    await fs.writeFile(path.join(workspaceDir, "new-host-file.txt"), "host-refresh-data");
    const reused = await ensureOpenSandboxRuntime({
      cfg,
      scopeKey: "agent:main",
      sessionKey: "agent:main:task",
      workspaceDir,
    });

    const createCalls = requests.filter(
      (request) =>
        request.input === "http://opensandbox.test/v1/sandboxes" && request.method === "POST",
    );
    const uploadBodies = requests
      .filter((request) => request.input === "http://opensandbox.test/files/upload")
      .map((request) => request.bodyText ?? "");
    const directoryBodies = requests
      .filter((request) => request.input === "http://opensandbox.test/directories")
      .map((request) => request.bodyText ?? "");

    expect(runtime.sandboxId).toBe("sbx-test");
    expect(runtime.execdBaseUrl).toBe("http://opensandbox.test");
    expect(reused).toBe(runtime);
    expect(createCalls).toHaveLength(1);
    expect(directoryBodies.some((body) => body.includes("/workspace/nested"))).toBe(true);
    expect(
      uploadBodies.some(
        (body) => body.includes('"path":"/workspace/root.txt"') && body.includes("root-data"),
      ),
    ).toBe(true);
    expect(
      uploadBodies.some(
        (body) =>
          body.includes('"path":"/workspace/nested/child.txt"') && body.includes("child-data"),
      ),
    ).toBe(true);
    expect(
      uploadBodies.some(
        (body) =>
          body.includes('"path":"/workspace/new-host-file.txt"') &&
          body.includes("host-refresh-data"),
      ),
    ).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "syncs symlinked files and directories that stay within the workspace",
    async () => {
      const workspaceDir = await makeTempDir("openclaw-opensandbox-symlink-runtime-");
      await fs.mkdir(path.join(workspaceDir, "real-dir"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "real.txt"), "real-data");
      await fs.writeFile(path.join(workspaceDir, "real-dir", "nested.txt"), "nested-data");
      await fs.symlink("real.txt", path.join(workspaceDir, "linked.txt"));
      await fs.symlink("real-dir", path.join(workspaceDir, "linked-dir"));

      const uploads: string[] = [];
      const directories: string[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? "GET";

        if (url === "http://opensandbox.test/v1/sandboxes" && method === "POST") {
          return Response.json({ id: "sbx-symlink" });
        }
        if (
          url === "http://opensandbox.test/v1/sandboxes/sbx-symlink/endpoints/44772" &&
          method === "GET"
        ) {
          return Response.json({ endpoint: "opensandbox.test" });
        }
        if (url === "http://opensandbox.test/v1/sandboxes/sbx-symlink" && method === "GET") {
          return Response.json({ status: { state: "Running" } });
        }
        if (url === "http://opensandbox.test/health/ping" && method === "GET") {
          return new Response("ok", { status: 200 });
        }
        if (url === "http://opensandbox.test/directories" && method === "POST") {
          directories.push(typeof init?.body === "string" ? init.body : "");
          return Response.json({});
        }
        if (url === "http://opensandbox.test/files/upload" && method === "POST") {
          if (init?.body instanceof FormData) {
            const metadata = init.body.get("metadata");
            const file = init.body.get("file");
            uploads.push(
              [
                metadata instanceof Blob ? await metadata.text() : "",
                file instanceof Blob ? await file.text() : "",
              ].join("\n"),
            );
          }
          return Response.json({});
        }

        throw new Error(`Unhandled fetch: ${method} ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const cfg = resolveSandboxConfigForAgent(buildOpenSandboxTestConfig());

      await ensureOpenSandboxRuntime({
        cfg,
        scopeKey: "agent:symlink",
        sessionKey: "agent:symlink:task",
        workspaceDir,
      });

      expect(
        uploads.some(
          (body) => body.includes('"path":"/workspace/linked.txt"') && body.includes("real-data"),
        ),
      ).toBe(true);
      expect(directories.some((body) => body.includes("/workspace/linked-dir"))).toBe(true);
      expect(
        uploads.some(
          (body) =>
            body.includes('"path":"/workspace/linked-dir/nested.txt"') &&
            body.includes("nested-data"),
        ),
      ).toBe(true);
    },
  );

  it("parses streamed command output and exit status", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url === "http://opensandbox.test/command" && method === "POST") {
        return sseResponse([
          'data: {"type":"init","text":"cmd-123"}\n\n',
          'data: {"type":"stdout","text":"hello "}\n\ndata: {"type":"stdout","text":"world"}\n\n',
          'data: {"type":"stderr","text":"warn"}\n\n',
          'data: {"type":"status","text":"0"}\n\n',
          'data: {"type":"execution_complete"}\n\n',
        ]);
      }
      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const initIds: string[] = [];

    const result = await runOpenSandboxCommand({
      execdBaseUrl: "http://opensandbox.test",
      command: "echo hello",
      captureOutput: true,
      onInit: (commandId) => initIds.push(commandId),
      onStdout: (text) => stdoutChunks.push(text),
      onStderr: (text) => stderrChunks.push(text),
    });

    expect(result).toMatchObject({
      commandId: "cmd-123",
      stdout: "hello world",
      stderr: "warn",
      exitCode: 0,
    });
    expect(initIds).toEqual(["cmd-123"]);
    expect(stdoutChunks).toEqual(["hello ", "world"]);
    expect(stderrChunks).toEqual(["warn"]);
  });

  it("parses multi-line SSE data frames across chunk boundaries", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      if (url === "http://opensandbox.test/command" && method === "POST") {
        return sseResponse([
          'data: {"type":"init",',
          '"text":"cmd-456"}\r\n\r\n',
          'data: {"type":"stdout",\r\n',
          'data: "text":"chunked output"}\r\n\r\n',
          'data: {"type":"status","text":"0"}\r\n\r\n',
        ]);
      }
      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runOpenSandboxCommand({
      execdBaseUrl: "http://opensandbox.test",
      command: "echo chunked",
      captureOutput: true,
    });

    expect(result).toMatchObject({
      commandId: "cmd-456",
      stdout: "chunked output",
      exitCode: 0,
    });
  });

  it("deduplicates concurrent runtime creation by scope key", async () => {
    const workspaceDir = await makeTempDir("openclaw-opensandbox-concurrent-runtime-");
    let createCount = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://opensandbox.test/v1/sandboxes" && method === "POST") {
        createCount += 1;
        return Response.json({ id: "sbx-concurrent" });
      }
      if (
        url === "http://opensandbox.test/v1/sandboxes/sbx-concurrent/endpoints/44772" &&
        method === "GET"
      ) {
        return Response.json({ endpoint: "opensandbox.test" });
      }
      if (url === "http://opensandbox.test/v1/sandboxes/sbx-concurrent" && method === "GET") {
        return Response.json({ status: { state: "Running" } });
      }
      if (url === "http://opensandbox.test/health/ping" && method === "GET") {
        return new Response("ok", { status: 200 });
      }
      if (url === "http://opensandbox.test/directories" && method === "POST") {
        return Response.json({});
      }
      if (url === "http://opensandbox.test/files/upload" && method === "POST") {
        return Response.json({});
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = resolveSandboxConfigForAgent(buildOpenSandboxTestConfig());

    const [runtimeA, runtimeB] = await Promise.all([
      ensureOpenSandboxRuntime({
        cfg,
        scopeKey: "agent:shared",
        sessionKey: "agent:shared:one",
        workspaceDir,
      }),
      ensureOpenSandboxRuntime({
        cfg,
        scopeKey: "agent:shared",
        sessionKey: "agent:shared:two",
        workspaceDir,
      }),
    ]);

    expect(createCount).toBe(1);
    expect(runtimeA).toBe(runtimeB);
  });

  it("recreates cached runtimes when the cached execd probe fails", async () => {
    const workspaceDir = await makeTempDir("openclaw-opensandbox-recreate-runtime-");
    const createdIds = ["sbx-stale", "sbx-fresh"];
    let createCount = 0;
    let healthChecks = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://opensandbox.test/v1/sandboxes" && method === "POST") {
        const id = createdIds[createCount] ?? `sbx-${createCount}`;
        createCount += 1;
        return Response.json({ id });
      }
      if (
        url === "http://opensandbox.test/v1/sandboxes/sbx-stale/endpoints/44772" &&
        method === "GET"
      ) {
        return Response.json({ endpoint: "opensandbox.test/stale" });
      }
      if (
        url === "http://opensandbox.test/v1/sandboxes/sbx-fresh/endpoints/44772" &&
        method === "GET"
      ) {
        return Response.json({ endpoint: "opensandbox.test/fresh" });
      }
      if (
        (url === "http://opensandbox.test/v1/sandboxes/sbx-stale" ||
          url === "http://opensandbox.test/v1/sandboxes/sbx-fresh") &&
        method === "GET"
      ) {
        return Response.json({ status: { state: "Running" } });
      }
      if (url === "http://opensandbox.test/stale/health/ping" && method === "GET") {
        healthChecks += 1;
        if (healthChecks === 2) {
          throw new Error("socket hang up");
        }
        return new Response("ok", { status: 200 });
      }
      if (url === "http://opensandbox.test/fresh/health/ping" && method === "GET") {
        return new Response("ok", { status: 200 });
      }
      if (url === "http://opensandbox.test/stale/directories" && method === "POST") {
        return Response.json({});
      }
      if (url === "http://opensandbox.test/stale/files/upload" && method === "POST") {
        return Response.json({});
      }
      if (url === "http://opensandbox.test/fresh/directories" && method === "POST") {
        return Response.json({});
      }
      if (url === "http://opensandbox.test/fresh/files/upload" && method === "POST") {
        return Response.json({});
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = resolveSandboxConfigForAgent(
      buildOpenSandboxTestConfig("http://opensandbox.test/v1"),
    );

    const stale = await ensureOpenSandboxRuntime({
      cfg,
      scopeKey: "agent:main",
      sessionKey: "agent:main:first",
      workspaceDir,
    });
    const fresh = await ensureOpenSandboxRuntime({
      cfg,
      scopeKey: "agent:main",
      sessionKey: "agent:main:second",
      workspaceDir,
    });

    expect(stale.sandboxId).toBe("sbx-stale");
    expect(fresh.sandboxId).toBe("sbx-fresh");
    expect(createCount).toBe(2);
  });

  it("tolerates transient execd probe failures while waiting for readiness", async () => {
    const workspaceDir = await makeTempDir("openclaw-opensandbox-ready-retry-");
    let healthChecks = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://opensandbox.test/v1/sandboxes" && method === "POST") {
        return Response.json({ id: "sbx-retry" });
      }
      if (
        url === "http://opensandbox.test/v1/sandboxes/sbx-retry/endpoints/44772" &&
        method === "GET"
      ) {
        return Response.json({ endpoint: "opensandbox.test" });
      }
      if (url === "http://opensandbox.test/v1/sandboxes/sbx-retry" && method === "GET") {
        return Response.json({ status: { state: "Running" } });
      }
      if (url === "http://opensandbox.test/health/ping" && method === "GET") {
        healthChecks += 1;
        if (healthChecks === 1) {
          throw new Error("connection reset");
        }
        return new Response("ok", { status: 200 });
      }
      if (url === "http://opensandbox.test/directories" && method === "POST") {
        return Response.json({});
      }
      if (url === "http://opensandbox.test/files/upload" && method === "POST") {
        return Response.json({});
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = resolveSandboxConfigForAgent(buildOpenSandboxTestConfig());

    const runtime = await ensureOpenSandboxRuntime({
      cfg,
      scopeKey: "agent:retry",
      sessionKey: "agent:retry:task",
      workspaceDir,
    });

    expect(runtime.sandboxId).toBe("sbx-retry");
    expect(healthChecks).toBe(2);
  });
});
