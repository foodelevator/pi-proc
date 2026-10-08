import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isNormallyTerminatingSignal,
  normalizeSignal,
  ProcessManager,
  ProcessSpawnError,
} from "../background-processes/process-manager";
import type {
  ProcessLookupError,
  ProcessStateError,
} from "../background-processes/process-manager";
import {
  createPiProcessEnvironment,
  killTrackedDetachedProcessGroups,
} from "../background-processes/shell";
import type { ProcessExecution } from "../background-processes/types";

const managers: ProcessManager[] = [];
const temporaryDirectories: string[] = [];

function manager(options: ConstructorParameters<typeof ProcessManager>[0] = {}) {
  const value = new ProcessManager({
    pipeIdleMs: 50,
    shutdownGraceMs: 80,
    shutdownForceWaitMs: 500,
    ...options,
  });
  managers.push(value);
  return value;
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
  execution: ProcessExecution,
  text: string,
): Promise<void> {
  await waitUntil(() => execution.outputStore.readRange(0).content.includes(text));
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (value) => value.shutdown()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("POSIX shell spawning", () => {
  it("guards unsupported platforms before starting processes", () => {
    expect(() => new ProcessManager({ platform: "win32" })).toThrowError(
      /supports only macOS and Linux/,
    );
  });

  it("removes stale PI session values and injects current values", () => {
    const env = createPiProcessEnvironment(
      {
        sessionId: "session-2",
        provider: "provider-2",
        model: "model-2",
        reasoningLevel: "high",
      },
      {
        PATH: "/test/bin",
        KEEP: "yes",
        PI_SESSION_ID: "stale",
        PI_SESSION_FILE: "/stale.jsonl",
        PI_PROVIDER: "stale-provider",
        PI_MODEL: "stale-model",
        PI_REASONING_LEVEL: "low",
      },
    );

    expect(env).toMatchObject({
      KEEP: "yes",
      PI_SESSION_ID: "session-2",
      PI_PROVIDER: "provider-2",
      PI_MODEL: "model-2",
      PI_REASONING_LEVEL: "high",
    });
    expect(env.PATH?.split(":")).toContain("/test/bin");
    expect(env).not.toHaveProperty("PI_SESSION_FILE");
  });

  it("makes injected Pi values visible to bash without mutating the parent env", async () => {
    const base = { ...process.env, PI_SESSION_ID: "parent" };
    const processes = manager({
      baseEnvironment: base,
      sessionEnvironment: {
        sessionId: "test-session",
        sessionFile: "/tmp/test-session.jsonl",
        provider: "test-provider",
        model: "test-model",
        reasoningLevel: "xhigh",
      },
    });

    const record = await processes.startManaged(
      "printf '%s|%s|%s|%s|%s' \"$PI_SESSION_ID\" \"$PI_SESSION_FILE\" \"$PI_PROVIDER\" \"$PI_MODEL\" \"$PI_REASONING_LEVEL\"",
    );
    await record.completion;

    expect(record.outputStore.readRange(0).content).toBe(
      "test-session|/tmp/test-session.jsonl|test-provider|test-model|xhigh",
    );
    expect(base.PI_SESSION_ID).toBe("parent");
  });

  it("registers detached groups for process-exit crash cleanup", async () => {
    const baselineExitListeners = process.listenerCount("exit");
    const processes = manager();
    const record = await processes.startManaged("sleep 30");

    expect(process.listenerCount("exit")).toBe(baselineExitListeners + 1);
    killTrackedDetachedProcessGroups();
    const completion = await record.completion;

    expect(completion.exitSignal).toBe("SIGKILL");
    expect(process.listenerCount("exit")).toBe(baselineExitListeners);
  });

  it("reports asynchronous executable spawn failures without allocating an ID", async () => {
    const processes = manager({
      shellConfig: { shell: "/definitely/not/a/shell", args: ["-c"] },
    });

    await expect(processes.startManaged("true")).rejects.toBeInstanceOf(
      ProcessSpawnError,
    );
    expect(processes.records).toHaveLength(0);
  });

  it("appends stdout and stderr in callback order and only reports stdout activity", async () => {
    const outputEvents: string[] = [];
    const stdoutActivity: string[] = [];
    const processes = manager({
      onOutput: (_execution, source, chunk) => {
        outputEvents.push(`${source}:${chunk.toString()}`);
      },
    });
    processes.subscribeEvents((event) => {
      if (event.type === "stdout-activity") {
        stdoutActivity.push(event.process.id);
      }
    });
    const record = await processes.startManaged(
      "printf out-1; sleep 0.03; printf err-1 >&2; sleep 0.03; printf out-2; sleep 0.03; printf err-2 >&2",
      { mode: "monitor" },
    );

    await record.completion;

    expect(outputEvents).toEqual([
      "stdout:out-1",
      "stderr:err-1",
      "stdout:out-2",
      "stderr:err-2",
    ]);
    expect(stdoutActivity).toEqual([record.id, record.id]);
    expect(record.outputStore.readRange(0).content).toBe(
      "out-1err-1out-2err-2",
    );
  });

  it("emits clean managed events while keeping background and waits stdout-quiet", async () => {
    const processes = manager();
    const events: string[] = [];
    processes.subscribeEvents((event) => {
      events.push(`${event.type}:${event.process.id}`);
    });

    const background = await processes.startManaged(
      "sleep 0.02; printf background-out",
      { mode: "background" },
    );
    const monitor = await processes.startManaged(
      "printf monitor-err >&2; sleep 0.02; printf monitor-out",
      { mode: "monitor" },
    );
    const foreground = await processes.startForeground(
      "sleep 0.02; printf foreground-out",
    );
    await Promise.all([
      background.completion,
      monitor.completion,
      foreground.completion,
    ]);

    expect(events.filter((event) => event.startsWith("stdout-activity:"))).toEqual([
      `stdout-activity:${monitor.id}`,
    ]);
    expect(events.filter((event) => event.startsWith("completed:")).sort()).toEqual([
      `completed:${background.id}`,
      `completed:${monitor.id}`,
    ].sort());
  });

  it("keeps reading active post-exit pipes until they end", async () => {
    const processes = manager({ pipeIdleMs: 100 });
    const record = await processes.startManaged(
      "(sleep 0.02; printf late; sleep 0.02; printf later) & exit 0",
    );

    const completion = await record.completion;

    expect(completion.exitCode).toBe(0);
    expect(record.outputStore.readRange(0).content).toBe("latelater");
  });

  it("finishes after post-exit pipe idleness instead of hanging", async () => {
    const processes = manager({ pipeIdleMs: 30 });
    const startedAt = Date.now();
    const record = await processes.startManaged("(sleep 30) & exit 0");

    try {
      const completion = await record.completion;
      expect(completion.exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      // This deliberately exercises unsupported shell-level detachment. The manager
      // considers the shell complete, so the fixture must kill its inherited group.
      try {
        process.kill(-record.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  });
});

describe("ProcessManager lifecycle", () => {
  it("keeps wait executions private and promotes all active waits on detachment", async () => {
    const processes = manager();
    const first = await processes.startForeground("printf first-ready; sleep 30");
    const second = await processes.startForeground("printf second-ready; sleep 30");
    await Promise.all([
      waitForOutput(first, "first-ready"),
      waitForOutput(second, "second-ready"),
    ]);

    expect(processes.records).toHaveLength(0);
    expect(processes.foregroundExecutions).toHaveLength(2);

    const detached = processes.detachAllForeground();

    expect(detached.map((record) => record.id)).toEqual(["p1", "p2"]);
    expect(detached.every((record) => record.mode === "background")).toBe(true);
    expect(await first.detachment).toBe(detached[0]);
    expect(await second.detachment).toBe(detached[1]);
    expect(await first.waitOutcome).toEqual({
      type: "detached",
      process: detached[0],
    });
    expect(await second.waitOutcome).toEqual({
      type: "detached",
      process: detached[1],
    });
    expect(processes.detachAllForeground()).toEqual([]);
    expect(processes.foregroundExecutions).toHaveLength(0);

    await Promise.all(detached.map(async (record) => {
      await processes.signalProcessAndWait(record.id, "SIGKILL");
    }));
  });

  it("returns successful and failing shell exit status and forgets completed waits", async () => {
    const processes = manager();
    const success = await processes.startForeground("printf ok");
    const successCompletion = await success.completion;
    expect(successCompletion).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await success.waitOutcome).toEqual({
      type: "completed",
      completion: successCompletion,
    });
    expect(processes.detachAllForeground()).toEqual([]);
    expect(success.outputStore.readRange(0).content).toBe("ok");

    const failure = await processes.startForeground("printf bad >&2; exit 7");
    expect(await failure.completion).toMatchObject({ exitCode: 7, timedOut: false });
    expect(failure.outputStore.readRange(0).content).toBe("bad");

    expect(processes.foregroundExecutions).toHaveLength(0);
    expect(processes.records).toHaveLength(0);
  });

  it("allocates public IDs after spawn and retains completed records and output", async () => {
    const completions: string[] = [];
    const processes = manager();
    processes.subscribeEvents((event) => {
      if (event.type === "completed") completions.push(event.process.id);
    });

    const first = await processes.startManaged("printf fast");
    const second = await processes.startManaged("exit 4", { mode: "monitor" });
    await Promise.all([first.completion, second.completion]);

    expect(first.id).toBe("p1");
    expect(second.id).toBe("p2");
    expect(completions).toHaveLength(2);
    expect(completions).toEqual(expect.arrayContaining(["p1", "p2"]));
    expect(processes.records).toHaveLength(2);
    expect(processes.activeRecords).toHaveLength(0);
    expect(processes.getProcess("p1")).toBe(first);
    expect(first.outputStore.readRange(0).content).toBe("fast");
  });

  it("rejects and reaps a spawned start racing with shutdown", async () => {
    const holder: { processes?: ProcessManager } = {};
    let shutdown: ReturnType<ProcessManager["shutdown"]> | undefined;
    let trackedPid: number | undefined;
    const tracker = {
      track(pid: number) {
        trackedPid = pid;
        if (holder.processes === undefined) {
          throw new Error("Manager was not initialized");
        }
        shutdown = holder.processes.shutdown();
      },
      untrack() {},
    };
    const processes = manager({
      detachedProcessGroupTracker: tracker,
      shutdownGraceMs: 20,
    });
    holder.processes = processes;

    const starting = processes.startManaged("sleep 30");

    await expect(starting).rejects.toMatchObject({ kind: "manager-closed" });
    if (shutdown === undefined) throw new Error("Shutdown was not started");
    const result = await shutdown;
    expect(result.signaled).toContain(trackedPid);
    expect(result.signalFailures).toEqual([]);
    expect(processes.records).toHaveLength(0);
    expect(processes.activeRecords).toHaveLength(0);
  });

  it("force-kills a public process when its timeout expires after start returns", async () => {
    const processes = manager();
    const record = await processes.startManaged("sleep 30", { timeoutMs: 40 });

    const completion = await record.completion;

    expect(completion).toMatchObject({ timedOut: true, exitSignal: "SIGKILL" });
    expect(record.timedOut).toBe(true);
    expect(record.lastSignal).toBe("SIGKILL");
  });

  it("arbitrates timeout and abort against detachment exactly once", async () => {
    const processes = manager();
    const timed = await processes.startForeground("sleep 30", { timeoutMs: 30 });

    expect(await timed.waitOutcome).toEqual({ type: "timed-out" });
    expect(processes.detachAllForeground()).toEqual([]);
    expect((await timed.completion).timedOut).toBe(true);

    const aborted = await processes.startForeground("sleep 30");
    expect(processes.abortForeground(aborted)).toBe(true);
    expect(processes.abortForeground(aborted)).toBe(false);
    expect(await aborted.waitOutcome).toEqual({ type: "aborted" });
    expect(processes.detachAllForeground()).toEqual([]);
    await aborted.completion;

    expect(processes.foregroundExecutions).toEqual([]);
    expect(processes.records).toEqual([]);
  });
});

describe("stdin, signals, and shutdown", () => {
  it("writes stdin exactly, closes it explicitly, and rejects later writes", async () => {
    const processes = manager();
    const record = await processes.startManaged("cat", { stdin: "pipe" });

    await processes.writeProcess(record.id, "first\n");
    await processes.writeProcess(record.id, "second-without-newline", true);
    await record.completion;

    expect(record.outputStore.readRange(0).content).toBe(
      "first\nsecond-without-newline",
    );
    await expect(processes.writeProcess(record.id, "late")).rejects.toMatchObject({
      kind: "completed",
    });
  });

  it("reports an explicitly closed stdin while the process remains active", async () => {
    const processes = manager();
    const record = await processes.startManaged("cat >/dev/null; sleep 30", {
      stdin: "pipe",
    });

    await processes.writeProcess(record.id, undefined, true);

    await expect(processes.writeProcess(record.id, "late")).rejects.toMatchObject({
      kind: "stdin-closed",
    });
    await processes.signalProcessAndWait(record.id, "SIGKILL");
  });

  it("honors stream backpressure before flushing EOF", async () => {
    const processes = manager();
    const record = await processes.startManaged("sleep 0.03; wc -c", { stdin: "pipe" });
    const data = "x".repeat(1024 * 1024);

    await processes.writeProcess(record.id, data, true);
    await record.completion;

    expect(record.outputStore.readRange(0).content.trim()).toBe(String(data.length));
  });

  it("signals the entire process group and waits for a terminating signal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-proc-signal-test-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "child-terminated");
    const processes = manager({ terminatingSignalWaitMs: 2_000 });
    const record = await processes.startManaged(
      "trap ':' TERM; sh -c \"trap 'touch \\\"$MARKER\\\"; exit 0' TERM; printf child-ready; while :; do sleep 0.05; done\" & wait",
      { env: { ...process.env, MARKER: marker } },
    );
    await waitForOutput(record, "child-ready");

    const result = await processes.signalProcessAndWait(record.id, "TERM");
    await waitUntil(() => existsSync(marker));

    expect(result.signal).toBe("SIGTERM");
    expect(result.sent).toBe(true);
    expect(result.exited).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  it("does not escalate a survived terminating signal", async () => {
    const processes = manager({ terminatingSignalWaitMs: 60 });
    const record = await processes.startManaged(
      "trap '' TERM; printf ready; while :; do sleep 1; done",
    );
    await waitForOutput(record, "ready");

    const term = await processes.signalProcessAndWait(record.id, "SIGTERM");

    expect(term).toMatchObject({ sent: true, exited: false });
    expect(record.completedAt).toBeUndefined();

    const kill = await processes.signalProcessAndWait(record.id, "SIGKILL");
    expect(kill).toMatchObject({ sent: true, exited: true });
  });

  it("ignores unsafe historical IDs without corrupting allocation", async () => {
    const processes = manager();
    processes.registerHistoricalProcess({
      id: `p${Number.MAX_SAFE_INTEGER}`,
      command: "fabricated unsafe history",
    });

    expect(processes.historicalRecords).toEqual([]);
    expect(() => processes.getProcess(`p${Number.MAX_SAFE_INTEGER}`)).toThrowError(
      expect.objectContaining<Partial<ProcessLookupError>>({ kind: "unknown" }),
    );
    const first = await processes.startManaged("true");
    expect(first.id).toBe("p1");
    await first.completion;
  });

  it("distinguishes completed, historical, and unknown process IDs", async () => {
    const processes = manager();
    const record = await processes.startManaged("true");
    await record.completion;
    processes.registerHistoricalProcess({
      id: "p20",
      message: "Process `p20` belonged to a previous runtime and was terminated",
    });

    expect(() => processes.getActiveProcess(record.id)).toThrowError(
      expect.objectContaining<Partial<ProcessStateError>>({ kind: "completed" }),
    );
    expect(() => processes.getProcess("p20")).toThrowError(
      expect.objectContaining<Partial<ProcessLookupError>>({ kind: "historical" }),
    );
    expect(() => processes.getProcess("p999")).toThrowError(
      expect.objectContaining<Partial<ProcessLookupError>>({ kind: "unknown" }),
    );

    const next = await processes.startManaged("true");
    expect(next.id).toBe("p21");
    await next.completion;
  });

  it("contains and reports per-process shutdown signal failures", async () => {
    const processes = manager({ shutdownGraceMs: 30 });
    const first = await processes.startManaged(
      "trap '' TERM; printf first-ready; while :; do sleep 1; done",
    );
    const second = await processes.startManaged(
      "trap '' TERM; printf second-ready; while :; do sleep 1; done",
    );
    await Promise.all([
      waitForOutput(first, "first-ready"),
      waitForOutput(second, "second-ready"),
    ]);

    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -first.pid && signal === "SIGTERM") {
        const error = new Error("Operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return realKill(pid, signal);
    });

    try {
      const result = await processes.shutdown();

      expect(result.signaled).toContain(second.pid);
      expect(result.forceKilled).toContain(first.pid);
      expect(result.signalFailures).toHaveLength(1);
      expect(result.signalFailures[0]).toMatchObject({
        id: first.id,
        pid: first.pid,
        signal: "SIGTERM",
        error: { code: "EPERM" },
      });
    } finally {
      killSpy.mockRestore();
    }
  });

  it("shuts down all groups gracefully, then force-kills survivors", async () => {
    const processes = manager({ shutdownGraceMs: 60 });
    const graceful = await processes.startManaged(
      "trap 'exit 0' TERM; printf graceful-ready; while :; do sleep 1; done",
    );
    const stubborn = await processes.startManaged(
      "trap '' TERM; printf stubborn-ready; while :; do sleep 1; done",
    );
    await Promise.all([
      waitForOutput(graceful, "graceful-ready"),
      waitForOutput(stubborn, "stubborn-ready"),
    ]);

    const calls: Array<{ pid: number; signal: string | number | undefined }> = [];
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -graceful.pid || pid === -stubborn.pid) {
        calls.push({ pid, signal });
      }
      return realKill(pid, signal);
    });
    const result = await processes.shutdown().finally(() => {
      killSpy.mockRestore();
    });
    await Promise.all([graceful.completion, stubborn.completion]);

    expect(calls.slice(0, 2)).toEqual(expect.arrayContaining([
      { pid: -graceful.pid, signal: "SIGTERM" },
      { pid: -stubborn.pid, signal: "SIGTERM" },
    ]));
    expect(calls.findIndex(({ signal }) => signal === "SIGKILL")).toBeGreaterThanOrEqual(2);
    expect(result.signaled).toEqual(
      expect.arrayContaining([graceful.pid, stubborn.pid]),
    );
    expect(result.forceKilled).toContain(stubborn.pid);
    expect(result.signalFailures).toEqual([]);
    expect(graceful.completedAt).toBeDefined();
    expect(stubborn.exitSignal).toBe("SIGKILL");
    await expect(processes.startManaged("true")).rejects.toMatchObject({
      kind: "manager-closed",
    });
  });
});

describe("signal helpers", () => {
  it("normalizes available signals and classifies normal termination", () => {
    expect(normalizeSignal("term")).toBe("SIGTERM");
    expect(isNormallyTerminatingSignal("SIGTERM")).toBe(true);
    expect(isNormallyTerminatingSignal("SIGKILL")).toBe(true);
    expect(isNormallyTerminatingSignal("SIGSTOP")).toBe(false);
    expect(isNormallyTerminatingSignal("SIGIO", "darwin")).toBe(false);
    expect(isNormallyTerminatingSignal("SIGIO", "linux")).toBe(true);
    expect(() => normalizeSignal("not-a-signal")).toThrow(RangeError);
  });
});
