import { randomBytes } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
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

function countNewlines(
  buffer: Buffer,
  start = 0,
  end = buffer.length,
): number {
  let newlines = 0;
  for (let index = start; index < end; index++) {
    if (buffer[index] === NEWLINE) newlines++;
  }
  return newlines;
}

function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  return countNewlines(buffer) + (buffer[buffer.length - 1] === NEWLINE ? 0 : 1);
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

function writeAll(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(
      fd,
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (written <= 0) throw new Error("Spill file write made no progress");
    offset += written;
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
  #tailNewlines = 0;
  #totalBytes = 0;
  #newlineCount = 0;
  #lastByte: number | undefined;
  #lastLineBytes = 0;
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

  /** Raw UTF-8 byte length of the current final line. */
  get lastLineBytes(): number {
    return this.#lastLineBytes;
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

    const writePosition = this.#totalBytes;
    try {
      writeAll(this.#spillFd, chunk, writePosition);
    } catch (error) {
      // A short write followed by an error must not shift subsequent logical offsets.
      ftruncateSync(this.#spillFd, writePosition);
      throw error;
    }

    const chunkNewlines = this.#accountFor(chunk);
    this.#tailNewlines += chunkNewlines;
    this.#setBoundedTail(Buffer.concat([this.#tail, chunk]), this.#tailNewlines);
  }

  read(options: OutputReadOptions = {}): OutputReadResult {
    return this.#read(options, false);
  }

  /** Return the complete-output tail without consuming the delivered cursor. */
  snapshotTail(length?: number): OutputReadResult {
    return this.#read(length === undefined ? {} : { length }, true);
  }

  /**
   * Decode a larger raw tail for a secondary text truncator without consuming
   * the cursor. If the window starts mid-line, discard that incomplete line
   * when a later complete line is available.
   */
  snapshotTextTail(maxBytes: number): string {
    const byteBudget = requirePositiveInteger(maxBytes, "maxBytes");
    let start = Math.max(0, this.#totalBytes - byteBudget);
    let bytes = this.#readBytes(start, this.#totalBytes);

    while (bytes.length > 0 && (bytes[0] & 0xc0) === 0x80) {
      start++;
      bytes = bytes.subarray(1);
    }
    if (
      start > 0
      && this.#readBytes(start - 1, start)[0] !== NEWLINE
    ) {
      const firstNewline = bytes.indexOf(NEWLINE);
      if (firstNewline !== -1 && firstNewline < bytes.length - 1) {
        bytes = bytes.subarray(firstNewline + 1);
      }
    }
    return bytes.toString("utf8");
  }

  #read(
    options: OutputReadOptions,
    snapshotTail: boolean,
  ): OutputReadResult {
    const snapshotEnd = this.#totalBytes;
    const snapshotLines = this.totalLines;
    const cursorBefore = this.#deliveredCursor;
    const explicit = options.start !== undefined;
    const start = snapshotTail
      ? 0
      : options.start === undefined
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

      // A byte cap can land inside a UTF-8 sequence. Pi's bash output never
      // exposes a malformed leading character, so move to the next boundary.
      let utf8Start = 0;
      while (
        utf8Start < bytes.length
        && (bytes[utf8Start] & 0xc0) === 0x80
      ) {
        utf8Start++;
      }
      returnedStart += utf8Start;
      bytes = bytes.subarray(utf8Start);

      // As Pi's tail truncation does, omit a partial first line when complete
      // later lines are available. Keep the partial tail only when one final
      // line by itself exceeds the byte budget.
      if (
        byteLimitedStart > requestedRange.start
        && returnedStart > 0
        && this.#readBytes(returnedStart - 1, returnedStart)[0] !== NEWLINE
      ) {
        const firstNewline = bytes.indexOf(NEWLINE);
        if (firstNewline !== -1 && firstNewline < bytes.length - 1) {
          returnedStart += firstNewline + 1;
          bytes = bytes.subarray(firstNewline + 1);
        }
      }

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

    if (!explicit && !snapshotTail) this.#deliveredCursor = snapshotEnd;

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
        advanced: this.#deliveredCursor !== cursorBefore,
      },
      totalBytes: snapshotEnd,
      totalLines: snapshotLines,
      returnedBytes: bytes.length,
      returnedLines: countLines(bytes),
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

  #accountFor(chunk: Buffer): number {
    const chunkNewlines = countNewlines(chunk);
    const lastNewline = chunk.lastIndexOf(NEWLINE);
    this.#lastLineBytes = lastNewline === -1
      ? this.#lastLineBytes + chunk.length
      : chunk.length - lastNewline - 1;
    this.#totalBytes += chunk.length;
    this.#newlineCount += chunkNewlines;
    this.#lastByte = chunk[chunk.length - 1];
    return chunkNewlines;
  }

  #spill(): void {
    const path = this.#allocateSpillPath();
    const fd = openSync(path, "wx+", 0o600);

    try {
      let position = 0;
      for (const chunk of this.#memoryChunks) {
        writeAll(fd, chunk, position);
        position += chunk.length;
      }
    } catch (error) {
      closeSync(fd);
      throw error;
    }

    const completeOutput = Buffer.concat(this.#memoryChunks);
    this.#spillPath = path;
    this.#spillFd = fd;
    this.#memoryChunks = [];
    this.#setBoundedTail(completeOutput, this.#newlineCount);
  }

  #setBoundedTail(buffer: Buffer, newlines: number): void {
    const byteStart = Math.max(0, buffer.length - this.#maxInMemoryBytes);
    const lineCount = buffer.length === 0
      ? 0
      : newlines + (buffer[buffer.length - 1] === NEWLINE ? 0 : 1);
    let linesToDrop = Math.max(0, lineCount - this.#maxInMemoryLines);
    let lineStart = 0;

    while (linesToDrop > 0) {
      const newline = buffer.indexOf(NEWLINE, lineStart);
      if (newline === -1) {
        lineStart = buffer.length;
        break;
      }
      lineStart = newline + 1;
      linesToDrop--;
    }

    const start = Math.max(byteStart, lineStart);
    this.#tailNewlines = newlines - countNewlines(buffer, 0, start);
    this.#tail = Buffer.from(buffer.subarray(start));
    this.#tailStart = this.#totalBytes - this.#tail.length;
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
