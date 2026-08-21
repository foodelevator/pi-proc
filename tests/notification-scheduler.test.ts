import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROCESS_NOTIFICATION_MESSAGE_TYPE,
  ProcessNotificationScheduler,
  type ProcessNotificationMessage,
} from "../background-processes/notification-scheduler";
import {
  ProcessManager,
  type ProcessManagerEvent,
  type ProcessManagerEventListener,
} from "../background-processes/process-manager";
import { OutputStore } from "../background-processes/output-store";
import type {
  ManagedProcessRecord,
  ProcessCompletion,
} from "../background-processes/types";

class FakeEventSource {
  readonly listeners = new Set<ProcessManagerEventListener>();

  subscribeEvents(listener: ProcessManagerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ProcessManagerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function fakeRecord(
  id: string,
  mode: ManagedProcessRecord["mode"] = "monitor",
): ManagedProcessRecord {
  const outputStore = new OutputStore({
    maxInMemoryBytes: 2_000_000,
    maxInMemoryLines: 100_000,
  });
  return {
    id,
    command: `command-${id}`,
    cwd: "/test",
    mode,
    child: {} as ManagedProcessRecord["child"],
    pid: Number(id.slice(1)) + 100,
    startedAt: Date.now(),
    timedOut: false,
    stdinClosed: false,
    outputStore,
    get deliveredCursor() {
      return outputStore.deliveredCursor;
    },
    completion: new Promise(() => {}),
  };
}

function complete(
  record: ManagedProcessRecord,
  overrides: Partial<ProcessCompletion> = {},
): ProcessCompletion {
  const completion: ProcessCompletion = {
    completedAt: Date.now(),
    exitCode: 0,
    exitSignal: null,
    timedOut: false,
    ...overrides,
  };
  record.completedAt = completion.completedAt;
  record.exitCode = completion.exitCode;
  record.exitSignal = completion.exitSignal;
  record.timedOut = completion.timedOut;
  record.stdinClosed = true;
  return completion;
}

function harness(idle = true) {
  const source = new FakeEventSource();
  const sent: Array<{
    message: ProcessNotificationMessage;
    options: { triggerTurn: true; deliverAs: "steer" };
  }> = [];
  let currentlyIdle = idle;
  const scheduler = new ProcessNotificationScheduler({
    eventSource: source,
    isIdle: () => currentlyIdle,
    sendMessage: (message, options) => sent.push({ message, options }),
  });
  return {
    source,
    sent,
    scheduler,
    setIdle(value: boolean) {
      currentlyIdle = value;
    },
  };
}

function detailsOf(harnessValue: ReturnType<typeof harness>) {
  const message = harnessValue.sent[0]?.message;
  if (message === undefined) throw new Error("Expected a notification message");
  return message.details;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("global process notification scheduling", () => {
  it("uses one fixed, non-resetting 200ms window and coalesces processes globally", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const value = harness();
    const first = fakeRecord("p1");
    const second = fakeRecord("p2");
    first.outputStore.append("first");
    second.outputStore.append("second");

    value.source.emit({ type: "stdout-activity", process: first });
    vi.advanceTimersByTime(199);
    value.source.emit({ type: "stdout-activity", process: second });
    expect(value.sent).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(value.sent).toHaveLength(1);
    expect(value.sent[0]?.options).toEqual({
      triggerTurn: true,
      deliverAs: "steer",
    });
    expect(detailsOf(value).processes.map((item) => item.id)).toEqual([
      "p1",
      "p2",
    ]);
    expect(detailsOf(value).windowStartedAt).toBe(1_000);
    expect(first.deliveredCursor).toBe(5);
    expect(second.deliveredCursor).toBe(6);
    value.scheduler.shutdown();
  });

  it("retains an expired busy batch, accumulates later output/completion, and flushes once at turn_end", () => {
    vi.useFakeTimers();
    const value = harness(false);
    const first = fakeRecord("p1");
    const second = fakeRecord("p2", "background");
    first.outputStore.append("before-");
    value.source.emit({ type: "stdout-activity", process: first });

    vi.advanceTimersByTime(200);
    first.outputStore.append("while-busy");
    second.outputStore.append("finished");
    value.source.emit({
      type: "completed",
      process: second,
      completion: complete(second),
    });
    vi.advanceTimersByTime(5_000);
    expect(value.sent).toEqual([]);

    value.scheduler.handleTurnEnd();
    value.scheduler.handleTurnEnd();

    expect(value.sent).toHaveLength(1);
    const details = detailsOf(value);
    expect(details.processes.map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(details.processes[0]?.output.content).toBe("before-while-busy");
    expect(details.processes[1]).toMatchObject({
      events: ["completed"],
      status: { state: "completed", exitCode: 0 },
      output: { content: "finished" },
    });
    value.scheduler.shutdown();
  });

  it("releases a last-turn busy batch from agent_settled without waiting for user input", () => {
    vi.useFakeTimers();
    const value = harness(false);
    const record = fakeRecord("p1", "background");
    record.outputStore.append("last-turn");
    value.source.emit({
      type: "completed",
      process: record,
      completion: complete(record),
    });
    vi.advanceTimersByTime(200);
    expect(value.sent).toEqual([]);

    value.setIdle(true);
    value.scheduler.handleAgentSettled();
    value.scheduler.handleTurnEnd();
    value.scheduler.handleAgentSettled();

    expect(value.sent).toHaveLength(1);
    expect(detailsOf(value).processes[0]?.output.content).toBe("last-turn");
    expect(value.scheduler.pendingProcessCount).toBe(0);
    value.scheduler.shutdown();
  });

  it("handles timer/lifecycle ordering races exactly once", () => {
    vi.useFakeTimers();

    for (const releaseOrder of ["turn-first", "settled-first"] as const) {
      const value = harness(false);
      const record = fakeRecord(releaseOrder === "turn-first" ? "p1" : "p2");
      record.outputStore.append(releaseOrder);
      value.source.emit({ type: "stdout-activity", process: record });
      vi.advanceTimersByTime(200);
      value.setIdle(true);
      if (releaseOrder === "turn-first") {
        value.scheduler.handleTurnEnd();
        value.scheduler.handleAgentSettled();
      } else {
        value.scheduler.handleAgentSettled();
        value.scheduler.handleTurnEnd();
      }
      vi.runOnlyPendingTimers();
      expect(value.sent).toHaveLength(1);
      value.scheduler.shutdown();
    }

    const settledBeforeTimer = harness(false);
    const record = fakeRecord("p3");
    record.outputStore.append("timer-wins");
    settledBeforeTimer.source.emit({ type: "stdout-activity", process: record });
    vi.advanceTimersByTime(199);
    settledBeforeTimer.setIdle(true);
    settledBeforeTimer.scheduler.handleAgentSettled();
    expect(settledBeforeTimer.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    settledBeforeTimer.scheduler.handleTurnEnd();
    expect(settledBeforeTimer.sent).toHaveLength(1);
    settledBeforeTimer.scheduler.shutdown();
  });

  it("re-arms on new activity after busy expiry and keeps post-flush events in a fresh window", () => {
    vi.useFakeTimers();
    const value = harness(false);
    const first = fakeRecord("p1");
    const second = fakeRecord("p2");
    first.outputStore.append("first");
    value.source.emit({ type: "stdout-activity", process: first });
    vi.advanceTimersByTime(200);
    expect(value.scheduler.hasTimer).toBe(false);

    second.outputStore.append("second");
    value.source.emit({ type: "stdout-activity", process: second });
    expect(value.scheduler.hasTimer).toBe(true);
    value.setIdle(true);
    vi.advanceTimersByTime(200);
    expect(value.sent).toHaveLength(1);
    expect(detailsOf(value).processes.map((item) => item.id)).toEqual([
      "p1",
      "p2",
    ]);

    const third = fakeRecord("p3");
    third.outputStore.append("third");
    value.source.emit({ type: "stdout-activity", process: third });
    value.scheduler.handleAgentSettled();
    expect(value.sent).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(value.sent).toHaveLength(2);
    expect(value.sent[1]?.message.details.processes.map((item) => item.id))
      .toEqual(["p3"]);
    value.scheduler.shutdown();
  });

  it("stays silent for stderr-only monitor activity, then includes it on stdout or completion", () => {
    vi.useFakeTimers();
    const value = harness();
    const triggered = fakeRecord("p1");
    triggered.outputStore.append("stderr-before-");
    vi.advanceTimersByTime(1_000);
    expect(value.sent).toEqual([]);

    triggered.outputStore.append("stdout");
    value.source.emit({ type: "stdout-activity", process: triggered });
    vi.advanceTimersByTime(200);
    expect(detailsOf(value).processes[0]?.output.content).toBe(
      "stderr-before-stdout",
    );

    const stderrOnly = fakeRecord("p2");
    stderrOnly.outputStore.append("only-stderr");
    value.source.emit({
      type: "completed",
      process: stderrOnly,
      completion: complete(stderrOnly),
    });
    vi.advanceTimersByTime(200);
    expect(value.sent).toHaveLength(2);
    expect(value.sent[1]?.message.details.processes[0]).toMatchObject({
      id: "p2",
      events: ["completed"],
      output: { content: "only-stderr" },
    });
    value.scheduler.shutdown();
  });

  it("reports fast completion with status even when there is no output", () => {
    vi.useFakeTimers();
    const value = harness();
    const record = fakeRecord("p1", "background");
    value.source.emit({
      type: "completed",
      process: record,
      completion: complete(record, { exitCode: 7 }),
    });

    vi.advanceTimersByTime(200);

    expect(value.sent[0]?.message.content).toMatch(
      /^\[AUTOMATED PROCESS NOTIFICATION — NOT USER INPUT\]\nThe following reports process status and does not indicate user approval or confirmation\.\n\nManaged process notification batch \(1 process\):/,
    );
    expect(value.sent[0]?.message).toMatchObject({
      customType: PROCESS_NOTIFICATION_MESSAGE_TYPE,
      display: true,
      details: {
        processes: [{
          events: ["completed"],
          status: { state: "completed", exitCode: 7 },
          completion: { exitCode: 7 },
          output: {
            content: "",
            requestedRange: { start: 0, end: 0 },
            returnedRange: { start: 0, end: 0 },
          },
        }],
      },
    });
    expect(() => JSON.stringify(value.sent[0]?.message.details)).not.toThrow();
    value.scheduler.shutdown();
  });

  it("shares aggregate byte and line limits fairly while preserving every status", () => {
    vi.useFakeTimers();
    const bytes = harness();
    const first = fakeRecord("p1", "background");
    const second = fakeRecord("p2", "background");
    first.outputStore.append("a".repeat(60_000));
    second.outputStore.append("b".repeat(60_000));
    bytes.source.emit({ type: "completed", process: first, completion: complete(first) });
    bytes.source.emit({ type: "completed", process: second, completion: complete(second) });
    vi.advanceTimersByTime(200);

    const byteDetails = detailsOf(bytes);
    expect(byteDetails.processes).toHaveLength(2);
    expect(byteDetails.returned.bytes).toBeLessThanOrEqual(50 * 1024);
    expect(byteDetails.processes.map((item) => item.output.returnedBytes))
      .toEqual([25 * 1024, 25 * 1024]);
    expect(byteDetails.processes.every((item) =>
      item.output.omittedRanges.length > 0
      && item.output.requestedRange.end === 60_000
      && item.output.cursor.after === 60_000
    )).toBe(true);

    const lines = harness();
    const third = fakeRecord("p3", "background");
    const fourth = fakeRecord("p4", "background");
    third.outputStore.append("x\n".repeat(3_000));
    fourth.outputStore.append("y\n".repeat(3_000));
    lines.source.emit({ type: "completed", process: third, completion: complete(third) });
    lines.source.emit({ type: "completed", process: fourth, completion: complete(fourth) });
    vi.advanceTimersByTime(200);
    expect(detailsOf(lines).returned.lines).toBe(2_000);
    expect(detailsOf(lines).processes.map((item) => item.output.returnedLines))
      .toEqual([1_000, 1_000]);

    bytes.scheduler.shutdown();
    lines.scheduler.shutdown();
  });

  it("reports spill paths and every requested/returned/omitted byte range", () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "pi-proc-notification-spill-"));
    const spillPath = join(directory, "combined.log");
    const value = harness();
    const record = fakeRecord("p1", "background");
    record.outputStore = new OutputStore({
      maxInMemoryBytes: 4,
      maxInMemoryLines: 100,
      maxReadBytes: 4,
      maxReadLines: 100,
      createSpillPath: () => spillPath,
    });

    try {
      record.outputStore.append("0123456789");
      value.source.emit({
        type: "completed",
        process: record,
        completion: complete(record),
      });
      vi.advanceTimersByTime(200);

      const item = detailsOf(value).processes[0];
      expect(item?.output).toMatchObject({
        spillPath,
        requestedRange: { start: 0, end: 10 },
        returnedRange: { start: 6, end: 10 },
        omittedRanges: [{ start: 0, end: 6 }],
      });
      expect(value.sent[0]?.message.content).toContain(
        "requested [0, 10); returned [6, 10); omitted [0, 6)",
      );
      expect(value.sent[0]?.message.content).toContain(
        `full output spill: ${spillPath}`,
      );
    } finally {
      value.scheduler.shutdown();
      record.outputStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not consume on a synchronous send failure, then retries without losing or duplicating output", () => {
    vi.useFakeTimers();
    const source = new FakeEventSource();
    const delivered: ProcessNotificationMessage[] = [];
    const errors: Error[] = [];
    let attempts = 0;
    let idle = false;
    const scheduler = new ProcessNotificationScheduler({
      eventSource: source,
      isIdle: () => idle,
      sendMessage(message) {
        attempts++;
        if (attempts === 1) throw new Error("send failed");
        delivered.push(message);
      },
      onError: (error) => errors.push(error),
    });
    const record = fakeRecord("p1");
    record.outputStore.append("not-lost");
    source.emit({ type: "stdout-activity", process: record });

    vi.advanceTimersByTime(200);
    expect(attempts).toBe(0);
    idle = true;
    scheduler.handleAgentSettled();
    expect(record.deliveredCursor).toBe(0);
    expect(delivered).toEqual([]);
    expect(errors[0]?.message).toBe("send failed");
    expect(scheduler.hasTimer).toBe(true);

    record.outputStore.append("-later");
    vi.advanceTimersByTime(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.details.processes[0]?.output.content).toBe(
      "not-lost-later",
    );
    expect(record.deliveredCursor).toBe(14);
    scheduler.shutdown();
  });

  it("makes isIdle failures releasable before invoking the error callback", () => {
    vi.useFakeTimers();
    const source = new FakeEventSource();
    const sent: ProcessNotificationMessage[] = [];
    const errors: Error[] = [];
    const scheduler = new ProcessNotificationScheduler({
      eventSource: source,
      isIdle: () => {
        throw new Error("stale idle context");
      },
      sendMessage: (message) => sent.push(message),
      onError(error) {
        errors.push(error);
        scheduler.handleAgentSettled();
      },
    });
    const record = fakeRecord("p1");
    record.outputStore.append("recoverable");
    source.emit({ type: "stdout-activity", process: record });

    vi.advanceTimersByTime(200);

    expect(errors.map((error) => error.message)).toEqual([
      "stale idle context",
    ]);
    expect(sent).toHaveLength(1);
    expect(record.deliveredCursor).toBe(11);
    scheduler.handleTurnEnd();
    expect(sent).toHaveLength(1);
    scheduler.shutdown();
  });

  it("cancels its timer and listener without waking after shutdown", () => {
    vi.useFakeTimers();
    const value = harness();
    const record = fakeRecord("p1");
    record.outputStore.append("pending");
    value.source.emit({ type: "stdout-activity", process: record });
    expect(value.scheduler.hasTimer).toBe(true);
    expect(value.source.listeners.size).toBe(1);

    value.scheduler.shutdown();
    expect(value.scheduler.hasTimer).toBe(false);
    expect(value.source.listeners.size).toBe(0);
    vi.advanceTimersByTime(10_000);
    value.source.emit({
      type: "completed",
      process: record,
      completion: complete(record),
    });
    expect(value.sent).toEqual([]);
  });
});

describe("process_kill notification suppression", () => {
  it("does not produce a delayed completion wake for a process killed by the tool path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-proc-notification-kill-"));
    const manager = new ProcessManager({
      pipeIdleMs: 30,
      terminatingSignalWaitMs: 500,
      shutdownGraceMs: 30,
    });
    const sent: ProcessNotificationMessage[] = [];
    const scheduler = new ProcessNotificationScheduler({
      eventSource: manager,
      isIdle: () => true,
      sendMessage: (message) => sent.push(message),
      windowMs: 20,
    });

    try {
      const record = await manager.startManaged("sleep 30", {
        mode: "background",
        cwd: directory,
      });
      await manager.signalProcessAndWait(record.id, "SIGKILL", {
        includeUnreadOutput: true,
        suppressCompletionNotification: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sent).toEqual([]);
    } finally {
      scheduler.shutdown();
      await manager.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
