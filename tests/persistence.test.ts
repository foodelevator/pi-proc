import { rmSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PROCESS_NOTIFICATION_MESSAGE_TYPE } from "../background-processes/notification-scheduler";
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
    id: "entry0001",
    parentId: null,
    timestamp: "2026-08-21T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName,
      details,
      content: [{ type: "text", text: content }],
      isError: false,
      timestamp: 1_787_270_400_000,
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
          customType: PROCESS_NOTIFICATION_MESSAGE_TYPE,
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

  it("never fabricates IDs from command output, filenames, metrics, or unsafe numbers", () => {
    const recovery = reconstructProcessPersistence([
      toolResult(
        "bash",
        undefined,
        "latency p50=1ms p95=9ms p99=20ms; artifacts: p1.py p2.py; pod/api-p7",
      ),
      toolResult("bash", {
        process: {
          kind: "started",
          id: "p3",
          command: "python p1.py --percentiles p50,p95,p99",
          cwd: "/work",
          mode: "monitor",
          pid: 303,
          startedAt: 300,
        },
      }, "output includes changelist p4 and p9007199254740991"),
      toolResult("process_list", {
        processes: [{
          id: "p4",
          state: "completed",
          command: "python p1.py",
          mode: "background",
          pid: 304,
          startedAt: 301,
          completedAt: 302,
          exitCode: 0,
          output: { totalBytes: 0, totalLines: 0, spilled: false },
        }],
      }),
      toolResult("process_read", {
        process: {
          id: "p9007199254740991",
          state: "completed",
          command: "unsafe",
        },
      }),
      {
        type: "message",
        message: {
          role: "custom",
          customType: PROCESS_NOTIFICATION_MESSAGE_TYPE,
          content:
            "latency p50/p95/p99; files p1.py p2.py; process-looking p800",
          details: {
            processes: [{
              id: "p5",
              events: ["completed"],
              status: {
                id: "p5",
                state: "completed",
                command: "printf done",
                cwd: "/work",
                mode: "background",
                pid: 305,
                startedAt: 303,
                completedAt: 304,
                exitCode: 0,
                output: { totalBytes: 4, totalLines: 1, spilled: false },
              },
            }],
          },
        },
      },
    ]);

    expect(recovery).toMatchObject({
      maxProcessNumber: 5,
      nextProcessNumber: 6,
      historical: [
        { id: "p3", command: "python p1.py --percentiles p50,p95,p99" },
        { id: "p4", command: "python p1.py", priorState: "completed" },
        { id: "p5", command: "printf done", priorState: "completed" },
      ],
    });
    expect(recovery.historical.map(({ id }) => id)).toEqual(["p3", "p4", "p5"]);
  });

  it("treats genuine typed detail observations without an ending entry as an unknown crash", () => {
    const recovery = reconstructProcessPersistence([
      toolResult(
        "bash",
        {
          process: {
            kind: "started",
            id: "p19",
            command: "sleep 30",
            cwd: "/work",
            mode: "background",
            pid: 42,
            startedAt: 100,
          },
        },
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
    ]);

    expect(recovery.nextProcessNumber).toBe(20);
    expect(recovery.historical).toMatchObject([
      {
        id: "p4",
        priorState: "completed",
        runtimeEnd: "unknown",
      },
      {
        id: "p19",
        command: "sleep 30",
        mode: "background",
        runtimeEnd: "unknown",
      },
    ]);
    expect(recovery.historical[0]?.message).toContain(
      "no graceful shutdown record",
    );
    expect(recovery.historical[1]?.message).toContain("ended unexpectedly");
  });

  it("ignores malformed and unrelated entries while reserving valid typed legacy IDs", () => {
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
      { type: "message", message: { role: "toolResult", toolName: "bash", details: { process: { id: "p9007199254740991" } } } },
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
