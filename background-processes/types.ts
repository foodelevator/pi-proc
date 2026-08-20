export interface ByteRange {
  /** Inclusive byte offset. */
  start: number;
  /** Exclusive byte offset. */
  end: number;
}

export type OutputTruncationReason = "bytes" | "lines";

export interface OutputTruncation {
  truncated: boolean;
  by: OutputTruncationReason[];
  omittedBytes: number;
}

export interface OutputCursorMetadata {
  before: number;
  after: number;
  /** True only when this read moved the delivered cursor. */
  advanced: boolean;
}

export interface OutputReadResult {
  /** UTF-8 decoding of the exact bytes in returnedRange. */
  content: string;
  requestedRange: ByteRange;
  returnedRange: ByteRange;
  omittedRanges: ByteRange[];
  truncation: OutputTruncation;
  cursor: OutputCursorMetadata;
  /** Output totals at the fixed snapshot used for this read. */
  totalBytes: number;
  totalLines: number;
  returnedBytes: number;
  returnedLines: number;
  spillPath?: string;
}

export interface OutputReadOptions {
  /** An explicit zero-based byte offset. Omit to consume from the delivered cursor. */
  start?: number;
  /** Requested byte budget. Reads never return more than the store's configured maximum. */
  length?: number;
}

export interface OutputStoreStats {
  totalBytes: number;
  totalLines: number;
  deliveredCursor: number;
  spilled: boolean;
  spillPath?: string;
  /** The byte range currently resident in memory. */
  memoryRange: ByteRange;
  memoryBytes: number;
}

export interface OutputStoreOptions {
  /** Spill after this many bytes are exceeded. Defaults to Pi's 50 KB output limit. */
  maxInMemoryBytes?: number;
  /** Spill after this many lines are exceeded. Defaults to Pi's 2000-line limit. */
  maxInMemoryLines?: number;
  /** Maximum bytes returned by one read. Defaults to Pi's 50 KB output limit. */
  maxReadBytes?: number;
  /** Maximum lines returned by one read. Defaults to Pi's 2000-line limit. */
  maxReadLines?: number;
  tempDirectory?: string;
  tempFilePrefix?: string;
  /** Primarily for deterministic tests. The returned path must not already exist. */
  createSpillPath?: () => string;
}
