import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { OutputStore } from "../background-processes/output-store";
import { ProcessManager } from "../background-processes/process-manager";
import {
  createProcessKillTool,
  type ProcessKillToolInput,
} from "../background-processes/tools/process-kill";
import {
  createProcessListTool,
  type ProcessListToolInput,
} from "../background-processes/tools/process-list";
import {
  createProcessReadTool,
  type ProcessReadToolInput,
} from "../background-processes/tools/process-read";
import {
  createProcessWriteTool,
  type ProcessWriteToolInput,
} from "../background-processes/tools/process-write";
import type { ManagedProcessRecord } from "../background-processes/types";

const managers: ProcessManager[] = [];
const temporaryDirectories: string[] = [];

function makeManager(
  options: ConstructorParameters<typeof ProcessManager>[0] = {},
): ProcessManager {
  const manager = new ProcessManager({
    pipeIdleMs: 40,
    shutdownGraceMs: 50,
    shutdownForceWaitMs: 500,
    ...options,
  });
  managers.push(manager);
  return manager;
}

function tools(manager: ProcessManager) {
  const options = { getManager: () => manager };
  const context = {} as ExtensionContext;
  const read = createProcessReadTool(options);
  const write = createProcessWriteTool(options);
  const kill = createProcessKillTool(options);
  const list = createProcessListTool(options);
  return {
    read: {
      ...read,
      execute: (
        id: string,
        params: ProcessReadToolInput,
        signal?: AbortSignal,
      ) => read.execute(id, params, signal, undefined, context),
    },
    write: {
      ...write,
      execute: (
        id: string,
        params: ProcessWriteToolInput,
        signal?: AbortSignal,
      ) => write.execute(id, params, signal, undefined, context),
    },
    kill: {
      ...kill,
      execute: (
        id: string,
        params: ProcessKillToolInput,
        signal?: AbortSignal,
      ) => kill.execute(id, params, signal, undefined, context),
    },
    list: {
      ...list,
      execute: (
        id: string,
        params: ProcessListToolInput,
        signal?: AbortSignal,
      ) => list.execute(id, params, signal, undefined, context),
    },
  };
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

async function waitForOutput(
  record: ManagedProcessRecord,
  text: string,
): Promise<void> {
  await waitUntil(() =>
    record.outputStore.readRange(0).content.includes(text)
  );
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const content = result.content[0];
  if (content?.type !== "text" || content.text === undefined) {
    throw new Error("Expected text tool result");
  }
  return content.text;
}

afterEach(async () => {
  await Promise.allSettled(
    managers.splice(0).map(async (manager) => manager.shutdown()),
  );
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("auxiliary tool schemas and prompts", () => {
  it("uses provider-compatible signal enums and accurate management guidance", async () => {
    const manager = makeManager();
    const auxiliary = tools(manager);
    const signalSchema = auxiliary.kill.parameters.properties.signal as unknown as {
      type: string;
      enum: string[];
    };

    expect(signalSchema.type).toBe("string");
    expect(signalSchema.enum).toEqual(Object.keys(osConstants.signals).sort());
    expect(auxiliary.read.parameters.properties.length).toMatchObject({
      type: "integer",
      minimum: 1,
    });
    expect(auxiliary.read.promptGuidelines?.join(" ")).toContain(
      "explicit start byte",
    );
    expect(auxiliary.write.description).toContain("never appends a newline");
    expect(auxiliary.kill.description).toContain("never escalates automatically");
    expect(auxiliary.list.description).toContain("active processes only");
    await expect(auxiliary.kill.execute("invalid-signal", {
      id: "p1",
      signal: "NOT_A_SIGNAL",
    })).rejects.toThrow("Unsupported signal on this platform");
  });
});

describe("process_read", () => {
  it("returns a spilled implicit tail, advances the cursor, and explicitly recovers the prefix", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pibg-read-tool-"));
    temporaryDirectories.push(directory);
    const manager = makeManager({
      outputStoreFactory: () => new OutputStore({
        maxInMemoryBytes: 4,
        maxInMemoryLines: 100,
        maxReadBytes: 4,
        maxReadLines: 100,
        createSpillPath: () => join(directory, "output.log"),
      }),
    });
    const { read } = tools(manager);
    const record = await manager.startManaged("printf 0123456789");
    await record.completion;

    const tail = await read.execute("tail", { id: record.id });
    expect(tail.details.output).toMatchObject({
      content: "6789",
      requestedRange: { start: 0, end: 10 },
      returnedRange: { start: 6, end: 10 },
      omittedRanges: [{ start: 0, end: 6 }],
      cursor: { before: 0, after: 10, advanced: true },
      totalBytes: 10,
      spillPath: join(directory, "output.log"),
    });
    expect(textOf(tail)).toContain("Omitted byte ranges: [0, 6)");

    const recovery = await read.execute("recover", {
      id: record.id,
      start: 0,
      length: 4,
    });
    expect(recovery.details.output).toMatchObject({
      content: "0123",
      requestedRange: { start: 0, end: 4 },
      returnedRange: { start: 0, end: 4 },
      cursor: { before: 10, after: 10, advanced: false },
    });
    expect(record.outputStore.deliveredCursor).toBe(10);
  });

  it("rejects a zero length without consuming unread output", async () => {
    const manager = makeManager();
    const { read } = tools(manager);
    const record = await manager.startManaged("printf unread");
    await record.completion;

    await expect(read.execute("zero", {
      id: record.id,
      length: 0,
    })).rejects.toThrow("positive safe integer");
    expect(record.outputStore.deliveredCursor).toBe(0);
    expect((await read.execute("recover", { id: record.id })).details.output)
      .toMatchObject({
        content: "unread",
        cursor: { before: 0, after: 6, advanced: true },
      });
  });

  it("allows completed reads but reports historical and unknown IDs precisely", async () => {
    const manager = makeManager();
    const { read } = tools(manager);
    const completed = await manager.startManaged("printf retained");
    await completed.completion;
    manager.registerHistoricalProcess({
      id: "p20",
      message: "Process `p20` belonged to a previous runtime and was terminated",
    });

    expect((await read.execute("completed", { id: completed.id })).details)
      .toMatchObject({
        process: { state: "completed" },
        output: { content: "retained" },
      });
    await expect(read.execute("historical", { id: "p20" })).rejects.toThrow(
      "belonged to a previous runtime",
    );
    await expect(read.execute("unknown", { id: "p999" })).rejects.toThrow(
      "Unknown process ID: p999",
    );
  });
});

describe("process_write", () => {
  it("adds no newline, then writes an explicit newline and sends EOF", async () => {
    const manager = makeManager();
    const { read, write } = tools(manager);
    const record = await manager.startManaged(
      "IFS= read -r line; printf 'line:%s|' \"$line\"; rest=$(cat); printf 'rest:%s' \"$rest\"",
    );

    const first = await write.execute("no-newline", {
      id: record.id,
      data: "alpha",
    });
    expect(first.details.bytesWritten).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(record.outputStore.totalBytes).toBe(0);

    const eof = await write.execute("newline-eof", {
      id: record.id,
      data: "\nbeta",
      close: true,
    });
    expect(eof.details).toMatchObject({ bytesWritten: 5, stdinClosed: true });
    await record.completion;
    expect((await read.execute("stdin-output", { id: record.id })).details.output.content)
      .toBe("line:alpha|rest:beta");
    await expect(write.execute("completed-write", {
      id: record.id,
      data: "late",
    })).rejects.toThrow("already completed");
  });

  it("aborts a blocked pipe write without late rejection or listener leaks", async () => {
    const manager = makeManager();
    const { write } = tools(manager);
    const record = await manager.startManaged("sleep 30");
    const controller = new AbortController();
    const stdinListeners = {
      close: record.child.stdin.listenerCount("close"),
      drain: record.child.stdin.listenerCount("drain"),
      error: record.child.stdin.listenerCount("error"),
    };
    const unhandled: unknown[] = [];
    const handleUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handleUnhandled);

    try {
      const startedAt = Date.now();
      const pending = write.execute("blocked-abort", {
        id: record.id,
        data: "x".repeat(8 * 1024 * 1024),
      }, controller.signal);
      await waitUntil(() => record.child.stdin.writableNeedDrain);

      controller.abort();

      await expect(pending).rejects.toThrow("Process write aborted");
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

      await manager.signalProcessAndWait(record.id, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(record.child.stdin.listenerCount("close")).toBe(
        stdinListeners.close,
      );
      expect(record.child.stdin.listenerCount("drain")).toBe(
        stdinListeners.drain,
      );
      expect(record.child.stdin.listenerCount("error")).toBe(
        stdinListeners.error,
      );
    } finally {
      process.off("unhandledRejection", handleUnhandled);
      if (record.completedAt === undefined) {
        await manager.signalProcessAndWait(record.id, "SIGKILL");
      }
    }
  });

  it("respects backpressure and reports explicitly closed active stdin", async () => {
    const manager = makeManager();
    const { write } = tools(manager);
    const counted = await manager.startManaged("sleep 0.03; wc -c");
    const data = "x".repeat(1024 * 1024);

    await write.execute("backpressure", {
      id: counted.id,
      data,
      close: true,
    });
    await counted.completion;
    expect(counted.outputStore.readRange(0).content.trim()).toBe(
      String(data.length),
    );

    const closed = await manager.startManaged("cat >/dev/null; printf eof; sleep 30");
    await write.execute("close", { id: closed.id, close: true });
    await waitForOutput(closed, "eof");
    await expect(write.execute("closed", {
      id: closed.id,
      data: "late",
    })).rejects.toThrow("stdin is closed");
    await manager.signalProcessAndWait(closed.id, "SIGKILL");
  });
});

describe("process_kill", () => {
  it("does not escalate a TERM survivor, then accepts explicit KILL", async () => {
    const manager = makeManager({ terminatingSignalWaitMs: 60 });
    const { kill, read } = tools(manager);
    const record = await manager.startManaged(
      "trap '' TERM; printf ready; while :; do sleep 1; done",
    );
    await waitForOutput(record, "ready");
    await read.execute("consume-ready", { id: record.id });

    const term = await kill.execute("term", { id: record.id });
    expect(term.details).toMatchObject({
      signal: "SIGTERM",
      sent: true,
      exited: false,
      waitedForExit: true,
      output: { content: "" },
      process: { state: "running", lastSignal: "SIGTERM" },
    });
    expect(textOf(term)).toContain("no escalation was performed");
    expect(record.completedAt).toBeUndefined();

    const killed = await kill.execute("kill", {
      id: record.id,
      signal: "SIGKILL",
    });
    expect(killed.details).toMatchObject({
      signal: "SIGKILL",
      sent: true,
      exited: true,
      process: { state: "completed", exitSignal: "SIGKILL" },
    });
  });

  it("returns output produced during termination and suppresses duplicate completion reporting", async () => {
    const manager = makeManager();
    const { kill, read } = tools(manager);
    const completionEvents: string[] = [];
    manager.subscribeEvents((event) => {
      if (event.type === "completed") completionEvents.push(event.process.id);
    });
    const record = await manager.startManaged(
      "trap 'printf output-on-term; exit 0' TERM; printf ready; while :; do sleep 1; done",
    );
    await waitForOutput(record, "ready");
    await read.execute("consume-ready", { id: record.id });

    const result = await kill.execute("graceful", { id: record.id });

    expect(result.details).toMatchObject({
      signal: "SIGTERM",
      exited: true,
      process: { state: "completed" },
    });
    expect(result.details.output.content).toContain("output-on-term");
    expect(result.details.output.cursor.advanced).toBe(true);
    expect(completionEvents).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(completionEvents).toEqual([]);
  });

  it("preserves later completion reporting when a signaled process survives the call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pibg-kill-survivor-"));
    temporaryDirectories.push(directory);
    const release = join(directory, "release");
    const manager = makeManager({ terminatingSignalWaitMs: 50 });
    const { kill } = tools(manager);
    const completionEvents: string[] = [];
    manager.subscribeEvents((event) => {
      if (event.type === "completed") completionEvents.push(event.process.id);
    });
    const record = await manager.startManaged(
      `trap '' TERM; printf ready; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done; printf later`,
    );
    await waitForOutput(record, "ready");

    expect((await kill.execute("survive", { id: record.id })).details.exited)
      .toBe(false);
    expect(completionEvents).toEqual([]);
    writeFileSync(release, "go", "utf8");
    await record.completion;
    expect(completionEvents).toEqual([record.id]);
  });

  it("aborts the termination wait and preserves later completion reporting", async () => {
    const manager = makeManager({ terminatingSignalWaitMs: 2_000 });
    const { kill } = tools(manager);
    const completionEvents: string[] = [];
    manager.subscribeEvents((event) => {
      if (event.type === "completed") completionEvents.push(event.process.id);
    });
    const record = await manager.startManaged(
      "trap '' TERM; printf ready; while :; do sleep 1; done",
    );
    await waitForOutput(record, "ready");
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = kill.execute("abort-wait", {
      id: record.id,
    }, controller.signal);
    await waitUntil(() => record.lastSignal === "SIGTERM");

    controller.abort();

    await expect(pending).rejects.toThrow("Process kill aborted");
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(record.outputStore.deliveredCursor).toBe(0);
    expect(completionEvents).toEqual([]);

    await manager.signalProcessAndWait(record.id, "SIGKILL");
    expect(completionEvents).toEqual([record.id]);
  });

  it("rejects completed and unknown targets", async () => {
    const manager = makeManager();
    const { kill } = tools(manager);
    const record = await manager.startManaged("true");
    await record.completion;

    await expect(kill.execute("completed", { id: record.id })).rejects.toThrow(
      "already completed",
    );
    await expect(kill.execute("unknown", { id: "p404" })).rejects.toThrow(
      "Unknown process ID: p404",
    );
  });
});

