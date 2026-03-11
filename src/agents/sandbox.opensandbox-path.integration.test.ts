import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import {
  cleanupTempDirs,
  makeTempDir,
  resolveOpenSandboxContextForTest,
  sseResponse,
} from "./sandbox.opensandbox-test-helpers.js";
import { createSandboxFsBridge } from "./sandbox/fs-bridge.js";
import { resetOpenSandboxRuntimesForTests } from "./sandbox/opensandbox.js";

type RemoteEntry =
  | { type: "file"; data: Buffer; modifiedAt: string }
  | { type: "directory"; modifiedAt: string };

function nowIso() {
  return new Date().toISOString();
}

async function buildRemoteFsTarBase64(remoteFs: Map<string, RemoteEntry>) {
  const tarRoot = await makeTempDir("openclaw-opensandbox-remote-sync-");
  for (const [remotePath, entry] of remoteFs) {
    if (remotePath === "/workspace") {
      continue;
    }
    const localPath = path.join(
      tarRoot,
      path.posix.relative("/workspace", remotePath).split(path.posix.sep).join(path.sep),
    );
    if (entry.type === "directory") {
      await fs.mkdir(localPath, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, entry.data);
  }
  const tarDir = await makeTempDir("openclaw-opensandbox-remote-archive-");
  const tarPath = path.join(tarDir, "workspace.tar");
  await tar.c({ cwd: tarRoot, file: tarPath }, ["."]);
  const tarBuffer = await fs.readFile(tarPath);
  return tarBuffer.toString("base64");
}

async function readFormDataUpload(body: FormData) {
  const metadata = body.get("metadata");
  const file = body.get("file");
  return {
    metadataText: metadata instanceof Blob ? await metadata.text() : "",
    fileText: file instanceof Blob ? await file.text() : "",
    fileBuffer:
      file instanceof Blob
        ? Buffer.from(new Uint8Array(await file.arrayBuffer()))
        : Buffer.alloc(0),
  };
}

describe("opensandbox integration path", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetOpenSandboxRuntimesForTests();
    await cleanupTempDirs();
  });

  async function runOpenSandboxExecForTest(params: {
    workspaceDir: string;
    command: string;
    timeoutSec?: number | null;
    containerWorkdir?: string;
  }) {
    const sandbox = await resolveOpenSandboxContextForTest(params.workspaceDir);
    expect(sandbox?.backend).toBe("opensandbox");
    if (!sandbox) {
      throw new Error("Expected sandbox context.");
    }
    const execHandle = await runExecProcess({
      command: params.command,
      workdir: params.workspaceDir,
      env: {},
      sandbox: {
        backend: "opensandbox",
        containerName: sandbox.containerName,
        workspaceDir: sandbox.workspaceDir,
        containerWorkdir: sandbox.containerWorkdir,
        opensandbox: sandbox.opensandbox,
      },
      containerWorkdir: params.containerWorkdir ?? sandbox.containerWorkdir,
      usePty: false,
      warnings: [],
      maxOutput: 20_000,
      pendingMaxOutput: 10_000,
      notifyOnExit: false,
      timeoutSec: params.timeoutSec ?? null,
    });
    return { sandbox, execHandle, execResult: await execHandle.promise };
  }

  it("connects sandbox context, fs bridge, and exec runtime through the opensandbox backend", async () => {
    const workspaceDir = await makeTempDir("openclaw-opensandbox-path-");
    await fs.writeFile(path.join(workspaceDir, "seed.txt"), "seed");

    const remoteFs = new Map<string, RemoteEntry>([
      ["/workspace", { type: "directory", modifiedAt: nowIso() }],
    ]);
    const commandBodies: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

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
        const payload = JSON.parse((init?.body as string | undefined) ?? "{}") as Record<
          string,
          unknown
        >;
        for (const dirPath of Object.keys(payload)) {
          remoteFs.set(dirPath, { type: "directory", modifiedAt: nowIso() });
        }
        return Response.json({});
      }
      if (
        url === "http://opensandbox.test/files/upload" &&
        method === "POST" &&
        init?.body instanceof FormData
      ) {
        const upload = await readFormDataUpload(init.body);
        const metadata = JSON.parse(upload.metadataText) as { path: string };
        remoteFs.set(metadata.path, {
          type: "file",
          data: upload.fileBuffer,
          modifiedAt: nowIso(),
        });
        return Response.json({});
      }
      if (url.startsWith("http://opensandbox.test/files/info") && method === "GET") {
        const requestUrl = new URL(url);
        const filePath = requestUrl.searchParams.get("path") ?? "";
        const entry = remoteFs.get(filePath);
        if (!entry) {
          return new Response("not found", { status: 404 });
        }
        return Response.json({
          [filePath]: {
            size: entry.type === "file" ? entry.data.length : 0,
            modifiedAt: entry.modifiedAt,
            mode: entry.type === "directory" ? 0o040755 : 0o100644,
          },
        });
      }
      if (url.startsWith("http://opensandbox.test/files/download") && method === "GET") {
        const requestUrl = new URL(url);
        const filePath = requestUrl.searchParams.get("path") ?? "";
        const entry = remoteFs.get(filePath);
        if (!entry || entry.type !== "file") {
          return new Response("not found", { status: 404 });
        }
        return new Response(new Uint8Array(entry.data), { status: 200 });
      }
      if (url === "http://opensandbox.test/files/mv" && method === "POST") {
        const payload = JSON.parse((init?.body as string | undefined) ?? "[]") as Array<{
          src: string;
          dest: string;
        }>;
        for (const move of payload) {
          const entry = remoteFs.get(move.src);
          if (!entry) {
            return new Response("not found", { status: 404 });
          }
          remoteFs.set(move.dest, entry);
          remoteFs.delete(move.src);
        }
        return Response.json({});
      }
      if (url.startsWith("http://opensandbox.test/files?") && method === "DELETE") {
        const requestUrl = new URL(url);
        const filePath = requestUrl.searchParams.get("path") ?? "";
        remoteFs.delete(filePath);
        return new Response(null, { status: 200 });
      }
      if (url.startsWith("http://opensandbox.test/directories?") && method === "DELETE") {
        const requestUrl = new URL(url);
        const filePath = requestUrl.searchParams.get("path") ?? "";
        for (const key of remoteFs.keys()) {
          if (key === filePath || key.startsWith(`${filePath}/`)) {
            remoteFs.delete(key);
          }
        }
        return new Response(null, { status: 200 });
      }
      if (url === "http://opensandbox.test/command" && method === "POST") {
        const body = (init?.body as string | undefined) ?? "";
        commandBodies.push(body);
        if (body.includes('"command":"tar -cf - . | base64"')) {
          return sseResponse([
            'data: {"type":"init","text":"cmd-sync"}\n\n',
            `data: ${JSON.stringify({
              type: "stdout",
              text: await buildRemoteFsTarBase64(remoteFs),
            })}\n\n`,
            'data: {"type":"status","text":"0"}\n\n',
            'data: {"type":"execution_complete"}\n\n',
          ]);
        }
        remoteFs.set("/workspace/generated.txt", {
          type: "file",
          data: Buffer.from("via exec"),
          modifiedAt: nowIso(),
        });
        return sseResponse([
          'data: {"type":"init","text":"cmd-456"}\n\n',
          'data: {"type":"stdout","text":"sandbox output"}\n\n',
          'data: {"type":"status","text":"0"}\n\n',
          'data: {"type":"execution_complete"}\n\n',
        ]);
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const sandbox = await resolveOpenSandboxContextForTest(workspaceDir);
    expect(sandbox?.backend).toBe("opensandbox");
    if (!sandbox) {
      throw new Error("Expected sandbox context.");
    }

    const bridge = createSandboxFsBridge({ sandbox });
    await bridge.writeFile({ filePath: "notes.txt", data: "hello opensandbox" });
    const stat = await bridge.stat({ filePath: "notes.txt" });
    const content = await bridge.readFile({ filePath: "notes.txt" });
    await bridge.rename({ from: "notes.txt", to: "nested/renamed.txt" });
    await bridge.remove({ filePath: "nested/renamed.txt", force: true });

    expect(stat?.type).toBe("file");
    expect(content.toString("utf8")).toBe("hello opensandbox");
    expect(remoteFs.has("/workspace/notes.txt")).toBe(false);
    expect(remoteFs.has("/workspace/nested/renamed.txt")).toBe(false);

    const { execResult } = await runOpenSandboxExecForTest({
      workspaceDir,
      command: "printf 'via exec' > generated.txt && echo sandbox output",
    });

    expect(execResult.status).toBe("completed");
    expect(execResult.exitCode).toBe(0);
    expect(execResult.aggregated).toContain("sandbox output");
    expect(await fs.readFile(path.join(sandbox.workspaceDir, "generated.txt"), "utf8")).toBe(
      "via exec",
    );
    expect(commandBodies).toHaveLength(2);
    expect(commandBodies[0]).toContain('"cwd":"/workspace"');
    expect(commandBodies[0]).toContain(`generated.txt`);
    expect(commandBodies[0]).toContain(`echo sandbox output`);
    expect(commandBodies[1]).toContain(`"command":"tar -cf - . | base64"`);
    expect(commandBodies[1]).toContain('"cwd":"/workspace"');
  });

  it("syncs workspace snapshots from the sandbox root even when exec runs in a subdirectory", async () => {
    const workspaceDir = await makeTempDir("openclaw-opensandbox-subdir-cwd-");
    const commandBodies: string[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://opensandbox.test/v1/sandboxes" && method === "POST") {
        return Response.json({ id: "sbx-subdir-cwd" });
      }
      if (
        url === "http://opensandbox.test/v1/sandboxes/sbx-subdir-cwd/endpoints/44772" &&
        method === "GET"
      ) {
        return Response.json({ endpoint: "opensandbox.test" });
      }
      if (url === "http://opensandbox.test/v1/sandboxes/sbx-subdir-cwd" && method === "GET") {
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
      if (url === "http://opensandbox.test/command" && method === "POST") {
        const body = (init?.body as string | undefined) ?? "";
        commandBodies.push(body);
        if (body.includes('"command":"tar -cf - . | base64"')) {
          return sseResponse([
            'data: {"type":"init","text":"cmd-sync"}\n\n',
            `data: ${JSON.stringify({
              type: "stdout",
              text: await buildRemoteFsTarBase64(
                new Map<string, RemoteEntry>([
                  ["/workspace", { type: "directory", modifiedAt: nowIso() }],
                ]),
              ),
            })}\n\n`,
            'data: {"type":"status","text":"0"}\n\n',
            'data: {"type":"execution_complete"}\n\n',
          ]);
        }
        return sseResponse([
          'data: {"type":"init","text":"cmd-subdir"}\n\n',
          'data: {"type":"status","text":"0"}\n\n',
          'data: {"type":"execution_complete"}\n\n',
        ]);
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { execResult } = await runOpenSandboxExecForTest({
      workspaceDir,
      command: "echo subdir",
      containerWorkdir: "/workspace/subdir",
    });

    expect(execResult.status).toBe("completed");
    expect(commandBodies).toHaveLength(2);
    expect(commandBodies[0]).toContain('"command":"echo subdir"');
    expect(commandBodies[0]).toContain('"cwd":"/workspace/subdir"');
    expect(commandBodies[1]).toContain('"command":"tar -cf - . | base64"');
    expect(commandBodies[1]).toContain('"cwd":"/workspace"');
  });

  it("keeps successful exec outcomes completed when the snapshot refresh fails", async () => {
    const workspaceDir = await makeTempDir("openclaw-opensandbox-sync-warning-");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://opensandbox.test/v1/sandboxes" && method === "POST") {
        return Response.json({ id: "sbx-sync-warning" });
      }
      if (
        url === "http://opensandbox.test/v1/sandboxes/sbx-sync-warning/endpoints/44772" &&
        method === "GET"
      ) {
        return Response.json({ endpoint: "opensandbox.test" });
      }
      if (url === "http://opensandbox.test/v1/sandboxes/sbx-sync-warning" && method === "GET") {
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
      if (url === "http://opensandbox.test/command" && method === "POST") {
        const body = (init?.body as string | undefined) ?? "";
        if (body.includes('"command":"tar -cf - . | base64"')) {
          return sseResponse([
            'data: {"type":"init","text":"cmd-sync"}\n\n',
            'data: {"type":"stderr","text":"tar: not found"}\n\n',
            'data: {"type":"status","text":"127"}\n\n',
            'data: {"type":"execution_complete"}\n\n',
          ]);
        }
        return sseResponse([
          'data: {"type":"init","text":"cmd-ok"}\n\n',
          'data: {"type":"stdout","text":"command ok"}\n\n',
          'data: {"type":"status","text":"0"}\n\n',
          'data: {"type":"execution_complete"}\n\n',
        ]);
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { execResult } = await runOpenSandboxExecForTest({
      workspaceDir,
      command: "echo command ok",
    });

    expect(execResult.status).toBe("completed");
    expect(execResult.exitCode).toBe(0);
    expect(execResult.aggregated).toContain("command ok");
    expect(execResult.aggregated).toContain("failed to refresh OpenSandbox workspace snapshot");
  });

  it("applies exec timeout to the snapshot refresh step", async () => {
    const workspaceDir = await makeTempDir("openclaw-opensandbox-sync-timeout-");

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "http://opensandbox.test/v1/sandboxes" && method === "POST") {
        return Response.json({ id: "sbx-sync-timeout" });
      }
      if (
        url === "http://opensandbox.test/v1/sandboxes/sbx-sync-timeout/endpoints/44772" &&
        method === "GET"
      ) {
        return Response.json({ endpoint: "opensandbox.test" });
      }
      if (url === "http://opensandbox.test/v1/sandboxes/sbx-sync-timeout" && method === "GET") {
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
      if (url === "http://opensandbox.test/command" && method === "POST") {
        const body = (init?.body as string | undefined) ?? "";
        if (body.includes('"command":"tar -cf - . | base64"')) {
          const signal = init?.signal;
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("snapshot aborted"));
              },
              { once: true },
            );
          });
        }
        return sseResponse([
          'data: {"type":"init","text":"cmd-ok"}\n\n',
          'data: {"type":"stdout","text":"command ok"}\n\n',
          'data: {"type":"status","text":"0"}\n\n',
          'data: {"type":"execution_complete"}\n\n',
        ]);
      }
      if (url.startsWith("http://opensandbox.test/command?") && method === "DELETE") {
        return new Response(null, { status: 200 });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { execResult } = await runOpenSandboxExecForTest({
      workspaceDir,
      command: "echo command ok",
      timeoutSec: 0.01,
    });

    expect(execResult.status).toBe("completed");
    expect(execResult.exitCode).toBe(0);
    expect(execResult.aggregated).toContain("command ok");
    expect(execResult.aggregated).toContain("failed to refresh OpenSandbox workspace snapshot");
  });
});
