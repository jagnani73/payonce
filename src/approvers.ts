import { formatMoney, toMinor } from "./money.js";

const DEFAULT_TWO_APPROVERS_ABOVE: number = 5_000;
const DEFAULT_APPROVAL_TTL_MINUTES: number = 60;
const MINUTE_MS: number = 60_000;

// A person who may approve a payment up to a limit. The limit is compared with
// the amount in the payment's own currency, because PayOnce has no exchange
// rates yet.
export interface Approver {
  name: string;
  limitMinor: number;
}

export interface ApprovalPolicy {
  approvers: Approver[];
  // Above this amount two different approvers are needed.
  twoApproversAboveMinor: number;
  expiresAfterMs: number;
  // Why APPROVERS could not be read. Every approval is refused while it is set.
  problem: string | null;
}

// An approval completed just before its request expired still has this long to
// be used, so a slow look does not lose it.
export const APPROVED_USE_WITHIN_MS: number = 10 * MINUTE_MS;

// How many approvers a payment needs, and why.
export interface SignoffRule {
  needed: number;
  why: string;
}

// Someone who may not approve this payment, and why.
export interface Barred {
  name: string;
  why: string;
}

// Names are typed by people, so case and spacing do not make a different person.
export function sameName(a: string, b: string): boolean {
  const key = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();
  return key(a) === key(b);
}

function parseApprovers(raw: string): Approver[] {
  const approvers: Approver[] = [];
  for (const entry of raw.split(",")) {
    if (entry.trim() === "") {
      continue;
    }
    const colon: number = entry.lastIndexOf(":");
    const name: string = colon < 0 ? "" : entry.slice(0, colon).trim().replace(/\s+/g, " ");
    const limit: number = colon < 0 ? Number.NaN : Number(entry.slice(colon + 1).trim());
    if (name === "" || !Number.isFinite(limit) || limit <= 0) {
      throw new Error(`"${entry.trim()}" is not a name and a limit, such as Alex:50000`);
    }
    if (approvers.some((approver: Approver): boolean => sameName(approver.name, name))) {
      throw new Error(`${name} is listed twice`);
    }
    approvers.push({ name, limitMinor: toMinor(limit) });
  }
  return approvers;
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value: number = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

// APPROVERS is a list such as "Alex:50000,Sam Lee:5000", each a name and the
// largest amount that person may approve. Without it nobody can approve.
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): ApprovalPolicy {
  const policy: ApprovalPolicy = {
    approvers: [],
    twoApproversAboveMinor: toMinor(DEFAULT_TWO_APPROVERS_ABOVE),
    expiresAfterMs: DEFAULT_APPROVAL_TTL_MINUTES * MINUTE_MS,
    problem: null,
  };
  try {
    policy.twoApproversAboveMinor = toMinor(
      positiveNumber(env["TWO_APPROVERS_ABOVE"], DEFAULT_TWO_APPROVERS_ABOVE, "TWO_APPROVERS_ABOVE"),
    );
    policy.expiresAfterMs =
      positiveNumber(env["APPROVAL_TTL_MINUTES"], DEFAULT_APPROVAL_TTL_MINUTES, "APPROVAL_TTL_MINUTES") *
      MINUTE_MS;
    policy.approvers = parseApprovers(env["APPROVERS"] ?? "");
    if (policy.approvers.length === 0) {
      policy.problem = "no approvers are set. Add APPROVERS to .env, such as Alex:50000,Sam:5000";
    }
  } catch (error: unknown) {
    policy.approvers = [];
    policy.problem = `the approval settings could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  return policy;
}

export function describePolicy(policy: ApprovalPolicy): string {
  if (policy.problem !== null) {
    return `Approvals are refused: ${policy.problem}`;
  }
  // Limits apply in whatever currency the payment is in.
  const amount = (minor: number): string => formatMoney(minor, "").trim();
  const names: string = policy.approvers
    .map((approver: Approver): string => `${approver.name} (up to ${amount(approver.limitMinor)})`)
    .join(", ");
  return `Approvers: ${names}. Two are needed above ${amount(policy.twoApproversAboveMinor)}, and an approval request expires after ${policy.expiresAfterMs / MINUTE_MS} minutes`;
}

// Two approvers are needed for a payment to an account the original did not go
// to, whatever the amount, and for one whose starter PayOnce does not know, since
// the requester rule cannot be checked then.
export function signoffsNeeded(
  policy: ApprovalPolicy,
  amountMinor: number,
  currency: string,
  newAccount: boolean,
  startedBy: string | null,
): SignoffRule {
  if (newAccount) {
    return { needed: 2, why: "it pays an account the original payment did not go to" };
  }
  if (startedBy === null) {
    return { needed: 2, why: "PayOnce does not know who started this payment" };
  }
  if (amountMinor > policy.twoApproversAboveMinor) {
    return {
      needed: 2,
      why: `the amount is above ${formatMoney(policy.twoApproversAboveMinor, currency)}`,
    };
  }
  return { needed: 1, why: "" };
}

// The approvers who could approve this payment: not barred and within their
// limit. A request that needs more than this can never be approved.
export function eligibleApprovers(
  policy: ApprovalPolicy,
  amountMinor: number,
  barred: Barred[],
): Approver[] {
  return policy.approvers.filter(
    (approver: Approver): boolean =>
      approver.limitMinor >= amountMinor &&
      !barred.some((entry: Barred): boolean => sameName(entry.name, approver.name)),
  );
}

// The approver a name belongs to, or why that person cannot approve this payment.
// signedBy is who has approved it already.
export function checkSigner(
  policy: ApprovalPolicy,
  name: string,
  amountMinor: number,
  currency: string,
  barred: Barred[],
  signedBy: string[],
): Approver {
  if (policy.problem !== null) {
    throw new Error(`Approval refused: ${policy.problem}`);
  }
  const approver: Approver | undefined = policy.approvers.find(
    (candidate: Approver): boolean => sameName(candidate.name, name),
  );
  if (approver === undefined) {
    throw new Error(
      `${name.trim()} is not an approver. The approvers are ${policy.approvers.map((candidate: Approver): string => candidate.name).join(", ")}`,
    );
  }
  const bar: Barred | undefined = barred.find((entry: Barred): boolean => sameName(entry.name, name));
  if (bar !== undefined) {
    throw new Error(`${approver.name} ${bar.why}, so someone else approves this payment`);
  }
  if (signedBy.some((signer: string): boolean => sameName(signer, name))) {
    throw new Error(`${approver.name} has approved this already. The next approval must come from someone else`);
  }
  if (amountMinor > approver.limitMinor) {
    throw new Error(
      `${approver.name} can approve up to ${formatMoney(approver.limitMinor, currency)}, and this payment is ${formatMoney(amountMinor, currency)}`,
    );
  }
  return approver;
}