describe("process_list", () => {
  it("defaults to active records and includes completed plus historical records only on request", async () => {
    const manager = makeManager();
    const { list } = tools(manager);
    const active = await manager.startManaged("sleep 30", { mode: "monitor" });
    const completed = await manager.startManaged("printf done");
    await completed.completion;
    manager.registerHistoricalProcess({
      id: "p20",
      command: "old watcher",
      mode: "monitor",
      priorState: "running",
      runtimeEnd: "graceful",
      shutdownReason: "resume",
      output: {
        totalBytes: 42,
        totalLines: 3,
        spilled: true,
        spillPath: "/tmp/old-watcher.log",
      },
      message:
        "Process `p20` belonged to a previous runtime and was terminated during session replacement (resume).",
    });

    const activeOnly = await list.execute("active", {});
    expect(activeOnly.details).toMatchObject({
      includeCompleted: false,
      processes: [{ id: active.id, state: "running", mode: "monitor" }],
    });
    expect(textOf(activeOnly)).toContain(active.id);
    expect(textOf(activeOnly)).not.toContain(completed.id);

    const all = await list.execute("all", { include_completed: true });
    expect(all.details.processes.map((process) => process.id)).toEqual([
      active.id,
      completed.id,
      "p20",
    ]);
    const listedCompleted = all.details.processes.find(
      (process) => process.id === completed.id,
    );
    expect(listedCompleted).toMatchObject({
      id: completed.id,
      state: "completed",
      exitCode: 0,
    });
    expect(listedCompleted?.output.totalBytes).toBe(4);
    expect(all.details.processes[2]).toMatchObject({
      id: "p20",
      state: "historical",
      priorState: "running",
      shutdownReason: "resume",
      output: { spillPath: "/tmp/old-watcher.log" },
    });
    expect(textOf(all)).toContain("p20  historical  monitor");
    expect(textOf(all)).toContain("terminated during session replacement (resume)");
    expect(textOf(activeOnly)).not.toContain("p20");

    await manager.signalProcessAndWait(active.id, "SIGKILL");
    expect((await list.execute("empty-active", {})).details.processes).toEqual([]);
  });
});
