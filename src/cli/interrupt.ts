// What Ctrl+C does: the first one asks the program to stop (it cancels the
// turn that is running, wherever it is: waiting for the answer, waiting for a
// new try); the second one ends the program at once, for the case where
// something does not react to the first. Later ones do nothing more.
export interface InterruptDeps {
  /** Asks the program to stop. */
  readonly abort: () => void;
  /** Ends the program now. */
  readonly exit: () => void;
}

/** Returns the function to call on every Ctrl+C. */
export function createInterruptHandler(deps: InterruptDeps): () => void {
  let presses = 0;
  return (): void => {
    presses += 1;
    if (presses === 1) {
      deps.abort();
    } else if (presses === 2) {
      deps.exit();
    }
  };
}
