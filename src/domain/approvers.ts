import type { PaymentAmount } from "./approval.js";
import { formatMoney, toMinor } from "./money.js";

const DEFAULT_TWO_APPROVERS_ABOVE: number = 5_000;
const DEFAULT_APPROVAL_TTL_MINUTES: number = 60;
const MINUTE_MS: number = 60_000;

// A person who may approve a payment up to a limit. The limit has no currency of
// its own. It is compared with what the payment takes from the company's wallet,
// in that wallet's currency, because the company chose the currencies it holds
// and the supplier chose the invoice's.
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
  // True when a setting could not be read, so problem says which, and false
  // when the approver list is only unset. Nobody ends an outage while it is true.
  unreadable: boolean;
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

// What a name typed into PayOnce may hold once trimmed, with runs of spaces
// collapsed: ASCII letters, digits, spaces, dots, hyphens, apostrophes and
// underscores, 1 to 80 of them, at least one a letter or a digit. Anything else,
// such as a zero-width space or a Cyrillic letter that looks Latin, could pass on
// screen for someone else's name, and a name of marks alone, such as "-" or ".",
// has no letters or digits to tell it from another. Underscores are in it for
// login names, which pnpm recover uses by default.
const NAME_PATTERN: RegExp = /^(?=[^A-Za-z0-9]*[A-Za-z0-9])[A-Za-z0-9 .'_-]{1,80}$/;
export const MAX_NAME_LENGTH: number = 80;
export const NAME_RULE: string =
  "A name takes only the letters A to Z, digits, spaces, dots, hyphens, apostrophes and underscores, up to 80 characters, with at least one letter or digit";

// A name PayOnce refuses, with words for the person who typed it.
export class NameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameError";
  }
}

// A name as a person typed it, trimmed and with runs of spaces collapsed, as
// PayOnce records it. Throws NameError when it is empty (missing says what to
// enter) or holds anything NAME_RULE does not allow.
export function personName(typed: string, missing: string = "Enter your name"): string {
  const name: string = typed.trim().replace(/ {2,}/g, " ");
  if (name === "") {
    throw new NameError(missing);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new NameError(NAME_RULE);
  }
  return name;
}

// A name as PayOnce stored it, when it follows NAME_RULE, in the form personName
// records. Null for null and for a name stored before names were checked that
// does not, such as one with a zero-width space in it: PayOnce cannot tell whose
// it is, so it counts as not known.
export function knownName(stored: string | null): string | null {
  if (stored === null) {
    return null;
  }
  const name: string = stored.trim().replace(/ {2,}/g, " ");
  return NAME_PATTERN.test(name) ? name : null;
}

// What makes two names one person to PayOnce: the letters and digits only,
// lowercased, with runs of spaces collapsed, so "Alex." and "alex" are the same
// person. Null for a name knownName does not take.
function personKey(name: string): string | null {
  const known: string | null = knownName(name);
  return known === null
    ? null
    : known
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/ +/g, " ")
        .trim();
}

// True when two names are the same person: both follow NAME_RULE and have the
// same personKey. A name that does not follow it is the same as no one.
export function sameName(a: string, b: string): boolean {
  const key: string | null = personKey(a);
  return key !== null && key === personKey(b);
}

// An APPROVERS entry as it can be read back in a message: anything outside
// printable ASCII, such as a zero-width space, is written as its code point.
function visible(text: string): string {
  return [...text]
    .map((char: string): string => {
      const code: number = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code <= 0x7e ? char : `\\u{${code.toString(16).toUpperCase()}}`;
    })
    .join("");
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
      throw new Error(`"${visible(entry.trim())}" is not a name and a limit, such as Alex:50000`);
    }
    // An approver types their name to approve, so a listed name follows the same
    // rule, or nobody could ever approve as it.
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`"${visible(name)}" is not a name PayOnce takes. ${NAME_RULE}`);
    }
    const twin: Approver | undefined = approvers.find((approver: Approver): boolean => sameName(approver.name, name));
    if (twin !== undefined) {
      throw new Error(
        twin.name === name
          ? `${name} is listed twice`
          : `${twin.name} and ${name} are the same name to PayOnce, which compares names by their letters, digits and the spaces between words`,
      );
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
    unreadable: false,
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
      policy.problem = "no approvers are set. Add APPROVERS to .env, such as Yash:50000,Alex:10000,Kim:10000,Sam:4200";
    }
  } catch (error: unknown) {
    policy.approvers = [];
    policy.problem = `the approval settings could not be read: ${error instanceof Error ? error.message : String(error)}`;
    policy.unreadable = true;
  }
  return policy;
}

