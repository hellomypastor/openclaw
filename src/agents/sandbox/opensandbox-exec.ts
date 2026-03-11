import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import {
  buildOpenSandboxHeaders,
  fetchOpenSandbox,
  fetchOpenSandboxJson,
} from "./opensandbox-client.js";

export type OpenSandboxCommandResult = {
  commandId?: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
};

export async function readOpenSandboxCommandStatus(params: {
  execdBaseUrl: string;
  commandId: string;
  apiKey?: string;
}) {
  return await fetchOpenSandboxJson<{
    running?: boolean;
    exit_code?: number | null;
    error?: string;
    started_at?: string;
    finished_at?: string | null;
  }>(`${params.execdBaseUrl}/command/status/${encodeURIComponent(params.commandId)}`, {
    method: "GET",
    headers: buildOpenSandboxHeaders(params.apiKey),
  });
}

function findSseFrameBoundary(buffer: string) {
  const unixBoundary = buffer.indexOf("\n\n");
  const windowsBoundary = buffer.indexOf("\r\n\r\n");
  if (unixBoundary === -1) {
    return windowsBoundary;
  }
  if (windowsBoundary === -1) {
    return unixBoundary;
  }
  return Math.min(unixBoundary, windowsBoundary);
}

function parseSseEvent(frame: string): Record<string, unknown> | null {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) {
    return null;
  }
  try {
    return JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function consumeSseBuffer(
  buffer: string,
  onEvent: (event: Record<string, unknown>) => void,
): string {
  let remainder = buffer;
  while (true) {
    const boundary = findSseFrameBoundary(remainder);
    if (boundary === -1) {
      return remainder;
    }
    const frame = remainder.slice(0, boundary);
    const separatorLength = remainder.startsWith("\r\n\r\n", boundary) ? 4 : 2;
    remainder = remainder.slice(boundary + separatorLength);
    const event = parseSseEvent(frame);
    if (event) {
      onEvent(event);
    }
  }
}

function applyCommandEvent(params: {
  event: Record<string, unknown>;
  result: OpenSandboxCommandResult;
  captureOutput: boolean;
  onInit?: (commandId: string) => void;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}) {
  const type = typeof params.event.type === "string" ? params.event.type : "";
  const text = typeof params.event.text === "string" ? params.event.text : "";
  if (type === "init" && text) {
    params.result.commandId = text;
    params.onInit?.(text);
    return;
  }
  if (type === "stdout") {
    if (params.captureOutput) {
      params.result.stdout += text;
    }
    params.onStdout?.(text);
    return;
  }
  if (type === "stderr") {
    if (params.captureOutput) {
      params.result.stderr += text;
    }
    params.onStderr?.(text);
    return;
  }
  if (type === "error") {
    params.result.error = text || params.result.error || "OpenSandbox command failed.";
    return;
  }
  if (type === "status" && text) {
    const maybeCode = Number.parseInt(text, 10);
    if (Number.isFinite(maybeCode)) {
      params.result.exitCode = maybeCode;
    }
  }
}

export async function runOpenSandboxCommand(params: {
  execdBaseUrl: string;
  apiKey?: string;
  command: string;
  cwd?: string;
  background?: boolean;
  captureOutput?: boolean;
  signal?: AbortSignal;
  onInit?: (commandId: string) => void;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}) {
  const response = await fetchOpenSandbox(`${params.execdBaseUrl}/command`, {
    method: "POST",
    headers: buildOpenSandboxHeaders(params.apiKey, {
      "content-type": "application/json",
      accept: "text/event-stream",
    }),
    body: JSON.stringify({
      command: params.command,
      cwd: params.cwd,
      background: params.background === true,
    }),
    signal: params.signal,
  });
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("OpenSandbox command stream body is unavailable.");
  }
  const decoder = new TextDecoder();
  let buffered = "";
  const captureOutput = params.captureOutput === true;
  const result: OpenSandboxCommandResult = {
    stdout: "",
    stderr: "",
    exitCode: null,
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffered += decoder.decode(value, { stream: true });
    buffered = consumeSseBuffer(buffered, (event) => {
      applyCommandEvent({
        event,
        result,
        captureOutput,
        onInit: params.onInit,
        onStdout: params.onStdout,
        onStderr: params.onStderr,
      });
    });
  }
  if (buffered.trim()) {
    const trailingEvent = parseSseEvent(buffered);
    if (trailingEvent) {
      applyCommandEvent({
        event: trailingEvent,
        result,
        captureOutput,
        onInit: params.onInit,
        onStdout: params.onStdout,
        onStderr: params.onStderr,
      });
    }
  }
  if (params.background && !result.commandId) {
    throw new Error("OpenSandbox background command did not return a command id.");
  }
  return result;
}

export async function syncOpenSandboxWorkspaceToLocalSnapshot(params: {
  execdBaseUrl: string;
  apiKey?: string;
  localWorkspaceDir: string;
  remoteWorkspaceDir: string;
  signal?: AbortSignal;
}) {
  const tarResult = await runOpenSandboxCommand({
    execdBaseUrl: params.execdBaseUrl,
    apiKey: params.apiKey,
    cwd: params.remoteWorkspaceDir,
    command: "tar -cf - . | base64",
    captureOutput: true,
    signal: params.signal,
  });
  if (tarResult.exitCode !== 0) {
    throw new Error(
      tarResult.error ||
        `OpenSandbox workspace snapshot command failed (${tarResult.exitCode ?? "unknown"}).`,
    );
  }
  const tarBase64 = tarResult.stdout.replaceAll(/\s+/g, "");
  const tarBuffer = Buffer.from(tarBase64, "base64");
  const localParentDir = path.dirname(params.localWorkspaceDir);
  const tempDir = await fs.mkdtemp(path.join(localParentDir, ".opensandbox-sync-"));
  const tarPath = path.join(tempDir, "workspace.tar");

  try {
    await fs.writeFile(tarPath, tarBuffer);
    await tar.x({
      file: tarPath,
      cwd: tempDir,
      strict: true,
    });
    await fs.rm(tarPath, { force: true });
    await fs.rm(params.localWorkspaceDir, { recursive: true, force: true });
    await fs.rename(tempDir, params.localWorkspaceDir);
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function readOpenSandboxCommandLogs(params: {
  execdBaseUrl: string;
  commandId: string;
  apiKey?: string;
  cursor?: number;
}) {
  const url = new URL(
    `${params.execdBaseUrl}/command/${encodeURIComponent(params.commandId)}/logs`,
  );
  if (typeof params.cursor === "number") {
    url.searchParams.set("cursor", String(params.cursor));
  }
  const response = await fetch(url, {
    method: "GET",
    headers: buildOpenSandboxHeaders(params.apiKey),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body.trim() || `OpenSandbox logs request failed (${response.status}).`);
  }
  return {
    body: await response.text(),
    cursorHeader: response.headers.get("EXECD-COMMANDS-TAIL-CURSOR") ?? undefined,
  };
}

export async function interruptOpenSandboxCommand(params: {
  execdBaseUrl: string;
  commandId: string;
  apiKey?: string;
}) {
  const url = new URL(`${params.execdBaseUrl}/command`);
  url.searchParams.set("id", params.commandId);
  const response = await fetch(url, {
    method: "DELETE",
    headers: buildOpenSandboxHeaders(params.apiKey),
  });
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(body.trim() || `OpenSandbox interrupt failed (${response.status}).`);
  }
}
