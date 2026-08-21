import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { OutputStore } from "../background-processes/output-store";
import { PROCESS_RUNTIME_END_ENTRY_TYPE } from "../background-processes/persistence";
import { ProcessManager } from "../background-processes/process-manager";
import type { createBashTool } from "../background-processes/tools/bash";

const managers: ProcessManager[] = [];
const temporaryDirectories: string[] = [];

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
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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

  it("persists before TERM, waits 500ms before KILL, retains spills, and reloads tombstones", async () => {
    type Handler = (event: never, ctx: ExtensionContext) => void | Promise<void>;
    type RuntimeTool = {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: ExtensionContext,
      ) => Promise<{ content: unknown[]; details?: unknown }>;
    };

    const directory = mkdtempSync(join(tmpdir(), "pibg-lifecycle-persist-"));
    temporaryDirectories.push(directory);
    const spillPath = join(directory, "retained.log");
    const entries: unknown[] = [];
    const handlers = new Map<string, Handler[]>();
    const tools = new Map<string, RuntimeTool>();
    const notifications: unknown[] = [];
    let appendAt = 0;
    const pi = {
      registerTool(tool: RuntimeTool & { name: string }) {
        tools.set(tool.name, tool);
      },
      registerMessageRenderer() {},
      sendMessage(message: unknown) {
        notifications.push(message);
      },
      appendEntry(customType: string, data: unknown) {
        appendAt = Date.now();
        entries.push({ type: "custom", customType, data });
      },
      on(event: string, handler: Handler) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
    } as unknown as ExtensionAPI;
    createBackgroundProcessesExtension({
      createManager(options) {
        const manager = new ProcessManager({
          ...options,
          pipeIdleMs: 30,
          outputStoreFactory: () => new OutputStore({
            maxInMemoryBytes: 4,
            maxInMemoryLines: 100,
            createSpillPath: () => spillPath,
          }),
        });
        managers.push(manager);
        return manager;
      },
    })(pi);

    const ctx = {
      cwd: process.cwd(),
      mode: "rpc",
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "persistence-lifecycle",
        getSessionFile: () => "/tmp/persistence-lifecycle.jsonl",
        getEntries: () => entries,
      },
      ui: { notify() {} },
    } as unknown as ExtensionContext;
    const start = handlers.get("session_start")?.[0];
    const shutdown = handlers.get("session_shutdown")?.[0];
    const bash = tools.get("bash");
    const read = tools.get("process_read");
    const write = tools.get("process_write");
    const kill = tools.get("process_kill");
    const list = tools.get("process_list");
    if (
      start === undefined
      || shutdown === undefined
      || bash === undefined
      || read === undefined
      || write === undefined
      || kill === undefined
      || list === undefined
    ) throw new Error("Lifecycle test harness was not initialized");

    await start({ type: "session_start", reason: "startup" } as never, ctx);
    const firstManager = managers.at(-1);
    if (firstManager === undefined) throw new Error("Manager was not created");
    const stubbornCommand =
      "trap '' TERM; printf output-large-enough-to-spill; while :; do sleep 1; done";
    const started = await bash.execute(
      "start-stubborn",
      {
        command: stubbornCommand,
        mode: "monitor",
      },
      undefined,
      undefined,
      ctx,
    );
    expect(started.details).toMatchObject({ process: { id: "p1" } });
    const record = firstManager.getProcess("p1");
    await waitUntil(() => record.outputStore.totalBytes > 4);
    expect(existsSync(spillPath)).toBe(true);

    // Leave a pending 200ms monitor batch. Shutdown must discard it before TERM.
    const signalTimes: Array<{ signal: string | number | undefined; at: number }> = [];
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -record.pid) signalTimes.push({ signal, at: Date.now() });
      return realKill(pid, signal);
    });
    const shutdownStartedAt = Date.now();
    try {
      await shutdown({ type: "session_shutdown", reason: "reload" } as never, ctx);
    } finally {
      killSpy.mockRestore();
    }

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "custom",
      customType: PROCESS_RUNTIME_END_ENTRY_TYPE,
      data: {
        reason: "reload",
        processes: [{
          id: "p1",
          command: stubbornCommand,
          mode: "monitor",
          state: "running",
          output: { spilled: true, spillPath },
        }],
      },
    });
    expect(signalTimes.map(({ signal }) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(appendAt).toBeLessThanOrEqual(signalTimes[0]?.at ?? 0);
    expect((signalTimes[1]?.at ?? 0) - (signalTimes[0]?.at ?? 0)).toBeGreaterThanOrEqual(475);
    expect(Date.now() - shutdownStartedAt).toBeGreaterThanOrEqual(475);
    expect(existsSync(spillPath)).toBe(true);
    expect(record.outputStore.readRange(0).content).toContain(
      "output-large-enough-to-spill",
    );
    expect(() => record.outputStore.append("late")).toThrow("closed output store");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(notifications).toEqual([]);

    await start({ type: "session_start", reason: "reload" } as never, ctx);
    await expect(read.execute("historical-read", { id: "p1" }, undefined, undefined, ctx))
      .rejects.toThrow("terminated during reload");
    await expect(write.execute("historical-write", { id: "p1", data: "x" }, undefined, undefined, ctx))
      .rejects.toThrow("terminated during reload");
    await expect(kill.execute("historical-kill", { id: "p1" }, undefined, undefined, ctx))
      .rejects.toThrow("terminated during reload");
    const activeOnly = await list.execute("active-only", {}, undefined, undefined, ctx);
    expect(activeOnly.details).toMatchObject({ processes: [] });
    const historical = await list.execute(
      "historical-list",
      { include_completed: true },
      undefined,
      undefined,
      ctx,
    );
    expect(historical.details).toMatchObject({
      processes: [{
        id: "p1",
        state: "historical",
        priorState: "running",
        shutdownReason: "reload",
        output: { spillPath },
      }],
    });

    const next = await bash.execute(
      "monotonic-id",
      { command: "true", mode: "background" },
      undefined,
      undefined,
      ctx,
    );
    expect(next.details).toMatchObject({ process: { id: "p2" } });
    await shutdown({ type: "session_shutdown", reason: "quit" } as never, ctx);
  });

  it("does not append an empty runtime-ending entry", async () => {
    type Handler = (event: never, ctx: ExtensionContext) => void | Promise<void>;
    const handlers = new Map<string, Handler[]>();
    const appended: unknown[] = [];
    const pi = {
      registerTool() {},
      registerMessageRenderer() {},
      sendMessage() {},
      appendEntry(customType: string, data: unknown) {
        appended.push({ customType, data });
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
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "empty-runtime",
        getSessionFile: () => undefined,
        getEntries: () => [],
      },
    } as unknown as ExtensionContext;
    const start = handlers.get("session_start")?.[0];
    const shutdown = handlers.get("session_shutdown")?.[0];
    if (start === undefined || shutdown === undefined) throw new Error("Missing lifecycle handlers");

    await start({ type: "session_start", reason: "startup" } as never, ctx);
    await shutdown({ type: "session_shutdown", reason: "quit" } as never, ctx);

    expect(appended).toEqual([]);
  });

  it("does nothing to active processes on tree navigation", async () => {
    type Handler = (event: never, ctx: ExtensionContext) => void | Promise<void>;
    const handlers = new Map<string, Handler[]>();
    const pi = {
      registerTool() {},
      registerMessageRenderer() {},
      sendMessage() {},
      appendEntry() {},
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
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => "tree-no-op",
        getSessionFile: () => undefined,
        getEntries: () => [],
      },
    } as unknown as ExtensionContext;
    const start = handlers.get("session_start")?.[0];
    const shutdown = handlers.get("session_shutdown")?.[0];
    if (start === undefined || shutdown === undefined) throw new Error("Missing lifecycle handlers");
    await start({ type: "session_start", reason: "startup" } as never, ctx);
    const manager = managers.at(-1);
    if (manager === undefined) throw new Error("Manager missing");
    const record = await manager.startManaged("printf ready; sleep 30");
    await waitUntil(() => record.outputStore.totalBytes === 5);

    expect(handlers.has("session_tree")).toBe(false);
    expect(record.completedAt).toBeUndefined();
    expect(manager.getProcess(record.id)).toBe(record);

    await shutdown({ type: "session_shutdown", reason: "quit" } as never, ctx);
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
