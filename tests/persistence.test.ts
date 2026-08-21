import { rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createRuntimeEndingEntryData,
  PROCESS_RUNTIME_END_ENTRY_TYPE,
  reconstructProcessPersistence,
} from "../background-processes/persistence";
import { OutputStore } from "../background-processes/output-store";
import type { ManagedProcessRecord } from "../background-processes/types";

function toolResult(toolName: string, details: unknown, content = ""): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      details,
      content: [{ type: "text", text: content }],
    },
  };
}

describe("process session persistence reconstruction", () => {
  it("merges tool results, notifications, and graceful runtime endings", () => {
    const entries = [
      toolResult("bash", {
        process: {
          kind: "started",
          id: "p2",
          command: "sleep 30",
          cwd: "/work",
          mode: "monitor",
          pid: 102,
          startedAt: 1000,
        },
      }),
      toolResult("process_list", {
        processes: [{
          id: "p7",
          state: "completed",
          command: "printf done",
          mode: "background",
          pid: 107,
          startedAt: 900,
          completedAt: 950,
          exitCode: 0,
          exitSignal: null,
          output: {
            totalBytes: 4,
            totalLines: 1,
            deliveredCursor: 4,
            spilled: true,
            spillPath: "/tmp/p7.log",
          },
        }],
      }),
      {
        type: "message",
        message: {
          role: "custom",
          customType: "pibg-process-events",
          content: "process p2 update",
          details: {
            processes: [{
              id: "p2",
              status: {
                id: "p2",
                state: "running",
                command: "sleep 30",
                mode: "monitor",
                output: { totalBytes: 12, totalLines: 2, spilled: false },
              },
            }],
          },
        },
      },
      {
        type: "custom",
        customType: PROCESS_RUNTIME_END_ENTRY_TYPE,
        data: {
          kind: "process-runtime-ending",
          version: 1,
          runtimeId: "runtime-a",
          endedAt: 2000,
          reason: "reload",
          processes: [
            {
              id: "p2",
              command: "sleep 30",
              cwd: "/work",
              mode: "monitor",
              pid: 102,
              startedAt: 1000,
              state: "running",
              timedOut: false,
              stdinClosed: false,
              output: {
                totalBytes: 12,
                totalLines: 2,
                deliveredCursor: 12,
                spilled: false,
              },
            },
            {
              id: "p7",
              command: "printf done",
              cwd: "/work",
              mode: "background",
              pid: 107,
              startedAt: 900,
              state: "completed",
              completedAt: 950,
              exitCode: 0,
              exitSignal: null,
              timedOut: false,
              stdinClosed: true,
              output: {
                totalBytes: 4,
                totalLines: 1,
                deliveredCursor: 4,
                spilled: true,
                spillPath: "/tmp/p7.log",
              },
            },
          ],
        },
      },
    ];

    const recovery = reconstructProcessPersistence(entries);

    expect(recovery).toMatchObject({
      maxProcessNumber: 7,
      nextProcessNumber: 8,
      historical: [
        {
          id: "p2",
          command: "sleep 30",
          mode: "monitor",
          priorState: "running",
          runtimeEnd: "graceful",
          shutdownReason: "reload",
          output: { totalBytes: 12, deliveredCursor: 12 },
          message: "Process `p2` belonged to a previous runtime and was terminated during reload.",
        },
        {
          id: "p7",
          priorState: "completed",
          exitCode: 0,
          runtimeEnd: "graceful",
          shutdownReason: "reload",
          output: { spillPath: "/tmp/p7.log" },
        },
      ],
    });
    expect(recovery.historical[1]?.message).toContain(
      "had already completed before reload",
    );
  });

  it("treats observations without an ending entry as an unknown crash", () => {
    const recovery = reconstructProcessPersistence([
      toolResult(
        "bash",
        undefined,
        "Started background process `p19` (PID 42).",
      ),
      toolResult("process_read", {
        process: {
          id: "p4",
          state: "completed",
          command: "old command",
          mode: "background",
          exitCode: 3,
        },
      }),
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            name: "process_kill",
            arguments: { id: "p23" },
          }],
        },
      },
    ]);

    expect(recovery.nextProcessNumber).toBe(24);
    expect(recovery.historical).toMatchObject([
      {
        id: "p4",
        priorState: "completed",
        runtimeEnd: "unknown",
      },
      {
        id: "p19",
        runtimeEnd: "unknown",
      },
      {
        id: "p23",
        runtimeEnd: "unknown",
      },
    ]);
    expect(recovery.historical[0]?.message).toContain(
      "no graceful shutdown record",
    );
    expect(recovery.historical[1]?.message).toContain("ended unexpectedly");
    expect(recovery.historical[2]?.message).toContain("ended unexpectedly");
  });

  it("ignores malformed and unrelated entries while reserving valid nested IDs", () => {
    expect(() => reconstructProcessPersistence([
      null,
      "old line",
      { type: "message", message: null },
      { type: "message", message: { role: "toolResult", toolName: "read", details: { id: "p999" } } },
      {
        type: "custom",
        customType: PROCESS_RUNTIME_END_ENTRY_TYPE,
        data: {
          reason: 12,
          processes: [null, { id: "p0" }, { id: "p3", command: 8 }],
        },
      },
      { type: "message", message: { role: "toolResult", toolName: "bash", details: { process: { id: "p9007199254740992" } } } },
    ])).not.toThrow();

    const recovery = reconstructProcessPersistence([
      {
        type: "custom",
        customType: PROCESS_RUNTIME_END_ENTRY_TYPE,
        data: { reason: "future-reason", processes: [{ id: "p3" }] },
      },
    ]);
    expect(recovery).toMatchObject({ maxProcessNumber: 3, nextProcessNumber: 4 });
    expect(recovery.historical[0]).toMatchObject({ id: "p3", runtimeEnd: "unknown" });
  });

  it("serializes every managed field and spill path into a non-LLM ending payload", () => {
    const outputStore = new OutputStore({ maxInMemoryBytes: 2 });
    outputStore.append("spill-me");
    outputStore.readImplicit();
    const record = {
      id: "p5",
      command: "printf spill-me",
      cwd: "/work",
      mode: "background",
      child: {},
      pid: 55,
      startedAt: 100,
      completedAt: 150,
      exitCode: 0,
      exitSignal: null,
      timedOut: false,
      stdinClosed: true,
      lastSignal: "SIGTERM",
      outputStore,
      deliveredCursor: outputStore.deliveredCursor,
      completion: Promise.resolve({
        completedAt: 150,
        exitCode: 0,
        exitSignal: null,
        timedOut: false,
      }),
    } as unknown as ManagedProcessRecord;

    const data = createRuntimeEndingEntryData(
      "runtime-five",
      "resume",
      [record],
      { endedAt: 200, targetSessionFile: "/next.jsonl" },
    );

    expect(data).toMatchObject({
      kind: "process-runtime-ending",
      version: 1,
      runtimeId: "runtime-five",
      endedAt: 200,
      reason: "resume",
      targetSessionFile: "/next.jsonl",
      processes: [{
        id: "p5",
        state: "completed",
        exitCode: 0,
        lastSignal: "SIGTERM",
        output: {
          totalBytes: 8,
          deliveredCursor: 8,
          spilled: true,
          spillPath: outputStore.spillPath,
        },
      }],
    });
    outputStore.close();
    if (outputStore.spillPath !== undefined) {
      rmSync(outputStore.spillPath, { force: true });
    }
  });
});
