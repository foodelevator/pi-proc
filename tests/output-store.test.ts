import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OutputStore } from "../background-processes/output-store";

interface TestStore {
  store: OutputStore;
  directory: string;
  path: string;
}

const stores: TestStore[] = [];

function makeStore(
  options: ConstructorParameters<typeof OutputStore>[0] = {},
): TestStore {
  const directory = mkdtempSync(join(tmpdir(), "pibg-output-store-test-"));
  const path = join(directory, "output.log");
  const store = new OutputStore({
    createSpillPath: () => path,
    ...options,
  });
  const testStore = { store, directory, path };
  stores.push(testStore);
  return testStore;
}

afterEach(() => {
  for (const { store, directory } of stores.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OutputStore accumulation", () => {
  it("starts empty and returns an empty implicit snapshot", () => {
    const { store } = makeStore();

    expect(store.stats).toEqual({
      totalBytes: 0,
      totalLines: 0,
      deliveredCursor: 0,
      spilled: false,
      memoryRange: { start: 0, end: 0 },
      memoryBytes: 0,
    });
    expect(store.readImplicit()).toMatchObject({
      content: "",
      requestedRange: { start: 0, end: 0 },
      returnedRange: { start: 0, end: 0 },
      omittedRanges: [],
      totalBytes: 0,
      totalLines: 0,
      cursor: { before: 0, after: 0, advanced: true },
    });
  });

  it("combines callback chunks in append order and counts bytes and lines", () => {
    const { store } = makeStore();

    store.append("stdout-1");
    store.append(Buffer.from("stderr-1\n"));
    store.append("stdout-2\nlast");

    expect(store.totalBytes).toBe(30);
    expect(store.totalLines).toBe(3);
    expect(store.readImplicit().content).toBe("stdout-1stderr-1\nstdout-2\nlast");
  });

  it("counts chunk-boundary newlines and a trailing newline consistently", () => {
    const { store } = makeStore();

    store.append("one");
    expect(store.totalLines).toBe(1);
    store.append("\n");
    expect(store.totalLines).toBe(1);
    store.append("\ntwo");
    expect(store.totalLines).toBe(3);
    store.append("\n");
    expect(store.totalLines).toBe(3);
  });

  it("uses UTF-8 byte accounting rather than JavaScript character counts", () => {
    const { store } = makeStore();

    store.append("A😀B");

    expect(store.totalBytes).toBe(6);
    expect(store.readRange(1, 4)).toMatchObject({
      content: "😀",
      returnedRange: { start: 1, end: 5 },
      returnedBytes: 4,
      totalBytes: 6,
    });
  });

  it("copies appended byte arrays so caller mutation cannot alter output", () => {
    const { store } = makeStore();
    const bytes = new Uint8Array(Buffer.from("stable"));

    store.append(bytes);
    bytes.fill(0x78);

    expect(store.readRange(0, 6).content).toBe("stable");
  });
});

describe("OutputStore spill behavior", () => {
  it("uses Pi's 50 KB default byte threshold", () => {
    const { store, path } = makeStore();

    store.append(Buffer.alloc(50 * 1024, 0x78));
    expect(store.spillPath).toBeUndefined();
    store.append("y");

    expect(store.spillPath).toBe(path);
    expect(store.totalBytes).toBe(50 * 1024 + 1);
    expect(store.stats.memoryBytes).toBe(50 * 1024);
  });

  it("uses Pi's 2000-line default threshold", () => {
    const { store, path } = makeStore();

    store.append("x\n".repeat(2000));
    expect(store.spillPath).toBeUndefined();
    store.append("last");

    expect(store.spillPath).toBe(path);
    expect(store.totalLines).toBe(2001);
    expect(store.stats.memoryBytes).toBeLessThan(store.totalBytes);
  });

  it("spills only after the byte threshold is exceeded", () => {
    const { store, path } = makeStore({
      maxInMemoryBytes: 5,
      maxInMemoryLines: 100,
    });

    store.append("12345");
    expect(store.spillPath).toBeUndefined();
    store.append("6");

    expect(store.spillPath).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("123456");
    expect(store.stats).toMatchObject({
      spilled: true,
      memoryBytes: 5,
      memoryRange: { start: 1, end: 6 },
    });
  });

  it("spills only after the line threshold is exceeded", () => {
    const { store, path } = makeStore({
      maxInMemoryBytes: 100,
      maxInMemoryLines: 2,
    });

    store.append("one\ntwo\n");
    expect(store.totalLines).toBe(2);
    expect(store.spillPath).toBeUndefined();
    store.append("three");

    expect(store.spillPath).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\nthree");
    expect(store.stats.memoryBytes).toBe(Buffer.byteLength("two\nthree"));
  });

  it("flushes prior chunks and synchronously appends every later chunk", () => {
    const { store, path } = makeStore({
      maxInMemoryBytes: 4,
      maxInMemoryLines: 100,
    });

    store.append("ab");
    store.append("cde");
    store.append("-stderr");
    store.append("-stdout");

    expect(readFileSync(path, "utf8")).toBe("abcde-stderr-stdout");
    expect(store.readRange(2, 14).content).toBe("cde-stderr-std");
  });

  it("bounds the resident tail by both byte and line limits", () => {
    const { store } = makeStore({
      maxInMemoryBytes: 10,
      maxInMemoryLines: 2,
    });

    store.append("0123456789\na\nb\nc");

    expect(store.stats.memoryBytes).toBeLessThanOrEqual(10);
    expect(store.stats.memoryRange).toEqual({ start: 13, end: 16 });
    expect(store.readRange(13, 3).content).toBe("b\nc");
  });

  it("keeps spill files after close and can still range-read them", () => {
    const { store, path } = makeStore({
      maxInMemoryBytes: 3,
      maxInMemoryLines: 100,
    });
    store.append("persistent output");

    store.close();

    expect(existsSync(path)).toBe(true);
    expect(store.readRange(0, 10).content).toBe("persistent");
    expect(() => store.append("nope")).toThrow("closed output store");
    store.close();
  });
});

describe("OutputStore implicit reads", () => {
  it("reads unread output and advances the delivered cursor to a fixed snapshot", () => {
    const { store } = makeStore();
    store.append("first");

    const first = store.readImplicit();
    store.append("-second");
    const second = store.readImplicit();

    expect(first).toMatchObject({
      content: "first",
      snapshotEnd: 5,
      cursor: { before: 0, after: 5, advanced: true },
    });
    expect(second).toMatchObject({
      content: "-second",
      requestedRange: { start: 5, end: 12 },
      cursor: { before: 5, after: 12, advanced: true },
    });
  });

  it("returns the byte-capped tail, reports the omitted prefix, and advances past it", () => {
    const { store } = makeStore({ maxReadBytes: 5, maxReadLines: 100 });
    store.append("0123456789");

    const result = store.readImplicit(99);

    expect(result).toMatchObject({
      content: "56789",
      requestedRange: { start: 0, end: 10 },
      returnedRange: { start: 5, end: 10 },
      omittedRanges: [{ start: 0, end: 5 }],
      truncation: { truncated: true, by: ["bytes"], omittedBytes: 5 },
      cursor: { before: 0, after: 10, advanced: true },
    });
    expect(store.readImplicit().content).toBe("");
  });

  it("returns the last complete lines and reports line truncation", () => {
    const { store } = makeStore({ maxReadBytes: 100, maxReadLines: 2 });
    store.append("one\ntwo\nthree\n");

    const result = store.readImplicit();

    expect(result).toMatchObject({
      content: "two\nthree\n",
      requestedRange: { start: 0, end: 14 },
      returnedRange: { start: 4, end: 14 },
      omittedRanges: [{ start: 0, end: 4 }],
      truncation: { truncated: true, by: ["lines"], omittedBytes: 4 },
      returnedLines: 2,
    });
  });

  it("reports both byte and line limits when both shorten the unread range", () => {
    const { store } = makeStore({ maxReadBytes: 8, maxReadLines: 2 });
    store.append("old\na\nb\nc\n");

    expect(store.readImplicit()).toMatchObject({
      content: "b\nc\n",
      returnedRange: { start: 6, end: 10 },
      omittedRanges: [{ start: 0, end: 6 }],
      truncation: { truncated: true, by: ["bytes", "lines"], omittedBytes: 6 },
    });
  });

  it("honors a smaller per-read length without changing the configured ceiling", () => {
    const { store } = makeStore({ maxReadBytes: 10, maxReadLines: 100 });
    store.append("abcdef");

    expect(store.readImplicit(3)).toMatchObject({
      content: "def",
      returnedRange: { start: 3, end: 6 },
      cursor: { after: 6 },
    });
  });
});

describe("OutputStore explicit reads", () => {
  it("reads forward from start without modifying the implicit cursor", () => {
    const { store } = makeStore({ maxReadBytes: 4, maxReadLines: 100 });
    store.append("0123456789");

    const explicit = store.readRange(2);

    expect(explicit).toMatchObject({
      content: "2345",
      requestedRange: { start: 2, end: 6 },
      returnedRange: { start: 2, end: 6 },
      omittedRanges: [],
      cursor: { before: 0, after: 0, advanced: false },
    });
    expect(store.deliveredCursor).toBe(0);
    expect(store.readImplicit().content).toBe("6789");
  });

  it("caps an oversized explicit length and reports the omitted suffix", () => {
    const { store } = makeStore({ maxReadBytes: 5, maxReadLines: 100 });
    store.append("0123456789");

    expect(store.readRange(1, 9)).toMatchObject({
      content: "12345",
      requestedRange: { start: 1, end: 10 },
      returnedRange: { start: 1, end: 6 },
      omittedRanges: [{ start: 6, end: 10 }],
      truncation: { truncated: true, by: ["bytes"], omittedBytes: 4 },
    });
  });

  it("keeps the head for line-capped forward reads", () => {
    const { store } = makeStore({ maxReadBytes: 100, maxReadLines: 2 });
    store.append("one\ntwo\nthree");

    expect(store.readRange(0, 13)).toMatchObject({
      content: "one\ntwo\n",
      returnedRange: { start: 0, end: 8 },
      omittedRanges: [{ start: 8, end: 13 }],
      truncation: { truncated: true, by: ["lines"], omittedBytes: 5 },
      returnedLines: 2,
    });
  });

  it("returns empty ranges at EOF, beyond EOF, and for zero length", () => {
    const { store } = makeStore();
    store.append("abc");

    expect(store.readRange(3)).toMatchObject({
      content: "",
      requestedRange: { start: 3, end: 3 },
      returnedRange: { start: 3, end: 3 },
    });
    expect(store.readRange(10)).toMatchObject({
      requestedRange: { start: 10, end: 10 },
      returnedRange: { start: 10, end: 10 },
    });
    expect(store.readRange(1, 0)).toMatchObject({
      requestedRange: { start: 1, end: 1 },
      returnedRange: { start: 1, end: 1 },
    });
  });
});

describe("OutputStore validation", () => {
  it("rejects invalid limits and ranges", () => {
    expect(() => new OutputStore({ maxReadBytes: 0 })).toThrow(RangeError);
    expect(() => new OutputStore({ maxInMemoryLines: 1.5 })).toThrow(RangeError);

    const { store } = makeStore();
    expect(() => store.readRange(-1)).toThrow("start");
    expect(() => store.readRange(0, -1)).toThrow("length");
    expect(() => store.readRange(Number.MAX_SAFE_INTEGER + 1)).toThrow("start");
  });
});
