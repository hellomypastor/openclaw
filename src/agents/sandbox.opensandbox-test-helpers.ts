import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveSandboxContext } from "./sandbox/context.js";

const tempDirs: string[] = [];

export async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs() {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

export function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  );
}

export function buildOpenSandboxTestConfig(endpoint = "http://opensandbox.test") {
  return {
    agents: {
      defaults: {
        sandbox: {
          backend: "opensandbox" as const,
          mode: "all" as const,
          opensandbox: {
            endpoint,
          },
        },
      },
      list: [{ id: "main" }],
    },
  };
}

export async function resolveOpenSandboxContextForTest(workspaceDir: string) {
  return await resolveSandboxContext({
    config: buildOpenSandboxTestConfig(),
    sessionKey: "agent:main:task",
    workspaceDir,
  });
}
