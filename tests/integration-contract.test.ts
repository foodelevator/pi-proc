import { rmSync } from "node:fs";

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createBackgroundProcessesExtension } from "../background-processes/index";
import type {
  ProcessNotificationMessage,
} from "../background-processes/notification-scheduler";
import { ProcessManager } from "../background-processes/process-manager";

interface RuntimeTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<unknown>) => void,
    ctx?: ExtensionContext,
  ) => Promise<AgentToolResult<Record<string, unknown>>>;
}

type RuntimeHandler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

interface IntegrationHarness {
  ctx: ExtensionContext;
  entries: unknown[];
  handlers: Map<string, RuntimeHandler[]>;
  managers: ProcessManager[];
  messages: Array<{
    message: ProcessNotificationMessage;
    delivery: unknown;
  }>;
  tools: Map<string, RuntimeTool>;
  emit(name: string, event: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<void>;
  start(): Promise<void>;
}

const harnesses: IntegrationHarness[] = [];

function createHarness(): IntegrationHarness {
  const entries: unknown[] = [];
  const handlers = new Map<string, RuntimeHandler[]>();
  const managers: ProcessManager[] = [];
  const messages: IntegrationHarness["messages"] = [];
  const tools = new Map<string, RuntimeTool>();
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    on(event: string, handler: RuntimeHandler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerMessageRenderer() {},
    registerTool(tool: RuntimeTool) {
      tools.set(tool.name, tool);
    },
    sendMessage(message: ProcessNotificationMessage, delivery: unknown) {
      messages.push({ message, delivery });
    },
  } as unknown as ExtensionAPI;
  createBackgroundProcessesExtension({
    createManager(options) {
      const manager = new ProcessManager({
        ...options,
        pipeIdleMs: 30,
        terminatingSignalWaitMs: 60,
        shutdownGraceMs: 30,
        shutdownForceWaitMs: 500,
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
      getEntries: () => entries,
      getSessionFile: () => undefined,
      getSessionId: () => "integration-contract",
    },
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  let started = false;
  const emit = async (name: string, event: Record<string, unknown>) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  const harness: IntegrationHarness = {
    ctx,
    entries,
    handlers,
    managers,
    messages,
    tools,
    emit,
    async start() {
      await emit("session_start", {
        type: "session_start",
        reason: "startup",
      });
      started = true;
    },
    async shutdown() {
      if (!started) return;
      started = false;
      await emit("session_shutdown", {
        type: "session_shutdown",
        reason: "quit",
      });
    },
  };
  harnesses.push(harness);
  return harness;
}

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

function requireTool(harness: IntegrationHarness, name: string): RuntimeTool {
  const tool = harness.tools.get(name);
  if (tool === undefined) throw new Error(`Missing integration tool ${name}`);
  return tool;
}

function text(result: AgentToolResult<unknown>): string {
  return result.content.flatMap((item) => item.type === "text" ? [item.text] : [])
    .join("\n");
}

afterEach(async () => {
  await Promise.allSettled(harnesses.splice(0).map(async (harness) => {
    const spillPaths = harness.managers.flatMap((manager) =>
      manager.records.flatMap((record) =>
        record.outputStore.spillPath === undefined
          ? []
          : [record.outputStore.spillPath]
      )
    );
    await harness.shutdown();
    await Promise.allSettled(harness.managers.map(async (manager) => {
      await manager.shutdown();
    }));
    for (const spillPath of spillPaths) rmSync(spillPath, { force: true });
  }));
});

describe("cross-component managed-process contracts", () => {
  it("detaches a wait whose command starts after steering, without leaking into the next turn", async () => {
    const harness = createHarness();
    await harness.start();
    const bash = requireTool(harness, "bash");

    await harness.emit("turn_start", {
      type: "turn_start",
      turnIndex: 0,
      timestamp: Date.now(),
    });
    await harness.emit("input", {
      type: "input",
      text: "stop waiting",
      source: "rpc",
      streamingBehavior: "steer",
    });
    await harness.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "pending-bash",
      toolName: "bash",
      args: { command: "printf pending; read value" },
    });

    const detached = await bash.execute(
      "pending-bash",
      { command: "printf pending; read value" },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(detached.details).toMatchObject({
      process: {
        id: "p1",
        mode: "background",
        reason: "detached_by_steering",
      },
    });
    expect(harness.managers[0]?.foregroundExecutions).toEqual([]);

    await harness.emit("tool_execution_end", {
      type: "tool_execution_end",
      toolCallId: "pending-bash",
      toolName: "bash",
      result: detached,
      isError: false,
    });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      timestamp: Date.now(),
      message: {},
      toolResults: [],
    });

    await harness.emit("turn_start", {
      type: "turn_start",
      turnIndex: 1,
      timestamp: Date.now(),
    });
    await harness.emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "next-bash",
      toolName: "bash",
      args: { command: "printf next; read value" },
    });
    const nextWait = bash.execute(
      "next-bash",
      { command: "printf next; read value" },
      undefined,
      undefined,
      harness.ctx,
    );
    await waitUntil(() =>
      harness.managers[0]?.foregroundExecutions[0]?.outputStore
        .readRange(0).content === "next"
    );
    expect(harness.managers[0]?.records.map((record) => record.id)).toEqual([
      "p1",
    ]);

    await harness.emit("input", {
      type: "input",
      text: "detach the active wait",
      source: "rpc",
      streamingBehavior: "steer",
    });
    const nextDetached = await nextWait;
    expect(nextDetached.details).toMatchObject({
      process: {
        id: "p2",
        reason: "detached_by_steering",
      },
    });

    await Promise.all(harness.managers[0]?.activeRecords.map(async (record) => {
      await harness.managers[0]?.signalProcessAndWait(record.id, "SIGKILL");
    }) ?? []);
  });

  it("steers every wait, writes manual newlines and EOF, then supports implicit and recovery reads", async () => {
    const harness = createHarness();
    await harness.start();
    const bash = requireTool(harness, "bash");
    const processRead = requireTool(harness, "process_read");
    const processWrite = requireTool(harness, "process_write");
    const updates: string[][] = [[], []];
    const commands = [
      "printf first-prefix; IFS= read -r line; printf 'first-suffix:%s' \"$line\"",
      "printf second-prefix; IFS= read -r line; printf 'second-suffix:%s' \"$line\"",
    ];
    const waits = [];
    for (const [index, command] of commands.entries()) {
      waits.push(bash.execute(
        `wait-${index}`,
        { command },
        undefined,
        (update) => updates[index]?.push(text(update)),
        harness.ctx,
      ));
      const prefix = index === 0 ? "first-prefix" : "second-prefix";
      await waitUntil(() =>
        updates[index]?.some((value) => value.includes(prefix)) === true
      );
    }

    const input = harness.handlers.get("input")?.[0];
    if (input === undefined) throw new Error("Missing input handler");
    expect(await input({
      type: "input",
      text: "continue in background",
      source: "rpc",
      streamingBehavior: "steer",
    }, harness.ctx)).toEqual({ action: "continue" });

    const detached = await Promise.all(waits);
    expect(detached.map((result) => result.details)).toMatchObject([
      {
        process: { id: "p1", reason: "detached_by_steering" },
        output: { content: "first-prefix", cursor: { after: 12 } },
      },
      {
        process: { id: "p2", reason: "detached_by_steering" },
        output: { content: "second-prefix", cursor: { after: 13 } },
      },
    ]);

    // process_write is deliberately exact: callers provide Enter and EOF.
    await Promise.all([
      processWrite.execute("write-p1", {
        id: "p1",
        data: "one\n",
        close: true,
      }, undefined, undefined, harness.ctx),
      processWrite.execute("write-p2", {
        id: "p2",
        data: "two\n",
        close: true,
      }, undefined, undefined, harness.ctx),
    ]);
    await waitUntil(() => harness.messages.length === 1);

    expect(harness.messages[0]).toMatchObject({
      delivery: { triggerTurn: true, deliverAs: "steer" },
      message: { display: true },
    });
    const notified = harness.messages[0]?.message.details.processes;
    expect(notified?.map((process) => process.id).sort()).toEqual(["p1", "p2"]);
    expect(notified?.find((process) => process.id === "p1")).toMatchObject({
      events: ["completed"],
      output: { content: "first-suffix:one" },
    });
    expect(notified?.find((process) => process.id === "p2")).toMatchObject({
      events: ["completed"],
      output: { content: "second-suffix:two" },
    });

    const consumed = await processRead.execute(
      "read-consumed",
      { id: "p1" },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(consumed.details).toMatchObject({
      output: { content: "", cursor: { advanced: false } },
    });
    const recovered = await processRead.execute(
      "read-recovery",
      { id: "p1", start: 0 },
      undefined,
      undefined,
      harness.ctx,
    );
    expect(recovered.details).toMatchObject({
      output: {
        content: "first-prefixfirst-suffix:one",
        cursor: { advanced: false },
      },
    });
  });

  it("keeps stderr-only monitors quiet and fairly groups their combined completion tails", async () => {
    const harness = createHarness();
    await harness.start();
    const bash = requireTool(harness, "bash");
    const processWrite = requireTool(harness, "process_write");
    const command = (label: string) =>
      `printf '${label}-stderr-before|' >&2; IFS= read -r line; yes ${label} | tr -d '\\n' | head -c 60000; printf '|${label}-stderr-tail|' >&2; printf '|${label}-stdout-tail|'`;

    const started = [];
    for (const label of ["A", "B"]) {
      started.push(await bash.execute(
        `monitor-${label}`,
        { command: command(label), mode: "monitor" },
        undefined,
        undefined,
        harness.ctx,
      ));
    }
    expect(started.map((result) => result.details)).toMatchObject([
      { process: { id: "p1", mode: "monitor" } },
      { process: { id: "p2", mode: "monitor" } },
    ]);

    // stderr alone must not arm or flush monitor notifications.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(harness.messages).toEqual([]);

    await Promise.all(["p1", "p2"].map((id) => processWrite.execute(
      `release-${id}`,
      { id, data: "go\n", close: true },
      undefined,
      undefined,
      harness.ctx,
    )));
    await waitUntil(() => harness.messages.length === 1);

    const batch = harness.messages[0]?.message.details;
    expect(batch?.processes.map((process) => process.id).sort()).toEqual([
      "p1",
      "p2",
    ]);
    expect(batch?.returned.bytes).toBe(50 * 1024);
    expect(batch?.processes.map((process) => process.output.returnedBytes))
      .toEqual([25 * 1024, 25 * 1024]);
    expect(batch?.processes.every((process) =>
      process.events.includes("stdout")
      && process.events.includes("completed")
      && process.output.omittedRanges.length > 0
      && process.output.cursor.after === process.output.totalBytes
    )).toBe(true);
    const first = batch?.processes.find((process) => process.id === "p1");
    const second = batch?.processes.find((process) => process.id === "p2");
    expect(first?.output.content).toContain("A-stderr-tail");
    expect(first?.output.content).toContain("A-stdout-tail");
    expect(second?.output.content).toContain("B-stderr-tail");
    expect(second?.output.content).toContain("B-stdout-tail");
  });
});
