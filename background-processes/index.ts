import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { OutputStore } from "./output-store";
export type {
  ByteRange,
  OutputCursorMetadata,
  OutputReadOptions,
  OutputReadResult,
  OutputStoreOptions,
  OutputStoreStats,
  OutputTruncation,
  OutputTruncationReason,
} from "./types";

/** Pi extension entry point. Process integration is added in later implementation stages. */
export default function backgroundProcesses(pi: ExtensionAPI): void {
  void pi;
}
