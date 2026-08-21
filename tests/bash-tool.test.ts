import { existsSync, rmSync } from "node:fs";

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
  createWaitBashTool,
} from "../background-processes/tools/bash";

const managers: ProcessManager[] = [];
const spillPaths: string[] = [];
const context = {} as ExtensionContext;

function makeManager(
  options: ConstructorParameters<typeof ProcessManager>[0] = {},
): ProcessManager {
  const manager = new ProcessManager({ pipeIdleMs: 50, ...options });
  managers.push(manager);
  return manager;
}

function toolFor(manager: ProcessManager) {
  return createWaitBashTool({ getManager: () => manager });
}

async function execute(
  manager: ProcessManager,
  params: { command: string; mode?: "wait" | "background" | "monitor"; timeout?: number },
  signal?: AbortSignal,
  onUpdate?: (result: AgentToolResult<BashToolDetails | undefined>) => void,
) {
  return toolFor(manager).execute(
    "tool-call",
    params,
    signal,
    onUpdate,
    context,
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
});

describe("bash override schema", () => {
  it("publishes the final command/mode/timeout shape", () => {
    expect(bashSchema.required).toEqual(["command"]);
    expect(Object.keys(bashSchema.properties)).toEqual([
      "command",
      "mode",
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
      expect(modeDescription).toContain("not implemented yet");
    }
  });

  it.each(["background", "monitor"] as const)(
    "fails clearly for deferred %s behavior",
    async (mode) => {
      const manager = makeManager();
      await expect(execute(manager, { command: "true", mode })).rejects.toThrow(
        `Bash mode \`${mode}\` is not implemented yet`,
      );
      expect(manager.records).toHaveLength(0);
    },
  );
});

describe("wait-compatible bash execution", () => {
  it("defaults to a private wait and returns Pi's successful result shape", async () => {
    const manager = makeManager();

    const result = await execute(manager, { command: "printf hello" });

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
