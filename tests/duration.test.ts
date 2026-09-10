import { describe, expect, it } from "vitest";

import { formatDuration } from "../background-processes/duration";

describe("compact elapsed durations", () => {
  it.each([
    [-1_000, "0s"],
    [0, "0s"],
    [999, "0s"],
    [1_000, "1s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [65_000, "1m5s"],
    [3_599_000, "59m59s"],
    [3_600_000, "1h"],
    [3_601_000, "1h1s"],
    [86_399_000, "23h59m59s"],
    [86_400_000, "1d"],
    [255_233_000, "2d22h53m53s"],
    [(20 * 86_400 + 7 * 3_600 + 31 * 60 + 40) * 1_000, "20d7h31m40s"],
    [800 * 86_400_000, "800d"],
  ])("formats %i ms as %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });

  it.each([
    [0, "0.0s"],
    [500, "0.5s"],
    [1_250, "1.3s"],
    [2_000, "2.0s"],
    [59_940, "59.9s"],
    [59_999, "1m"],
    [65_500, "1m5s"],
    [3_600_000, "1h"],
  ])("retains short-command precision for %i ms: %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds, true)).toBe(expected);
  });
});
