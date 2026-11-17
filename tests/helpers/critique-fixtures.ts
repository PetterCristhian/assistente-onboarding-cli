// Steps and dependencies of the self-critique for the tests of the session.
// The prompts and the safe message are made-up texts with sentinels: no
// domain content, so that a test can tell where each one was sent.
import type { CritiqueDeps, RuleId } from "../../src/chat/critique.js";
import {
  createFakeLlmClient,
  type FakeLlmCall,
  type FakeLlmClient,
  type FakeLlmStep,
  type FakeValueStep,
} from "./fake-llm-client.js";
import { fakeResponseBody, type FakeFetchStep } from "./fake-openai-fetch.js";

export const FALLBACK_MESSAGE = "MENSAGEM-SEGURA-FIXA";
export const EVALUATOR_PROMPT = "PROMPT-DO-AVALIADOR";
export const REVISION_PROMPT = "REVISAO: corrija {{violacoes}} e reescreva.";
export const EVALUATOR_CONTEXT = "CAMADAS-2-3-4";

/** The evaluator approves: it takes the step after a draft in a script. */
export function approvedStep(): FakeValueStep {
  return { value: { aprovada: true, violacoes: [] } };
}

/** The evaluator rejects, naming one rule. */
export function rejectedStep(
  rule: RuleId = "P2",
  reason = "motivo de teste",
): FakeValueStep {
  return {
    value: { aprovada: false, violacoes: [{ regra: rule, motivo: reason }] },
  };
}

export function makeCritiqueDeps(
  overrides: Partial<CritiqueDeps> = {},
): CritiqueDeps {
  return {
    evaluatorContext: EVALUATOR_CONTEXT,
    evaluatorPrompt: EVALUATOR_PROMPT,
    revisionPrompt: REVISION_PROMPT,
    fallbackMessage: FALLBACK_MESSAGE,
    ...overrides,
  };
}

/**
 * For the tests written before the self-critique: puts an approval right
 * after each step that answers with a text (a draft), so that the script still
 * describes the same turns. Steps that fail, or fail midway, are left alone:
 * the turn ends before the evaluation.
 */
export function withApprovals(
  script: readonly FakeLlmStep[],
): readonly FakeLlmStep[] {
  return script.flatMap((step): FakeLlmStep[] =>
    "text" in step ? [step, approvedStep()] : [step],
  );
}

/** A fake client whose script is `withApprovals(script)`. */
export function createApprovingFakeClient(
  script: readonly FakeLlmStep[],
): FakeLlmClient {
  return createFakeLlmClient(withApprovals(script));
}

/** The answer of the real client (over a fake fetch) to an evaluation that approves. */
export function approvalFetchStep(): FakeFetchStep {
  return {
    kind: "json",
    body: fakeResponseBody({
      text: JSON.stringify({ aprovada: true, violacoes: [] }),
    }),
  };
}

/** The calls that wrote a draft (or a revision): not the ones of the evaluator. */
export function draftCalls(fake: FakeLlmClient): FakeLlmCall[] {
  return fake.calls.filter((call) => call.kind === "streamText");
}
