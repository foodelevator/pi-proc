import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverAndLoadExtensions,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("extension loading", () => {
  it("loads the package, creates a session manager, and executes the bash override", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pibg-extension-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pibg-extension-agent-"));
    const sessionFile = join(cwd, "session.jsonl");
    const ctx = {
      cwd,
      mode: "tui",
      sessionManager: {
        getSessionId: () => "session-load-test",
        getSessionFile: () => sessionFile,
      },
      model: { provider: "test-provider", id: "test-model" },
      thinkingLevel: "high",
    } as unknown as ExtensionContext;
    let extension: Awaited<
      ReturnType<typeof discoverAndLoadExtensions>
    >["extensions"][number] | undefined;

    try {
      const result = await discoverAndLoadExtensions(
        [process.cwd()],
        cwd,
        agentDir,
      );
      expect(result.errors).toEqual([]);
      expect(result.extensions).toHaveLength(1);
      extension = result.extensions[0];
      const bash = extension?.tools.get("bash")?.definition;
      expect([...(extension?.tools.keys() ?? [])]).toEqual([
        "bash",
        "process_read",
        "process_write",
        "process_kill",
        "process_list",
      ]);
      expect(bash).toBeDefined();
      expect(bash?.parameters).toMatchObject({
        required: ["command"],
        properties: {
          mode: { enum: ["wait", "background", "monitor"] },
        },
      });
      expect(extension?.tools.get("process_kill")?.definition.parameters)
        .toMatchObject({
          required: ["id"],
          properties: { signal: { type: "string" } },
        });
      if (bash === undefined) throw new Error("bash override was not loaded");

      await expect(
        bash.execute(
          "before-start",
          { command: "true" },
          undefined,
          undefined,
          {} as ExtensionContext,
        ),
      ).rejects.toThrow("unavailable for this session");

      const start = extension?.handlers.get("session_start")?.[0];
      if (start === undefined) throw new Error("session_start was not registered");
      await start({ type: "session_start", reason: "startup" }, ctx);

      const execution = await bash.execute(
        "after-start",
        {
          command:
            "printf '%s|%s|%s|%s|%s|%s' \"$PWD\" \"$PI_SESSION_ID\" \"$PI_SESSION_FILE\" \"$PI_PROVIDER\" \"$PI_MODEL\" \"$PI_REASONING_LEVEL\"",
        },
        undefined,
        undefined,
        ctx,
      );

      expect(execution).toEqual({
        content: [{
          type: "text",
          text: `${realpathSync(cwd)}|session-load-test|${sessionFile}|test-provider|test-model|high`,
        }],
        details: undefined,
      });

      const detached = await bash.execute(
        "managed-load-smoke",
        { command: "true", mode: "monitor" },
        undefined,
        undefined,
        ctx,
      );
      expect(detached.details).toMatchObject({
        process: { kind: "started", id: "p1", mode: "monitor" },
      });

      const shutdown = extension?.handlers.get("session_shutdown")?.[0];
      if (shutdown === undefined) {
        throw new Error("session_shutdown was not registered");
      }
    } finally {
      try {
        const shutdown = extension?.handlers.get("session_shutdown")?.[0];
        if (shutdown !== undefined) {
          await shutdown({ type: "session_shutdown", reason: "quit" }, ctx);
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    }
  });
});
