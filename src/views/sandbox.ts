import { DEFAULT_EMAILS, DEFAULT_SCENARIO, SCENARIOS, type ScenarioDef } from "../engine/scenario.js";
import { PAID_OUTCOME, SANDBOX_OUTCOMES, STAYS_IN_FLIGHT } from "../text/words.js";
import type { SandboxView } from "./contract.js";

// The sandbox simulator: the scripted incidents, the bank outcomes the sandbox
// bank can play and the canned supplier email threads. Only pnpm ui serves it,
// because only it plays the bank.

// The outcome pnpm recover plays when none is named: the first transfer times out
// and PayOnce replaces it without a person.
const DEFAULT_OUTCOME: string = "CHANNEL_TIMEOUT";

const OUTCOME_LABELS: Record<string, string> = {
  [PAID_OUTCOME]: "Paid",
  [STAYS_IN_FLIGHT]: "Stays in flight",
  CHANNEL_TIMEOUT: "Channel timeout",
  SYSTEM_ERROR: "System error",
  BENEFICIARY_BANK_RETURNED: "Beneficiary bank returned",
  ACCOUNT_CLOSED: "Account closed",
  INVALID_ACCOUNT_NAME_OR_NUMBER: "Invalid account name or number",
};

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

// "nothing-arrived" is shown as "Nothing arrived".
export function threadLabel(id: string): string {
  const words: string = id.replace(/-/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

// emailThreads: the threads in fixtures/emails/, the default first.
export function sandboxView(emailThreads: string[]): SandboxView {
  return {
    view: "sandbox",
    scenarios: SCENARIOS.map((scenario: ScenarioDef) => ({ id: scenario.id, label: scenario.label })),
    bankOutcomes: SANDBOX_OUTCOMES.map((outcome: string) => ({ id: outcome, label: outcomeLabel(outcome) })),
    emailThreads: emailThreads.map((id: string) => ({ id, label: threadLabel(id) })),
    defaults: { scenario: DEFAULT_SCENARIO, bankOutcome: DEFAULT_OUTCOME, emails: DEFAULT_EMAILS },
  };
}
