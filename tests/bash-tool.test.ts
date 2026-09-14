import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBashToolDefinition,
  type AgentToolResult,
  type BashToolDetails,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { ProcessManager } from "../background-processes/process-manager";
import {
  bashSchema,
  createBashTool,
  type BackgroundBashToolDetails,
  type BackgroundBashToolInput,
} from "../background-processes/tools/bash";

const managers: ProcessManager[] = [];
const spillPaths: string[] = [];
const temporaryDirectories: string[] = [];
const context = { mode: "tui" } as ExtensionContext;

function contextFor(mode: ExtensionContext["mode"]): ExtensionContext {
  // Minimal execution context fixture; the tool reads only mode in these tests.
  return { ...context, mode };
}

function makeManager(
  options: ConstructorParameters<typeof ProcessManager>[0] = {},
): ProcessManager {
  const manager = new ProcessManager({ pipeIdleMs: 50, ...options });
  managers.push(manager);
  return manager;
}

function toolFor(manager: ProcessManager) {
  return createBashTool({ getManager: () => manager });
}

async function execute(
  manager: ProcessManager,
  params: BackgroundBashToolInput,
  signal?: AbortSignal,
  onUpdate?: (result: AgentToolResult<BackgroundBashToolDetails | undefined>) => void,
  executionContext: ExtensionContext = context,
) {
  return toolFor(manager).execute(
    "tool-call",
    params,
    signal,
    onUpdate,
    executionContext,
  );
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

afterEach(async () => {
  await Promise.all(managers.splice(0).map(async (manager) => manager.shutdown()));
  for (const path of spillPaths.splice(0)) rmSync(path, { force: true });
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("bash override schema", () => {
  it("publishes the command/mode/stdin/timeout shape", () => {
    expect(bashSchema.required).toEqual(["command"]);
    expect(Object.keys(bashSchema.properties)).toEqual([
      "command",
      "mode",
      "stdin",
      "timeout",
    ]);
    const modeSchema = bashSchema.properties.mode as unknown as Record<
      string,
      unknown
    >;
    expect(modeSchema).toMatchObject({
      type: "string",
      enum: ["wait", "background", "monitor"],
    });
    const modeDescription = modeSchema.description;
    expect(modeDescription).toBeTypeOf("string");
    if (typeof modeDescription === "string") {
      expect(modeDescription).toContain("no other work needs to happen");
      expect(modeDescription).toContain("useful work can happen concurrently");
      expect(modeDescription).toContain(
        "only when ongoing stdout activity must be observed and acted upon",
      );
      expect(modeDescription).toContain(
        "never choose it merely because a command may take a long time",
      );
      expect(modeDescription).toContain("return a managed process ID immediately");
      expect(modeDescription).toContain("process_read");
      expect(modeDescription).toContain("process_kill");
      expect(modeDescription).toContain("do not routinely poll");
    }

    const tool = createBashTool({ getManager: () => undefined });
    expect(tool.description).toContain(
      "use process_read, process_write, process_kill, and process_list when deliberate management is needed",
    );
    expect(tool.description).toContain(
      "Background processes automatically notify on completion",
    );
    expect(tool.description).toContain(
      "monitor processes also notify on stdout activity",
    );
    expect(tool.description).toContain(
      "Do not routinely poll managed processes with process_read or sleep commands",
    );
    expect(tool.promptGuidelines).toContain(
      "Choose wait or background based on whether useful work should happen concurrently, not based on command duration. Use monitor only when ongoing output must be observed and acted upon. Do not routinely poll managed processes; rely on automatic notifications unless the user explicitly requests a status check.",
    );
  });
});

describe("bash stdin defaults", () => {
  it.each([undefined, "background", "monitor"] as const)(
    "searches files with bare rg in mode %s without waiting for stdin",
    async (mode) => {
      const cwd = mkdtempSync(join(tmpdir(), "pi-proc-rg-"));
      temporaryDirectories.push(cwd);
      writeFileSync(join(cwd, "fixture.txt"), "use from-file\n");
      const manager = makeManager({ cwd });

      const result = await execute(manager, {
        command: "rg 'use'",
        ...(mode === undefined ? {} : { mode }),
        timeout: 1,
      });
      const descriptor = result.details?.process;
      if (mode === undefined) {
        expect(result.content).toEqual([{
          type: "text",
          text: "fixture.txt:use from-file\n",
        }]);
      } else {
        if (descriptor === undefined) throw new Error("Expected process ID");
        const record = manager.getProcess(descriptor.id);
        expect(await record.completion).toMatchObject({
          exitCode: 0,
          timedOut: false,
        });
        expect(record.outputStore.readRange(0).content).toBe(
          "fixture.txt:use from-file\n",
        );
      }
    },
  );

  it.each([
    ["printf 'use from-pipe\\n' | rg 'use'", "use from-pipe\n"],
    ["rg 'use' < fixture.txt", "use from-file\n"],
    ["rg 'use' <<'EOF'\nuse from-heredoc\nEOF", "use from-heredoc\n"],
  ])("preserves shell-provided input: %s", async (command, output) => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-proc-redirect-"));
    temporaryDirectories.push(cwd);
    writeFileSync(join(cwd, "fixture.txt"), "use from-file\n");
    const manager = makeManager({ cwd });

    const result = await execute(manager, { command, timeout: 1 });

    expect(result.content).toEqual([{ type: "text", text: output }]);
  });
});

describe("managed bash execution", () => {
  it.each(["background", "monitor"] as const)(
    "returns a stable started descriptor for %s mode",
    async (mode) => {
      const manager = makeManager();

      const result = await execute(manager, {
        command: "printf ready; sleep 0.03",
        mode,
      });
      const descriptor = result.details?.process;

      const content = result.content[0];
      if (content?.type !== "text") throw new Error("Expected text result");
      expect(content.text).toMatch(
        /^Started (background|monitor) process `p1` \(PID \d+\)\.$/,
      );
      expect(content.text).toContain(`Started ${mode} process`);
      expect(descriptor).toMatchObject({
        kind: "started",
        id: "p1",
        mode,
        command: "printf ready; sleep 0.03",
        cwd: process.cwd(),
      });
      expect(descriptor?.pid).toBeTypeOf("number");
      expect(descriptor?.startedAt).toBeTypeOf("number");
      expect(descriptor).not.toHaveProperty("completedAt");
      expect(manager.getProcess("p1")).toBeDefined();
      await manager.getProcess("p1").completion;
    },
  );

  it("returns while a background process remains active and independently writable", async () => {
    const manager = makeManager();

    const result = await execute(manager, {
      command: "read line; printf 'received:%s' \"$line\"",
      mode: "background",
      stdin: "pipe",
    });
    const id = result.details?.process?.id;
    if (id === undefined) throw new Error("Expected process ID");
    const record = manager.getProcess(id);

    expect(record.completedAt).toBeUndefined();
    expect(manager.activeRecords).toContain(record);
    expect(() => process.kill(-record.pid, 0)).not.toThrow();

    await manager.writeProcess(id, "after-return\n", true);
    await record.completion;
    expect(record.outputStore.readRange(0).content).toBe(
      "received:after-return",
    );
  });

  it("emits monitor activity for stdout produced after the tool returns", async () => {
    const manager = makeManager();
    const events: string[] = [];
    manager.subscribeEvents((event) => {
      events.push(`${event.type}:${event.process.id}`);
    });

    const result = await execute(manager, {
      command: "read line; printf 'late:%s' \"$line\"",
      mode: "monitor",
      stdin: "pipe",
    });
    const id = result.details?.process?.id;
    if (id === undefined) throw new Error("Expected process ID");
    const record = manager.getProcess(id);

    expect(record.completedAt).toBeUndefined();
    expect(events).toEqual([]);

    await manager.writeProcess(id, "stdout-after-return\n", true);
    await waitUntil(() => events.includes(`stdout-activity:${id}`));
    await record.completion;

    expect(events).toEqual([
      `stdout-activity:${id}`,
      `completed:${id}`,
    ]);
    expect(record.outputStore.readRange(0).content).toBe(
      "late:stdout-after-return",
    );
  });

  it("returns a started descriptor for a fast exit and retains its completion", async () => {
    const manager = makeManager();
    const events: string[] = [];
    manager.subscribeEvents((event) => {
      events.push(`${event.type}:${event.process.id}`);
    });

    const result = await execute(manager, {
      command: "printf fast",
      mode: "background",
    });
    const descriptor = result.details?.process;
    if (descriptor === undefined) throw new Error("Expected process descriptor");
    const record = manager.getProcess(descriptor.id);
    await record.completion;

    expect(descriptor).toMatchObject({ kind: "started", id: "p1" });
    expect(record.completedAt).toBeDefined();
    expect(record.outputStore.readRange(0).content).toBe("fast");
    expect(events).toEqual(["completed:p1"]);
  });

  it("keeps a detached timeout active after returning the tool result", async () => {
    const manager = makeManager();

    const result = await execute(manager, {
      command: "sleep 30",
      mode: "background",
      timeout: 0.04,
    });
    expect(result.details?.process).toMatchObject({
      id: "p1",
      timeoutSeconds: 0.04,
    });

    const completion = await manager.getProcess("p1").completion;
    expect(completion).toMatchObject({ timedOut: true, exitSignal: "SIGKILL" });
  });

  it("rejects detached execution cleanly when called without an extension context", async () => {
    const manager = makeManager();

    await expect(toolFor(manager).execute(
      "context-free-call",
      { command: "true", mode: "background" },
      undefined,
      undefined,
      undefined as unknown as ExtensionContext,
    )).rejects.toThrow(
      "available only in TUI and RPC modes; current mode is `undefined`",
    );
    expect(manager.records).toHaveLength(0);
  });

  it.each(["print", "json"] as const)(
    "rejects detached execution in %s mode without spawning",
    async (extensionMode) => {
      const manager = makeManager();

      await expect(execute(
        manager,
        { command: "true", mode: "background" },
        undefined,
        undefined,
        contextFor(extensionMode),
      )).rejects.toThrow(
        `available only in TUI and RPC modes; current mode is \`${extensionMode}\``,
      );
      expect(manager.records).toHaveLength(0);
    },
  );

  it.each(["print", "json"] as const)(
    "preserves ordinary wait execution in %s mode",
    async (extensionMode) => {
      const manager = makeManager();

      const result = await execute(
        manager,
        { command: "printf headless-wait" },
        undefined,
        undefined,
        contextFor(extensionMode),
      );

      expect(result).toEqual({
        content: [{ type: "text", text: "headless-wait" }],
        details: undefined,
      });
      expect(manager.records).toHaveLength(0);
    },
  );

  it("accepts detached execution in RPC mode", async () => {
    const manager = makeManager();

    const result = await execute(
      manager,
      { command: "true", mode: "monitor" },
      undefined,
      undefined,
      contextFor("rpc"),
    );

    expect(result.details?.process).toMatchObject({ id: "p1", mode: "monitor" });
    await manager.getProcess("p1").completion;
  });

  it("allocates unique IDs for parallel detached tool calls", async () => {
    const manager = makeManager();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => execute(manager, {
        command: `printf ${index}`,
        mode: index % 2 === 0 ? "background" : "monitor",
      })),
    );

    expect(results.map((result) => result.details?.process?.id).sort()).toEqual(
      ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
    );
    await Promise.all(manager.records.map(async (record) => record.completion));
  });
});

