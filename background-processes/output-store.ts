import { randomBytes } from "node:crypto";
import {
  closeSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

import type {
  ByteRange,
  OutputReadOptions,
  OutputReadResult,
  OutputStoreOptions,
  OutputStoreStats,
  OutputTruncationReason,
} from "./types";

const NEWLINE = 0x0a;

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;

  let lines = buffer[buffer.length - 1] === NEWLINE ? 0 : 1;
  for (const byte of buffer) {
    if (byte === NEWLINE) lines++;
  }
  return lines;
}

function suffixStartForLineLimit(buffer: Buffer, maxLines: number): number {
  const linesToDrop = countLines(buffer) - maxLines;
  if (linesToDrop <= 0) return 0;

  let remaining = linesToDrop;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== NEWLINE) continue;
    remaining--;
    if (remaining === 0) return index + 1;
  }

  return buffer.length;
}

function prefixEndForLineLimit(buffer: Buffer, maxLines: number): number {
  if (countLines(buffer) <= maxLines) return buffer.length;

  let lines = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== NEWLINE) continue;
    lines++;
    if (lines === maxLines) return index + 1;
  }

  return buffer.length;
}

function nonEmptyRange(start: number, end: number): ByteRange[] {
  return start < end ? [{ start, end }] : [];
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

/**
 * Combined, append-only process output with bounded memory and byte-addressed reads.
 *
 * All mutation and file I/O is synchronous. An append or read therefore observes one
 * complete state transition on Node's event loop, which gives each read a fixed and
 * internally consistent snapshot while stdout/stderr callbacks continue to arrive.
 */
export class OutputStore {
  readonly #maxInMemoryBytes: number;
  readonly #maxInMemoryLines: number;
  readonly #maxReadBytes: number;
  readonly #maxReadLines: number;
  readonly #tempDirectory: string;
  readonly #tempFilePrefix: string;
  readonly #createSpillPath?: () => string;

  #memoryChunks: Buffer[] = [];
  #tail: Buffer = Buffer.alloc(0);
  #tailStart = 0;
  #totalBytes = 0;
  #newlineCount = 0;
  #lastByte: number | undefined;
  #deliveredCursor = 0;
  #spillPath: string | undefined;
  #spillFd: number | undefined;
  #closed = false;

  constructor(options: OutputStoreOptions = {}) {
    this.#maxInMemoryBytes = requirePositiveInteger(
      options.maxInMemoryBytes ?? DEFAULT_MAX_BYTES,
      "maxInMemoryBytes",
    );
    this.#maxInMemoryLines = requirePositiveInteger(
      options.maxInMemoryLines ?? DEFAULT_MAX_LINES,
      "maxInMemoryLines",
    );
    this.#maxReadBytes = requirePositiveInteger(
      options.maxReadBytes ?? DEFAULT_MAX_BYTES,
      "maxReadBytes",
    );
    this.#maxReadLines = requirePositiveInteger(
      options.maxReadLines ?? DEFAULT_MAX_LINES,
      "maxReadLines",
    );
    this.#tempDirectory = options.tempDirectory ?? tmpdir();
    this.#tempFilePrefix = options.tempFilePrefix ?? "pibg-output";
    this.#createSpillPath = options.createSpillPath;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get totalLines(): number {
    if (this.#totalBytes === 0) return 0;
    return this.#newlineCount + (this.#lastByte === NEWLINE ? 0 : 1);
  }

  get deliveredCursor(): number {
    return this.#deliveredCursor;
  }

  get spillPath(): string | undefined {
    return this.#spillPath;
  }

  get stats(): OutputStoreStats {
    const memoryStart = this.#spillPath === undefined ? 0 : this.#tailStart;
    const memoryBytes = this.#spillPath === undefined
      ? this.#memoryChunks.reduce((sum, chunk) => sum + chunk.length, 0)
      : this.#tail.length;

    return {
      totalBytes: this.totalBytes,
      totalLines: this.totalLines,
      deliveredCursor: this.deliveredCursor,
      spilled: this.#spillPath !== undefined,
      ...(this.#spillPath === undefined ? {} : { spillPath: this.#spillPath }),
      memoryRange: { start: memoryStart, end: memoryStart + memoryBytes },
      memoryBytes,
    };
  }

  append(data: string | Uint8Array): void {
    if (this.#closed) throw new Error("Cannot append to a closed output store");

    const chunk = typeof data === "string"
      ? Buffer.from(data, "utf8")
      : Buffer.from(data);
    if (chunk.length === 0) return;

    if (this.#spillFd === undefined) {
      this.#memoryChunks.push(chunk);
      this.#accountFor(chunk);
      if (
        this.#totalBytes > this.#maxInMemoryBytes
        || this.totalLines > this.#maxInMemoryLines
      ) {
        this.#spill();
      }
      return;
    }

    writeAll(this.#spillFd, chunk);
    this.#accountFor(chunk);
    this.#tail = this.#boundedTail(Buffer.concat([this.#tail, chunk]));
    this.#tailStart = this.#totalBytes - this.#tail.length;
  }

  read(options: OutputReadOptions = {}): OutputReadResult {
    const snapshotEnd = this.#totalBytes;
    const snapshotLines = this.totalLines;
    const cursorBefore = this.#deliveredCursor;
    const explicit = options.start !== undefined;
    const start = options.start === undefined
      ? cursorBefore
      : requireNonNegativeInteger(options.start, "start");
    const requestedLength = options.length === undefined
      ? this.#maxReadBytes
      : requireNonNegativeInteger(options.length, "length");

    const requestedRange = explicit
      ? this.#explicitRequestedRange(start, requestedLength, snapshotEnd)
      : { start, end: snapshotEnd };
    const reasons: OutputTruncationReason[] = [];

    let returnedStart = requestedRange.start;
    let returnedEnd = requestedRange.end;
    let bytes: Buffer;

    if (explicit) {
      const byteLimitedEnd = Math.min(
        returnedEnd,
        returnedStart + Math.min(requestedLength, this.#maxReadBytes),
      );
      if (byteLimitedEnd < returnedEnd) reasons.push("bytes");
      returnedEnd = byteLimitedEnd;
      bytes = this.#readBytes(returnedStart, returnedEnd);

      const lineLimitedLength = prefixEndForLineLimit(bytes, this.#maxReadLines);
      if (lineLimitedLength < bytes.length) reasons.push("lines");
      returnedEnd = returnedStart + lineLimitedLength;
      bytes = bytes.subarray(0, lineLimitedLength);
    } else {
      const byteBudget = Math.min(requestedLength, this.#maxReadBytes);
      const byteLimitedStart = Math.max(returnedStart, returnedEnd - byteBudget);
      if (byteLimitedStart > returnedStart) reasons.push("bytes");
      returnedStart = byteLimitedStart;
      bytes = this.#readBytes(returnedStart, returnedEnd);

      const lineLimitedStart = suffixStartForLineLimit(bytes, this.#maxReadLines);
      if (lineLimitedStart > 0) reasons.push("lines");
      returnedStart += lineLimitedStart;
      bytes = bytes.subarray(lineLimitedStart);
    }

    const returnedRange = { start: returnedStart, end: returnedEnd };
    const omittedRanges = explicit
      ? nonEmptyRange(returnedEnd, requestedRange.end)
      : nonEmptyRange(requestedRange.start, returnedStart);
    const omittedBytes = omittedRanges.reduce(
      (sum, range) => sum + range.end - range.start,
      0,
    );

    if (!explicit) this.#deliveredCursor = snapshotEnd;

    return {
      content: bytes.toString("utf8"),
      requestedRange,
      returnedRange,
      omittedRanges,
      truncation: {
        truncated: omittedBytes > 0,
        by: reasons,
        omittedBytes,
      },
      cursor: {
        before: cursorBefore,
        after: this.#deliveredCursor,
        advanced: !explicit,
      },
      totalBytes: snapshotEnd,
      totalLines: snapshotLines,
      returnedBytes: bytes.length,
      returnedLines: countLines(bytes),
      snapshotEnd,
      ...(this.#spillPath === undefined ? {} : { spillPath: this.#spillPath }),
    };
  }

  readImplicit(length?: number): OutputReadResult {
    return this.read(length === undefined ? {} : { length });
  }

  readRange(start: number, length?: number): OutputReadResult {
    return this.read(length === undefined ? { start } : { start, length });
  }

  /** Close the spill descriptor without removing the spill file. Reads remain available. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#spillFd !== undefined) {
      closeSync(this.#spillFd);
      this.#spillFd = undefined;
    }
  }

  #accountFor(chunk: Buffer): void {
    this.#totalBytes += chunk.length;
    for (const byte of chunk) {
      if (byte === NEWLINE) this.#newlineCount++;
    }
    this.#lastByte = chunk[chunk.length - 1];
  }

  #spill(): void {
    const path = this.#allocateSpillPath();
    const fd = openSync(path, "wx+", 0o600);

    try {
      for (const chunk of this.#memoryChunks) writeAll(fd, chunk);
    } catch (error) {
      closeSync(fd);
      throw error;
    }

    const completeOutput = Buffer.concat(this.#memoryChunks);
    this.#spillPath = path;
    this.#spillFd = fd;
    this.#memoryChunks = [];
    this.#tail = this.#boundedTail(completeOutput);
    this.#tailStart = this.#totalBytes - this.#tail.length;
  }

  #boundedTail(buffer: Buffer): Buffer {
    const byteStart = Math.max(0, buffer.length - this.#maxInMemoryBytes);
    const lineStart = suffixStartForLineLimit(buffer, this.#maxInMemoryLines);
    return Buffer.from(buffer.subarray(Math.max(byteStart, lineStart)));
  }

  #allocateSpillPath(): string {
    if (this.#createSpillPath !== undefined) return this.#createSpillPath();
    return join(
      this.#tempDirectory,
      `${this.#tempFilePrefix}-${randomBytes(12).toString("hex")}.log`,
    );
  }

  #explicitRequestedRange(
    start: number,
    requestedLength: number,
    snapshotEnd: number,
  ): ByteRange {
    if (start >= snapshotEnd || requestedLength === 0) {
      return { start, end: start };
    }
    const available = snapshotEnd - start;
    return { start, end: start + Math.min(requestedLength, available) };
  }

  #readBytes(start: number, end: number): Buffer {
    if (end <= start) return Buffer.alloc(0);

    if (this.#spillPath === undefined) {
      return Buffer.concat(this.#memoryChunks).subarray(start, end);
    }

    if (start >= this.#tailStart) {
      return this.#tail.subarray(start - this.#tailStart, end - this.#tailStart);
    }

    const output = Buffer.allocUnsafe(end - start);
    const fd = this.#spillFd ?? openSync(this.#spillPath, "r");
    const closeAfterRead = this.#spillFd === undefined;

    try {
      let offset = 0;
      while (offset < output.length) {
        const bytesRead = readSync(
          fd,
          output,
          offset,
          output.length - offset,
          start + offset,
        );
        if (bytesRead === 0) {
          throw new Error(`Unexpected end of spill file at byte ${start + offset}`);
        }
        offset += bytesRead;
      }
    } finally {
      if (closeAfterRead) closeSync(fd);
    }

    return output;
  }
}
