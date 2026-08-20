import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const writeFailure = vi.hoisted(() => ({
  enabled: false,
  partialWritten: false,
  positions: [] as number[],
}));

vi.mock("node:fs", async (importOriginal) => {
  // Dynamic import typing is required here because this module is itself being mocked.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync(
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number,
    ): number {
      writeFailure.positions.push(position);
      if (!writeFailure.enabled) {
        return actual.writeSync(fd, buffer, offset, length, position);
      }
      if (!writeFailure.partialWritten) {
        writeFailure.partialWritten = true;
        const partialLength = Math.min(2, length);
        return actual.writeSync(fd, buffer, offset, partialLength, position);
      }

      writeFailure.enabled = false;
      const error = new Error("No space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    },
  };
});

const { OutputStore } = await import("../background-processes/output-store");

const directories: string[] = [];

afterEach(() => {
  writeFailure.enabled = false;
  writeFailure.partialWritten = false;
  writeFailure.positions.length = 0;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OutputStore spill write failures", () => {
  it("keeps logical offsets aligned after a partial write followed by ENOSPC", () => {
    const directory = mkdtempSync(join(tmpdir(), "pibg-write-failure-test-"));
    directories.push(directory);
    const path = join(directory, "output.log");
    const store = new OutputStore({
      maxInMemoryBytes: 4,
      maxInMemoryLines: 100,
      createSpillPath: () => path,
    });

    store.append("AAAA-");
    writeFailure.enabled = true;
    expect(() => store.append("BBBBBBBB")).toThrowError(
      expect.objectContaining({ code: "ENOSPC" }),
    );
    expect(store.totalBytes).toBe(5);

    store.append("CCCC");

    expect(writeFailure.positions).toEqual([0, 5, 7, 5]);
    expect(store.totalBytes).toBe(9);
    expect(readFileSync(path, "utf8")).toBe("AAAA-CCCC");
    expect(store.readRange(0, 100).content).toBe("AAAA-CCCC");
    store.close();
  });
});