describe("steering-detached wait execution", () => {
  it("returns output so far, advances its cursor, and ignores later tool abort", async () => {
    const manager = makeManager();
    const controller = new AbortController();
    const completionEvents: string[] = [];
    manager.subscribeEvents((event) => {
      if (event.type === "completed") completionEvents.push(event.process.id);
    });

    const running = execute(
      manager,
      { command: "printf ready; read ignored; printf later", stdin: "pipe" },
      controller.signal,
    );
    await waitUntil(() => {
      const foreground = manager.foregroundExecutions[0];
      return foreground?.outputStore.readRange(0).content === "ready";
    });

    const [record] = manager.detachAllForeground();
    if (record === undefined) throw new Error("Expected detached process");
    controller.abort();
    const result = await running;

    expect(result.details?.process).toMatchObject({
      kind: "started",
      reason: "detached_by_steering",
      id: "p1",
      mode: "background",
    });
    expect(result.details?.output).toMatchObject({
      content: "ready",
      requestedRange: { start: 0, end: 5 },
      returnedRange: { start: 0, end: 5 },
      omittedRanges: [],
      cursor: { before: 0, after: 5, advanced: true },
      totalBytes: 5,
    });
    expect(result.content).toEqual([{
      type: "text",
      text:
        `Detached foreground command as background process \`p1\` (PID ${record.pid}) due to steering.\n\nOutput so far:\nready`,
    }]);
    expect(record.outputStore.deliveredCursor).toBe(5);
    expect(record.completedAt).toBeUndefined();
    expect(() => process.kill(-record.pid, 0)).not.toThrow();

    await manager.writeProcess(record.id, "release\n", true);
    await record.completion;
    expect(record.outputStore.readImplicit().content).toBe("later");
    expect(completionEvents).toEqual(["p1"]);
    expect(manager.foregroundExecutions).toEqual([]);
    expect(manager.records).toEqual([record]);
  });

  it("keeps the original timeout active after steering returns", async () => {
    const manager = makeManager();
    const running = execute(manager, {
      command: "printf ready; sleep 30",
      timeout: 0.15,
    });
    await waitUntil(() =>
      manager.foregroundExecutions[0]?.outputStore.readRange(0).content
        === "ready"
    );

    const [record] = manager.detachAllForeground();
    if (record === undefined) throw new Error("Expected detached process");
    const result = await running;

    expect(result.details?.process).toMatchObject({
      reason: "detached_by_steering",
      timeoutSeconds: 0.15,
    });
    expect(record.completedAt).toBeUndefined();
    await expect(manager.writeProcess(record.id, "input\n")).rejects.toMatchObject({
      kind: "stdin-disabled",
    });
    expect(await record.completion).toMatchObject({
      timedOut: true,
      exitSignal: "SIGKILL",
    });
    expect(record.lastSignal).toBe("SIGKILL");
  });
});

