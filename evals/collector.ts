// The ChatOutput of the battery: it shows nothing on the terminal. The chunks
// of the draft are dropped (the full text comes back in the result of the
// turn); the notices and the retractions are kept, in order, to be recorded
// with the turn.
import type { ChatOutput } from "../src/chat/session.js";
import type { NoticeLine } from "./record.js";

export interface CollectedOutput {
  readonly notices: NoticeLine[];
  /** The texts of the retractions, also present in `notices`. */
  readonly retractions: string[];
}

export interface CollectingOutput extends ChatOutput {
  /** What was collected since the last call; starts a new collection. */
  take(): CollectedOutput;
}

export function createCollectingOutput(): CollectingOutput {
  let collected: CollectedOutput = { notices: [], retractions: [] };

  return {
    chunk() {
      // Dropped on purpose: nothing is shown during a battery.
    },
    endAnswer() {
      // Nothing to close: no line is open on any terminal.
    },
    retraction(text) {
      collected.retractions.push(text);
      collected.notices.push({ nivel: "warning", texto: text });
    },
    notice(level, text) {
      collected.notices.push({ nivel: level, texto: text });
    },
    take() {
      const taken = collected;
      collected = { notices: [], retractions: [] };
      return taken;
    },
  };
}
