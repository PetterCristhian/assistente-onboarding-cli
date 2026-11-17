// The context of each profile that the cases use, loaded before anything else:
// a profile that does not exist, or a broken layer, stops the battery before
// the key is read and before any call. One context per profile, built once and
// with the same frozen date, so every run of a profile sees the same text.
import {
  buildEvaluatorContext,
  type CritiqueDeps,
} from "../src/chat/critique.js";
import { buildContext } from "../src/context/builder.js";
import {
  loadContext,
  loadCritiquePrompts,
  loadFallbackMessage,
  type ContextFileReader,
} from "../src/context/loaders.js";
import { ContextError } from "../src/context/types.js";
import type { Caso } from "./schema.js";

export interface BatteryContext {
  /** The whole assembled context: what the assistant receives. */
  readonly instructions: string;
  readonly critique: CritiqueDeps;
}

export interface BatteryContextInput {
  readonly cases: readonly Caso[];
  readonly contextDir: string;
  readonly now: () => Date;
  readonly reader?: ContextFileReader;
}

/** By profile slug, in order of the first case that uses each one. */
export function loadBatteryContexts(
  input: BatteryContextInput,
): Map<string, BatteryContext> {
  const reader = input.reader === undefined ? {} : { reader: input.reader };
  const prompts = loadCritiquePrompts(input.contextDir, input.reader);
  const fallbackMessage = loadFallbackMessage(input.contextDir, input.reader);
  const frozen = input.now();

  const contexts = new Map<string, BatteryContext>();
  for (const caso of input.cases) {
    if (contexts.has(caso.perfil)) {
      continue;
    }
    try {
      const { layers } = loadContext(
        { contextDir: input.contextDir, profile: caso.perfil },
        { now: () => frozen, ...reader },
      );
      const built = buildContext(layers);
      contexts.set(caso.perfil, {
        instructions: built.text,
        critique: {
          evaluatorContext: buildEvaluatorContext(built.sections),
          evaluatorPrompt: prompts.evaluator,
          revisionPrompt: prompts.revision,
          fallbackMessage,
        },
      });
    } catch (error) {
      if (error instanceof ContextError) {
        throw new ContextError(`${caso.id}: ${error.message}`);
      }
      throw error;
    }
  }
  return contexts;
}
