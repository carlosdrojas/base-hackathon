/**
 * Triaging agent seam.
 * Job 1: root cause from the event list.
 * Job 2: gameplan (action, permission level, who to alert).
 * Both throw until a real run is wired. No model call lives here yet.
 */

import type { DebugInput, Gameplan, GameplanInput, Hypothesis } from "./contracts.js";
import type { FieldRcaHost } from "./ports.js";

export class FieldRcaNotReadyError extends Error {
  readonly job: "debug" | "gameplan";

  constructor(job: "debug" | "gameplan") {
    super(`Field RCA triaging agent is not implemented (${job}).`);
    this.name = "FieldRcaNotReadyError";
    this.job = job;
  }
}

export interface TriagingAgent {
  readonly ready: false;
  debug(input: DebugInput): Promise<Hypothesis>;
  gameplan(input: GameplanInput): Promise<Gameplan>;
}

export function createTriagingAgent(_host?: FieldRcaHost): TriagingAgent {
  return {
    ready: false,
    async debug(_input: DebugInput): Promise<Hypothesis> {
      throw new FieldRcaNotReadyError("debug");
    },
    async gameplan(_input: GameplanInput): Promise<Gameplan> {
      throw new FieldRcaNotReadyError("gameplan");
    },
  };
}
