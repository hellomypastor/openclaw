import { afterEach, describe, expect, it, vi } from "vitest";
import { addSession, getSession, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";

describe("process tool opensandbox sessions", () => {
  afterEach(() => {
    resetProcessRegistryForTests();
  });

  it("returns a clear error for unsupported interactive input", async () => {
    addSession(
      createProcessSessionFixture({
        id: "sbx-proc",
        command: "python app.py",
        backgrounded: true,
        unsupportedInputReason:
          "Interactive process input is unsupported for sandbox backend=opensandbox.",
      }),
    );
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "write",
      sessionId: "sbx-proc",
      data: "hello",
    });

    expect(result.details).toMatchObject({ status: "failed" });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Interactive process input is unsupported for sandbox backend=opensandbox.",
    });
  });

  it("routes kill through the sandbox kill handler", async () => {
    const onKill = vi.fn(async () => undefined);
    addSession(
      createProcessSessionFixture({
        id: "sbx-kill",
        command: "sleep 999",
        backgrounded: true,
        onKill,
        unsupportedInputReason:
          "Interactive process input is unsupported for sandbox backend=opensandbox.",
      }),
    );
    const processTool = createProcessTool();

    const result = await processTool.execute("toolcall", {
      action: "kill",
      sessionId: "sbx-kill",
    });

    expect(onKill).toHaveBeenCalledTimes(1);
    expect(getSession("sbx-kill")).toBeDefined();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Termination requested for session sbx-kill.",
    });
  });
});
