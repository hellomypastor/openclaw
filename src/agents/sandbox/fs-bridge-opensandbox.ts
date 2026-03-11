import path from "node:path";
import type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./fs-bridge.js";
import {
  createOpenSandboxDirectories,
  deleteOpenSandboxDirectories,
  deleteOpenSandboxFiles,
  getOpenSandboxFileInfo,
  moveOpenSandboxFile,
  readOpenSandboxFile,
  writeOpenSandboxFile,
} from "./opensandbox.js";
import type { SandboxContext, SandboxWorkspaceAccess } from "./types.js";

export class OpenSandboxFsBridgeImpl implements SandboxFsBridge {
  constructor(private readonly sandbox: SandboxContext) {}

  private get execdRequestBase() {
    return {
      execdBaseUrl: this.requireExecdBaseUrl(),
      apiKey: this.sandbox.opensandbox?.apiKey,
    };
  }

  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath {
    const { containerPath, hostPath } = this.resolveSandboxPath(params);
    return {
      hostPath,
      relativePath: path.relative(this.sandbox.workspaceDir, hostPath),
      containerPath,
    };
  }

  async readFile(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<Buffer> {
    const target = this.resolveSandboxPath(params);
    return await readOpenSandboxFile({
      ...this.execdRequestBase,
      filePath: target.containerPath,
      signal: params.signal,
    });
  }

  async writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveSandboxPath(params);
    this.ensureWritable(target.containerPath, "write files");
    if (params.mkdir !== false) {
      await this.mkdirParent(target.containerPath, params.signal);
    }
    await writeOpenSandboxFile({
      ...this.execdRequestBase,
      filePath: target.containerPath,
      data: Buffer.isBuffer(params.data)
        ? params.data
        : Buffer.from(params.data, params.encoding ?? "utf8"),
      signal: params.signal,
    });
  }

  async mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void> {
    const target = this.resolveSandboxPath(params);
    this.ensureWritable(target.containerPath, "create directories");
    await createOpenSandboxDirectories({
      ...this.execdRequestBase,
      filePath: target.containerPath,
      signal: params.signal,
    });
  }

  async remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void> {
    const target = this.resolveSandboxPath(params);
    this.ensureWritable(target.containerPath, "remove files");
    const stat = await this.stat(params);
    if (!stat) {
      if (params.force) {
        return;
      }
      throw new Error(`No such file or directory: ${target.containerPath}`);
    }
    if (stat.type === "directory") {
      if (params.recursive !== true) {
        throw new Error(`Cannot remove directory without recursive=true: ${target.containerPath}`);
      }
      await deleteOpenSandboxDirectories({
        ...this.execdRequestBase,
        filePath: target.containerPath,
        signal: params.signal,
      });
      return;
    }
    await deleteOpenSandboxFiles({
      ...this.execdRequestBase,
      filePath: target.containerPath,
      signal: params.signal,
    });
  }

  async rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const from = this.resolveSandboxPath({ filePath: params.from, cwd: params.cwd });
    const to = this.resolveSandboxPath({ filePath: params.to, cwd: params.cwd });
    this.ensureWritable(from.containerPath, "rename files");
    this.ensureWritable(to.containerPath, "rename files");
    await this.mkdirParent(to.containerPath, params.signal);
    await moveOpenSandboxFile({
      ...this.execdRequestBase,
      from: from.containerPath,
      to: to.containerPath,
      signal: params.signal,
    });
  }

  async stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null> {
    const target = this.resolveSandboxPath(params);
    try {
      const info = await getOpenSandboxFileInfo({
        ...this.execdRequestBase,
        filePath: target.containerPath,
        signal: params.signal,
      });
      const entry = info[target.containerPath];
      if (!entry) {
        return null;
      }
      return {
        type: inferOpenSandboxStatType(target.containerPath, entry.mode),
        size: typeof entry.size === "number" ? entry.size : 0,
        mtimeMs: entry.modifiedAt ? Date.parse(entry.modifiedAt) || 0 : 0,
      };
    } catch (error) {
      if (error instanceof Error && /not found|no such/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  private resolveSandboxPath(params: { filePath: string; cwd?: string }) {
    const input = params.filePath.trim();
    const cwd = params.cwd?.trim() ? params.cwd : this.sandbox.workspaceDir;
    const posixInput = input.replace(/\\/g, "/");
    let hostPath: string;
    if (
      path.posix.isAbsolute(posixInput) &&
      (posixInput === this.sandbox.containerWorkdir ||
        posixInput.startsWith(`${this.sandbox.containerWorkdir}/`))
    ) {
      const relativeContainer = path.posix.relative(this.sandbox.containerWorkdir, posixInput);
      const relativeHost = relativeContainer
        ? relativeContainer.split(path.posix.sep).join(path.sep)
        : "";
      hostPath = relativeHost
        ? path.resolve(this.sandbox.workspaceDir, relativeHost)
        : path.resolve(this.sandbox.workspaceDir);
    } else {
      hostPath = path.resolve(cwd, input);
    }
    const relativePath = path.relative(this.sandbox.workspaceDir, hostPath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Sandbox path escapes workspace root: ${params.filePath}`);
    }
    const containerPath = relativePath
      ? path.posix.join(
          this.sandbox.containerWorkdir,
          relativePath.split(path.sep).join(path.posix.sep),
        )
      : this.sandbox.containerWorkdir;
    return {
      hostPath,
      containerPath,
    };
  }

  private requireExecdBaseUrl() {
    const baseUrl = this.sandbox.opensandbox?.execdBaseUrl?.trim();
    if (!baseUrl) {
      throw new Error("OpenSandbox execd base URL is unavailable.");
    }
    return baseUrl;
  }

  private ensureWritable(containerPath: string, action: string) {
    if (!allowsWrites(this.sandbox.workspaceAccess)) {
      throw new Error(`Sandbox path is read-only; cannot ${action}: ${containerPath}`);
    }
  }

  private async mkdirParent(containerPath: string, signal?: AbortSignal) {
    const parent = path.posix.dirname(containerPath);
    if (!parent || parent === "." || parent === "/") {
      return;
    }
    await createOpenSandboxDirectories({
      ...this.execdRequestBase,
      filePath: parent,
      signal,
    });
  }
}

function allowsWrites(access: SandboxWorkspaceAccess): boolean {
  return access !== "ro";
}

function inferOpenSandboxStatType(
  containerPath: string,
  mode?: number,
): "file" | "directory" | "other" {
  if (containerPath.endsWith("/")) {
    return "directory";
  }
  if (typeof mode === "number") {
    const fileTypeMask = mode & 0o170000;
    if (fileTypeMask === 0o040000) {
      return "directory";
    }
    if (fileTypeMask === 0o100000) {
      return "file";
    }
  }
  return "file";
}