describe("wait-compatible bash execution", () => {
  it("defaults to a private wait and returns Pi's successful result shape", async () => {
    const manager = makeManager();

    const result = await execute(manager, { command: "printf hello", stdin: "ignore" });

    expect(result).toEqual({
      content: [{ type: "text", text: "hello" }],
      details: undefined,
    });
    expect(manager.records).toHaveLength(0);
    expect(manager.foregroundExecutions).toHaveLength(0);
  });

  it("streams combined output through throttled Pi-shaped updates", async () => {
    const manager = makeManager();
    const updates: AgentToolResult<BashToolDetails | undefined>[] = [];

    const result = await execute(
      manager,
      {
        command:
          "printf out-1; sleep 0.02; printf err-1 >&2; sleep 0.02; printf out-2; sleep 0.02; printf err-2 >&2",
      },
      undefined,
      (update) => updates.push(update),
    );

    expect(updates[0]).toEqual({ content: [], details: undefined });
    const streamed = updates
      .slice(1)
      .map((update) => update.content[0])
      .filter((content) => content?.type === "text")
      .map((content) => content.text);
    expect(streamed.at(-1)).toBe("out-1err-1out-2err-2");
    expect(updates.length).toBeLessThan(5);
    expect(result.content).toEqual([
      { type: "text", text: "out-1err-1out-2err-2" },
    ]);
  });

  it("returns tail truncation details and a persistent spill path", async () => {
    const manager = makeManager();

    const result = await execute(manager, {
      command: "printf '%060000d' 0 | tr ' ' x",
    });
    const details = result.details;
    if (details?.fullOutputPath === undefined) {
      throw new Error("Expected spilled bash output");
    }
    spillPaths.push(details.fullOutputPath);

    expect(details.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "bytes",
      totalLines: 1,
      totalBytes: 60_000,
      outputLines: 1,
      outputBytes: 50 * 1024,
      lastLinePartial: true,
      maxLines: 2000,
      maxBytes: 50 * 1024,
    });
    expect(existsSync(details.fullOutputPath)).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("[Showing last 50.0KB of line 1");
    expect(text).toContain(`Full output: ${details.fullOutputPath}]`);
    expect(manager.records).toHaveLength(0);
  });

  it("reports Pi-compatible line truncation metadata", async () => {
    const manager = makeManager();

    const result = await execute(manager, {
      command: "for i in {1..2101}; do printf 'line\\n'; done",
    });
    const details = result.details;
    if (details?.fullOutputPath === undefined) {
      throw new Error("Expected line-spilled bash output");
    }
    spillPaths.push(details.fullOutputPath);

    expect(details.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 2101,
      outputLines: 2000,
      outputBytes: 9_999,
      lastLinePartial: false,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("[Showing lines 102-2101 of 2101.");
  });

  it("matches Pi for a byte-over-limit line ending in a newline", async () => {
    const manager = makeManager();

    const result = await execute(manager, {
      command: "printf '%051200d\\n' 0",
    });
    const details = result.details;
    if (details?.fullOutputPath === undefined) {
      throw new Error("Expected newline-terminated spilled output");
    }
    spillPaths.push(details.fullOutputPath);

    expect(details.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      totalLines: 1,
      totalBytes: 50 * 1024 + 1,
      outputLines: 1,
      outputBytes: 50 * 1024,
      lastLinePartial: false,
    });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("[Showing lines 1-1 of 1.");
    expect(text).not.toContain("line is 0B");
    expect(text).not.toContain("\n\n\n[Showing");
  });

  it("throws with captured output for a nonzero exit", async () => {
    const manager = makeManager();

    await expect(
      execute(manager, { command: "printf bad >&2; exit 7" }),
    ).rejects.toThrow("bad\n\nCommand exited with code 7");
    expect(manager.records).toHaveLength(0);
  });

  it("throws with captured output when the wait times out", async () => {
    const manager = makeManager();

    await expect(
      execute(manager, {
        command: "printf ready; sleep 30",
        timeout: 0.04,
      }),
    ).rejects.toThrow("ready\n\nCommand timed out after 0.04 seconds");
    expect(manager.records).toHaveLength(0);
  });

  it("kills the process group and throws with captured output on cancellation", async () => {
    const manager = makeManager();
    const controller = new AbortController();
    const updates: AgentToolResult<BashToolDetails | undefined>[] = [];
    const running = execute(
      manager,
      { command: "printf ready; sleep 30" },
      controller.signal,
      (update) => updates.push(update),
    );
    await waitUntil(() => updates.some((update) =>
      update.content.some((content) =>
        content.type === "text" && content.text.includes("ready")
      )
    ));

    controller.abort();

    await expect(running).rejects.toThrow("ready\n\nCommand aborted");
    expect(manager.records).toHaveLength(0);
    expect(manager.foregroundExecutions).toHaveLength(0);
  });

  it("throws spawn failures instead of returning an error-shaped success", async () => {
    const manager = makeManager({
      shellConfig: { shell: "/definitely/not/a/shell", args: ["-c"] },
    });

    await expect(execute(manager, { command: "true" })).rejects.toThrow(
      "Failed to spawn command `true`",
    );
    expect(manager.records).toHaveLength(0);
  });

  it("uses Pi-compatible timeout validation", async () => {
    const manager = makeManager();

    await expect(
      execute(manager, { command: "true", timeout: 0 }),
    ).rejects.toThrow("Invalid timeout: must be a finite number of seconds");
    await expect(
      execute(manager, { command: "true", timeout: 3_000_000 }),
    ).rejects.toThrow("Invalid timeout: maximum");
  });
});