export function describePolicy(policy: ApprovalPolicy): string {
  if (policy.problem !== null) {
    return `Approvals are refused: ${policy.problem}`;
  }
  // Limits apply to the amount paid, in the currency it is paid from.
  const amount = (minor: number): string => formatMoney(minor, "").trim();
  const names: string = policy.approvers
    .map((approver: Approver): string => `${approver.name} (up to ${amount(approver.limitMinor)})`)
    .join(", ");
  return `Approvers: ${names}. Two are needed above ${amount(policy.twoApproversAboveMinor)}, and an approval request expires after ${policy.expiresAfterMs / MINUTE_MS} minutes. Limits apply to the amount paid, in the currency it is paid from`;
}

// Two approvers are needed for a payment to an account the original did not go
// to, whatever the amount, and for one whose starter PayOnce does not know, since
// the requester rule cannot be checked then. A starter stored under a name that
// does not follow NAME_RULE counts as not known (knownName).
export function signoffsNeeded(
  policy: ApprovalPolicy,
  amount: PaymentAmount,
  newAccount: boolean,
  startedBy: string | null,
): SignoffRule {
  if (newAccount) {
    return { needed: 2, why: "it pays an account the original payment did not go to" };
  }
  if (knownName(startedBy) === null) {
    return { needed: 2, why: "PayOnce does not know who started this payment" };
  }
  if (amount.minor > policy.twoApproversAboveMinor) {
    return {
      needed: 2,
      why: `the amount is above ${formatMoney(policy.twoApproversAboveMinor, amount.currency)}`,
    };
  }
  return { needed: 1, why: "" };
}

// The approvers who could approve this payment: not barred and within their
// limit. A request that needs more than this can never be approved.
export function eligibleApprovers(
  policy: ApprovalPolicy,
  amount: PaymentAmount,
  barred: Barred[],
): Approver[] {
  return policy.approvers.filter(
    (approver: Approver): boolean =>
      approver.limitMinor >= amount.minor &&
      !barred.some((entry: Barred): boolean => sameName(entry.name, approver.name)),
  );
}

// The approver a name belongs to, or why that person cannot approve this payment.
// signedBy is who has approved it already.
export function checkSigner(
  policy: ApprovalPolicy,
  name: string,
  amount: PaymentAmount,
  barred: Barred[],
  signedBy: string[],
): Approver {
  if (policy.problem !== null) {
    throw new Error(`Approval refused: ${policy.problem}`);
  }
  const typed: string = personName(name, "Enter the approver's name");
  const approver: Approver | undefined = policy.approvers.find(
    (candidate: Approver): boolean => sameName(candidate.name, typed),
  );
  if (approver === undefined) {
    throw new Error(
      `${typed} is not an approver. The approvers are ${policy.approvers.map((candidate: Approver): string => candidate.name).join(", ")}`,
    );
  }
  const bar: Barred | undefined = barred.find((entry: Barred): boolean => sameName(entry.name, typed));
  if (bar !== undefined) {
    throw new Error(`${approver.name} ${bar.why}, so someone else approves this payment`);
  }
  if (signedBy.some((signer: string): boolean => sameName(signer, typed))) {
    throw new Error(`${approver.name} has approved this already. The next approval must come from someone else`);
  }
  if (amount.minor > approver.limitMinor) {
    throw new Error(
      `${approver.name} can approve up to ${formatMoney(approver.limitMinor, amount.currency)}, and this payment is ${formatMoney(amount.minor, amount.currency)}`,
    );
  }
  return approver;
}

// What a check of an approval needs from it, for an invoice's request and a
// run's alike.
export interface SignedRequest {
  binding: string;
  needed: number;
  signoffs: SignedBy[];
}

interface SignedBy {
  approver: string;
  binding: string;
}

// Why an approval no longer covers the payment under the approval policy as it
// is now, or null when it still does: every signoff has the request's binding,
// there are enough of them, and each signer still passes checkSigner. The policy
// may have changed since they signed: an approver removed, a limit lowered, or a
// rule that now needs two.
export function signoffProblem(
  policy: ApprovalPolicy,
  rule: SignoffRule,
  approval: SignedRequest,
  amount: PaymentAmount,
  barred: Barred[],
): string | null {
  if (approval.signoffs.some((signoff: SignedBy): boolean => signoff.binding !== approval.binding)) {
    return "an approver signed different terms";
  }
  const needed: number = Math.max(approval.needed, rule.needed);
  if (approval.signoffs.length < needed) {
    return `it now needs ${needed} approvers, because ${rule.why}`;
  }
  for (const signoff of approval.signoffs) {
    try {
      checkSigner(
        policy,
        signoff.approver,
        amount,
        barred,
        approval.signoffs
          .filter((other: SignedBy): boolean => other !== signoff)
          .map((other: SignedBy): string => other.approver),
      );
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}
