import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("real Pi runtime loading", () => {
  it("loads and executes the override through AgentSession tool precedence", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pibg-real-load-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pibg-real-load-agent-"));
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [process.cwd()],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;

    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const created = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["bash"],
      });
      session = created.session;
      await session.bindExtensions({});

      const bash = session.state.tools.find((tool) => tool.name === "bash");
      if (bash === undefined) throw new Error("bash was not active");
      expect(bash.parameters).toMatchObject({
        properties: {
          mode: {
            type: "string",
            enum: ["wait", "background", "monitor"],
          },
        },
      });
      expect(session.systemPrompt).toContain(
        "Execute bash commands (ls, grep, find, etc.)",
      );

      const result = await bash.execute("real-load-smoke", {
        command: "printf real-load-ok",
      });
      expect(result).toEqual({
        content: [{ type: "text", text: "real-load-ok" }],
        details: undefined,
      });
      await expect(
        bash.execute("real-load-background", {
          command: "true",
          mode: "background",
        }),
      ).rejects.toThrow("not implemented yet");

      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
    } finally {
      session?.dispose();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
