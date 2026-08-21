/**
 * Coordinates steering that arrives before a wait-mode bash tool has started.
 *
 * A steer applies to bash calls in the assistant turn that was active when the
 * input arrived. Tool calls may already be in preflight or may not be emitted
 * until the model finishes streaming, so affected call IDs are retained until
 * their bash implementation can consume the detachment request after spawn.
 */
export class SteeringDetachmentCoordinator {
  readonly #inFlightBashCalls = new Set<string>();
  readonly #affectedBashCalls = new Set<string>();
  #turnActive = false;
  #turnArmed = false;

  beginTurn(): void {
    this.reset();
    this.#turnActive = true;
  }

  endTurn(): void {
    this.reset();
  }

  reset(): void {
    this.#turnActive = false;
    this.#turnArmed = false;
    this.#inFlightBashCalls.clear();
    this.#affectedBashCalls.clear();
  }

  toolStarted(toolCallId: string, toolName: string): void {
    if (toolName !== "bash") return;
    this.#inFlightBashCalls.add(toolCallId);
    if (this.#turnActive && this.#turnArmed) {
      this.#affectedBashCalls.add(toolCallId);
    }
  }

  toolEnded(toolCallId: string): void {
    this.#inFlightBashCalls.delete(toolCallId);
    this.#affectedBashCalls.delete(toolCallId);
  }

  /** Arm the active turn and include bash calls already in tool preflight. */
  steer(): void {
    if (!this.#turnActive) return;
    this.#turnArmed = true;
    for (const toolCallId of this.#inFlightBashCalls) {
      this.#affectedBashCalls.add(toolCallId);
    }
  }

  /** Consume at most one post-spawn detachment request for this tool call. */
  consume(toolCallId: string): boolean {
    return this.#affectedBashCalls.delete(toolCallId);
  }
}