function normalizeSpillResult(
  result: AgentToolResult<BashToolDetails | undefined>,
): AgentToolResult<BashToolDetails | undefined> {
  const path = result.details?.fullOutputPath;
  return {
    content: result.content.map((content) =>
      content.type === "text" && path !== undefined
        ? { ...content, text: content.text.replaceAll(path, "<spill>") }
        : content
    ),
    details: result.details === undefined
      ? undefined
      : {
          ...result.details,
          ...(path === undefined ? {} : { fullOutputPath: "<spill>" }),
        },
  };
}

describe("Pi bash differential regressions", () => {
  it.each([
    [
      "line-limited trailing newline",
      "for i in {1..2101}; do printf 'line\\n'; done",
    ],
    ["single byte-over-limit terminated line", "printf '%051200d\\n' 0"],
    [
      "byte-limited UTF-8 lines",
      "for i in {1..3000}; do printf '😀-line-%s\\n' \"$i\"; done",
    ],
  ])("matches Pi exactly for %s", async (_name, command) => {
    const manager = makeManager();
    const ours = await execute(manager, { command });
    const piTool = createBashToolDefinition(process.cwd(), {
      exposeSessionEnvironment: false,
    });
    const pi = await piTool.execute(
      "pi-tool-call",
      { command },
      undefined,
      undefined,
      context,
    );

    for (const path of [
      ours.details?.fullOutputPath,
      pi.details?.fullOutputPath,
    ]) {
      if (path !== undefined) spillPaths.push(path);
    }
    expect(normalizeSpillResult(ours)).toEqual(normalizeSpillResult(pi));
  });
});
