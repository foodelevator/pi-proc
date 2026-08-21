import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionShutdownEvent,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBackgroundProcessesExtension,
} from "../background-processes/index";
import { ProcessManager } from "../background-processes/process-manager";
import type { createWaitBashTool } from "../background-processes/tools/bash";

const managers: ProcessManager[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(async (manager) => {
    await manager.shutdown();
  }));
});

describe("session-scoped ProcessManager lifecycle", () => {
  it("installs the replacement manager even when old-manager shutdown rejects", async () => {
    type BashTool = ReturnType<typeof createWaitBashTool>;
    type SessionHandler = (
      event: SessionStartEvent | SessionShutdownEvent,
      ctx: ExtensionContext,
    ) => void | Promise<void>;

    let bash: BashTool | undefined;
    const handlers = new Map<string, SessionHandler[]>();
    const pi = {
      registerTool(tool: BashTool) {
        bash = tool;
      },
      on(event: string, handler: SessionHandler) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
    } as unknown as ExtensionAPI;
    const extension = createBackgroundProcessesExtension({
      createManager(options) {
        const manager = new ProcessManager({ ...options, pipeIdleMs: 30 });
        managers.push(manager);
        return manager;
      },
    });
    extension(pi);

    const ctx = {
      cwd: process.cwd(),
      sessionManager: {
        getSessionId: () => "lifecycle-test",
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;
    const start = handlers.get("session_start")?.[0];
    const shutdown = handlers.get("session_shutdown")?.[0];
    if (start === undefined || shutdown === undefined || bash === undefined) {
      throw new Error("Extension lifecycle registration is incomplete");
    }

    await start({ type: "session_start", reason: "startup" }, ctx);
    const oldManager = managers[0];
    if (oldManager === undefined) throw new Error("Manager was not created");
    const shutdownSpy = vi.spyOn(oldManager, "shutdown")
      .mockRejectedValueOnce(new Error("simulated close failure"));

    await expect(
      start({ type: "session_start", reason: "reload" }, ctx),
    ).rejects.toThrow("simulated close failure");
    expect(managers).toHaveLength(2);

    const result = await bash.execute(
      "after-failed-shutdown",
      { command: "printf still-works" },
      undefined,
      undefined,
      ctx,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "still-works" }],
      details: undefined,
    });

    shutdownSpy.mockRestore();
    await oldManager.shutdown();
    await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  });
});
