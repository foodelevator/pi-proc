import { describe, expect, it } from "vitest";

import { SteeringDetachmentCoordinator } from "../background-processes/steering-detachment";

describe("turn-scoped steering detachment", () => {
  it("marks bash calls that start after steering in the active turn", () => {
    const coordinator = new SteeringDetachmentCoordinator();

    coordinator.beginTurn();
    coordinator.steer();
    coordinator.toolStarted("bash-after-steer", "bash");

    expect(coordinator.consume("bash-after-steer")).toBe(true);
    expect(coordinator.consume("bash-after-steer")).toBe(false);
  });

  it("marks bash calls already in preflight and ignores non-bash calls", () => {
    const coordinator = new SteeringDetachmentCoordinator();

    coordinator.beginTurn();
    coordinator.toolStarted("bash-preflight", "bash");
    coordinator.toolStarted("read-preflight", "read");
    coordinator.steer();

    expect(coordinator.consume("bash-preflight")).toBe(true);
    expect(coordinator.consume("read-preflight")).toBe(false);
  });

  it("marks every parallel bash call and clears the latch at turn end", () => {
    const coordinator = new SteeringDetachmentCoordinator();

    coordinator.beginTurn();
    coordinator.steer();
    coordinator.toolStarted("first", "bash");
    coordinator.toolStarted("second", "bash");

    expect(coordinator.consume("first")).toBe(true);
    expect(coordinator.consume("second")).toBe(true);

    coordinator.endTurn();
    coordinator.beginTurn();
    coordinator.toolStarted("next-turn", "bash");
    expect(coordinator.consume("next-turn")).toBe(false);
  });

  it("does not arm outside a turn and cleans up ended tool calls", () => {
    const coordinator = new SteeringDetachmentCoordinator();

    coordinator.steer();
    coordinator.beginTurn();
    coordinator.toolStarted("ended", "bash");
    coordinator.steer();
    coordinator.toolEnded("ended");

    expect(coordinator.consume("ended")).toBe(false);

    coordinator.endTurn();
    coordinator.steer();
    coordinator.beginTurn();
    coordinator.toolStarted("later", "bash");
    expect(coordinator.consume("later")).toBe(false);
  });
});
