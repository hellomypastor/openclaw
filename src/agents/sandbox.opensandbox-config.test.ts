import { describe, expect, it } from "vitest";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";

describe("resolveSandboxConfigForAgent (opensandbox)", () => {
  it("resolves opensandbox backend defaults", () => {
    const sandbox = resolveSandboxConfigForAgent({
      agents: {
        defaults: {
          sandbox: {
            backend: "opensandbox",
            mode: "all",
            opensandbox: {
              endpoint: "http://127.0.0.1:18080",
              image: "opensandbox/custom-image:latest",
            },
          },
        },
      },
    });

    expect(sandbox.backend).toBe("opensandbox");
    expect(sandbox.opensandbox.endpoint).toBe("http://127.0.0.1:18080");
    expect(sandbox.opensandbox.image).toBe("opensandbox/custom-image:latest");
    expect(sandbox.workspaceAccess).toBe("none");
  });

  it("rejects workspaceAccess other than none", () => {
    expect(() =>
      resolveSandboxConfigForAgent({
        agents: {
          defaults: {
            sandbox: {
              backend: "opensandbox",
              workspaceAccess: "rw",
            },
          },
        },
      }),
    ).toThrow(/workspaceAccess=none/);
  });

  it("rejects browser sandboxing on opensandbox backend", () => {
    expect(() =>
      resolveSandboxConfigForAgent({
        agents: {
          defaults: {
            sandbox: {
              backend: "opensandbox",
              browser: {
                enabled: true,
              },
            },
          },
        },
      }),
    ).toThrow(/browser\.enabled/);
  });
});
