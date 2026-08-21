import {
  type AgentSettledEvent,
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
import type { createBashTool } from "../background-processes/tools/bash";

const managers: ProcessManager[] = [];

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(async (manager) => {
    await manager.shutdown();
  }));
});

describe("session-scoped ProcessManager lifecycle", () => {
  it("installs the replacement manager even when old-manager shutdown rejects", async () => {
    type BashTool = ReturnType<typeof createBashTool>;
    type SessionHandler = (
      event: SessionStartEvent | SessionShutdownEvent | AgentSettledEvent,
      ctx: ExtensionContext,
    ) => void | Promise<void>;

    let bash: BashTool | undefined;
    const registeredTools: string[] = [];
    const handlers = new Map<string, SessionHandler[]>();
    const pi = {
      registerTool(tool: BashTool) {
        registeredTools.push(tool.name);
        if (tool.name === "bash") bash = tool;
      },
      registerMessageRenderer() {},
      sendMessage() {},
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
      isIdle: () => true,
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
    expect(registeredTools).toEqual([
      "bash",
      "process_read",
      "process_write",
      "process_kill",
      "process_list",
    ]);

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

  it("reports scheduler callback failures visibly and releases them on agent_settled", async () => {
    type Handler = (
      event: SessionStartEvent | SessionShutdownEvent | AgentSettledEvent,
      ctx: ExtensionContext,
    ) => void | Promise<void>;

    const handlers = new Map<string, Handler[]>();
    const messages: unknown[] = [];
    const notices: Array<{ message: string; level: string }> = [];
    const pi = {
      registerTool() {},
      registerMessageRenderer() {},
      sendMessage(message: unknown) {
        messages.push(message);
      },
      on(event: string, handler: Handler) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
    } as unknown as ExtensionAPI;
    createBackgroundProcessesExtension({
      createManager(options) {
        const manager = new ProcessManager({ ...options, pipeIdleMs: 30 });
        managers.push(manager);
        return manager;
      },
    })(pi);

    const ctx = {
      cwd: process.cwd(),
      isIdle: () => {
        throw new Error("stale notification context");
      },
      ui: {
        notify(message: string, level: string) {
          notices.push({ message, level });
        },
      },
      sessionManager: {
        getSessionId: () => "notification-error-test",
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;
    const start = handlers.get("session_start")?.[0];
    const settled = handlers.get("agent_settled")?.[0];
    const shutdown = handlers.get("session_shutdown")?.[0];
    if (start === undefined || settled === undefined || shutdown === undefined) {
      throw new Error("Notification lifecycle handlers were not registered");
    }

    await start({ type: "session_start", reason: "startup" }, ctx);
    const manager = managers.at(-1);
    if (manager === undefined) throw new Error("Manager was not created");
    const record = await manager.startManaged("printf callback-error");
    await record.completion;
    await waitUntil(() => notices.length === 1);

    expect(notices).toEqual([{
      message:
        "Background process notification error: stale notification context",
      level: "error",
    }]);
    expect(messages).toEqual([]);

    await settled({ type: "agent_settled" }, ctx);
    expect(messages).toHaveLength(1);
    await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  });
});
