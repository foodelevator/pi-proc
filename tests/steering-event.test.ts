import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBackgroundProcessesExtension,
} from "../background-processes/index";
import { ProcessManager } from "../background-processes/process-manager";

type InputHandler = (
  event: InputEvent,
  ctx: ExtensionContext,
) => InputEventResult | void | Promise<InputEventResult | void>;
type StartHandler = (
  event: SessionStartEvent,
  ctx: ExtensionContext,
) => void | Promise<void>;
type ShutdownHandler = (
  event: SessionShutdownEvent,
  ctx: ExtensionContext,
) => void | Promise<void>;

const managers: ProcessManager[] = [];

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(async (manager) => {
    await manager.shutdown();
  }));
});

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

function inputEvent(
  source: InputEvent["source"],
  streamingBehavior: InputEvent["streamingBehavior"],
): InputEvent {
  return {
    type: "input",
    text: "steering test",
    source,
    ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
  };
}

describe("steering input event", () => {
  it("detaches every wait for interactive/RPC steer and ignores extension/follow-up", async () => {
    let input: InputHandler | undefined;
    let start: StartHandler | undefined;
    let shutdown: ShutdownHandler | undefined;
    const pi = {
      registerTool() {},
      on(event: string, handler: unknown) {
        if (event === "input") input = handler as InputHandler;
        if (event === "session_start") start = handler as StartHandler;
        if (event === "session_shutdown") shutdown = handler as ShutdownHandler;
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
      mode: "tui",
      sessionManager: {
        getSessionId: () => "steering-event-test",
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;
    if (input === undefined || start === undefined || shutdown === undefined) {
      throw new Error("Extension event handlers were not registered");
    }

    await start({ type: "session_start", reason: "startup" }, ctx);
    const manager = managers[0];
    if (manager === undefined) throw new Error("Manager was not created");

    const first = await manager.startForeground("printf first; read value");
    const second = await manager.startForeground("printf second; read value");
    await waitUntil(() =>
      first.outputStore.totalBytes === 5 && second.outputStore.totalBytes === 6
    );

    expect(await input(inputEvent("extension", "steer"), ctx)).toEqual({
      action: "continue",
    });
    expect(await input(inputEvent("interactive", "followUp"), ctx)).toEqual({
      action: "continue",
    });
    expect(manager.foregroundExecutions).toEqual([first, second]);
    expect(manager.records).toEqual([]);

    expect(await input(inputEvent("interactive", "steer"), ctx)).toEqual({
      action: "continue",
    });
    expect(manager.foregroundExecutions).toEqual([]);
    expect(manager.records.map((record) => record.id)).toEqual(["p1", "p2"]);
    expect((await first.waitOutcome).type).toBe("detached");
    expect((await second.waitOutcome).type).toBe("detached");

    const third = await manager.startForeground("printf third; read value");
    await waitUntil(() => third.outputStore.totalBytes === 5);
    await input(inputEvent("rpc", "steer"), ctx);
    expect((await third.waitOutcome).type).toBe("detached");
    expect(manager.records.map((record) => record.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);

    await Promise.all(manager.activeRecords.map(async (record) => {
      await manager.signalProcessAndWait(record.id, "SIGKILL");
    }));
    await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
  });
});
