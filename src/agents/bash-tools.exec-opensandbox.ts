import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ProcessSession } from "./bash-process-registry.js";
import { markExited } from "./bash-process-registry.js";
import type { ExecProcessHandle, ExecProcessOutcome } from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import {
  interruptOpenSandboxCommand,
  readOpenSandboxCommandStatus,
  runOpenSandboxCommand,
  syncOpenSandboxWorkspaceToLocalSnapshot,
} from "./sandbox/opensandbox.js";

const OPEN_SANDBOX_UNSUPPORTED_INPUT_REASON =
  "Interactive process input is unsupported for sandbox backend=opensandbox.";

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveOpenSandboxExitCode(params: {
  execdBaseUrl: string;
  commandId?: string;
  exitCode: number | null;
  apiKey?: string;
}) {
  if (typeof params.exitCode === "number" || !params.commandId) {
    return params.exitCode;
  }
  const status = await readOpenSandboxCommandStatus({
    execdBaseUrl: params.execdBaseUrl,
    commandId: params.commandId,
    apiKey: params.apiKey,
  });
  return typeof status.exit_code === "number" ? status.exit_code : null;
}

async function refreshOpenSandboxWorkspaceSnapshot(params: {
  execdBaseUrl: string;
  apiKey?: string;
  localWorkspaceDir: string;
  remoteWorkspaceDir: string;
  signal: AbortSignal;
  onStderr: (data: string) => void;
}) {
  try {
    await syncOpenSandboxWorkspaceToLocalSnapshot({
      execdBaseUrl: params.execdBaseUrl,
      apiKey: params.apiKey,
      localWorkspaceDir: params.localWorkspaceDir,
      remoteWorkspaceDir: params.remoteWorkspaceDir,
      signal: params.signal,
    });
  } catch (error) {
    params.onStderr(
      `\n[warn] failed to refresh OpenSandbox workspace snapshot: ${formatErrorMessage(error)}\n`,
    );
  }
}

export async function runOpenSandboxExecProcess(params: {
  startedAt: number;
  command: string;
  execCommand: string;
  timeoutMs?: number;
  containerWorkdir?: string | null;
  sandbox: BashSandboxConfig;
  usePty: boolean;
  session: ProcessSession;
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
  onUpdate?: (partialResult: AgentToolResult<ExecToolDetails>) => void;
  emitUpdate: () => void;
  maybeNotifyOnExit: (session: ProcessSession, status: "completed" | "failed") => void;
}): Promise<ExecProcessHandle> {
  if (params.usePty) {
    throw new Error("PTY is not supported for sandbox.backend=opensandbox.");
  }
  const execdBaseUrl = params.sandbox.opensandbox?.execdBaseUrl?.trim();
  if (!execdBaseUrl) {
    throw new Error("OpenSandbox execd base URL is unavailable.");
  }

  const commandAbortController = new AbortController();
  let commandId: string | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let abortReason: "manual" | "timeout" | undefined;
  const forwardAbort = (reason: "manual" | "timeout" = "manual") => {
    if (commandAbortController.signal.aborted) {
      return;
    }
    abortReason = reason;
    commandAbortController.abort();
    if (commandId) {
      void interruptOpenSandboxCommand({
        execdBaseUrl,
        commandId,
        apiKey: params.sandbox.opensandbox?.apiKey,
      });
    }
  };

  if (params.onUpdate) {
    params.emitUpdate();
  }

  const promise = (async (): Promise<ExecProcessOutcome> => {
    const started = Date.now();
    if (typeof params.timeoutMs === "number" && params.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        forwardAbort("timeout");
      }, params.timeoutMs);
    }
    try {
      const commandResult = await runOpenSandboxCommand({
        execdBaseUrl,
        apiKey: params.sandbox.opensandbox?.apiKey,
        command: params.execCommand,
        cwd: params.containerWorkdir ?? params.sandbox.containerWorkdir,
        background: false,
        signal: commandAbortController.signal,
        onInit: (id) => {
          commandId = id;
        },
        onStdout: params.onStdout,
        onStderr: params.onStderr,
      });
      const exitCode = await resolveOpenSandboxExitCode({
        execdBaseUrl,
        commandId: commandResult.commandId,
        exitCode: commandResult.exitCode,
        apiKey: params.sandbox.opensandbox?.apiKey,
      });
      const exitSignal: NodeJS.Signals | number | null = null;
      await refreshOpenSandboxWorkspaceSnapshot({
        execdBaseUrl,
        apiKey: params.sandbox.opensandbox?.apiKey,
        localWorkspaceDir: params.sandbox.workspaceDir,
        remoteWorkspaceDir: params.sandbox.containerWorkdir,
        signal: commandAbortController.signal,
        onStderr: params.onStderr,
      });
      const status: "completed" | "failed" =
        exitCode === 0 && !commandResult.error ? "completed" : "failed";
      markExited(params.session, exitCode ?? null, exitSignal, status);
      params.maybeNotifyOnExit(params.session, status);
      return {
        status,
        exitCode: exitCode ?? null,
        exitSignal,
        durationMs: Date.now() - started,
        aggregated: params.session.aggregated,
        timedOut: false,
        reason: commandResult.error,
      };
    } catch (error) {
      const timedOut = abortReason === "timeout";
      const reason = timedOut
        ? `Command timed out after ${params.timeoutMs}ms.`
        : formatErrorMessage(error);
      markExited(params.session, null, null, "failed");
      params.maybeNotifyOnExit(params.session, "failed");
      return {
        status: "failed",
        exitCode: null,
        exitSignal: null,
        durationMs: Date.now() - started,
        aggregated: params.session.aggregated,
        timedOut,
        reason,
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  })();

  params.session.onKill = () => {
    forwardAbort("manual");
  };
  params.session.unsupportedInputReason = OPEN_SANDBOX_UNSUPPORTED_INPUT_REASON;

  return {
    session: params.session,
    startedAt: params.startedAt,
    promise,
    kill: () => {
      forwardAbort("manual");
    },
  };
}
