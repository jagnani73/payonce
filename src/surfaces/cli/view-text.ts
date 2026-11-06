import { utcText } from "../../alerts/alert-payloads.js";
import { timedText, type Timed } from "../../domain/timed.js";
import { printable, say } from "../../text/printable.js";
import type {
  ApproverChoice,
  Barred,
  Can,
  Caution,
  IncidentRow,
  IncidentView,
  Money,
  PaymentFacts,
  RowTag,
  RunRowItem,
  Situation,
  TimelineLine,
  WalletTotals,
  Why,
} from "../../views/contract.js";

// The pieces the terminal commands print the views with. Every line goes through
// printable, so a name, a note or an Airwallex word cannot start a line of its own
// or move the cursor. Times are UTC, as "2 Nov 2026, 09:00 UTC".

export type Field = [label: string, value: string | string[]];

const STEP: string = "  ";

// The text as printable makes it, keeping the spaces it starts with.
function clean(text: string): string {
  const shown: string = printable(text);
  return shown === "" ? "" : `${/^ */.exec(text)?.[0] ?? ""}${shown}`;
}

// One line, indented by steps of two spaces.
export function put(text: string = "", indent: number = 0): void {
  const shown: string = clean(text);
  say(shown === "" ? "" : `${STEP.repeat(indent)}${shown}`);
}

export function putAll(lines: string[], indent: number = 0): void {
  for (const line of lines) {
    put(line, indent);
  }
}

// A heading after a blank line.
export function heading(text: string): void {
  put();
  put(text);
}

export function utc(at: string | null): string {
  return at === null ? "a time not on file" : utcText(at);
}

// A sentence that names times, each written in UTC.
export function said(sentence: Timed): string {
  return timedText(sentence, utc);
}

// How long since a time, in its largest whole unit.
function age(since: string | null, now: string): string {
  const at: number = since === null ? Number.NaN : Date.parse(since);
  if (!Number.isFinite(at)) {
    return "for a time not on file";
  }
  const minutes: number = Math.max(0, Math.floor((Date.parse(now) - at) / 60_000));
  if (minutes < 1) {
    return "under a minute";
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours: number = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

export function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function money(item: Money): string {
  return item.estimated === true ? `${item.text} (estimated)` : item.text;
}

function moneyList(items: Money[]): string {
  return items.length === 0 ? "nothing" : listOf(items.map(money));
}

// A situation's label and its detail, as the state chip and the line under it.
export function situationLine(situation: { label: string; detail: Timed | null }): string {
  return situation.detail === null ? situation.label : `${situation.label} · ${said(situation.detail)}`;
}

// What happens next, why, when the next line does not say it already, and what
// stands in the way.
function situationLines(situation: Situation): string[] {
  const why: string | null = situation.why?.text ?? null;
  const next: string = said(situation.next);
  return [
    next,
    ...(why === null || next.toLowerCase().includes(why.toLowerCase()) ? [] : [`Why: ${why}`]),
    ...situation.blockers.map((blocker: { text: Timed }): string => `Blocked: ${said(blocker.text)}`),
    ...situation.also.map((line: string): string => `Also: ${line}`),
  ];
}

// A payment's page header: the payment, its state and what it waits on.
export function putPayment(view: IncidentView): void {
  const facts: PaymentFacts = view.payment;
  const from: Money | null = facts.crossCurrency ? view.money.fromWallet : null;
  put(`Payment ${facts.invoiceId} · ${facts.supplier} · ${facts.amount.text}${from === null ? "" : `, from the ${from.currency} wallet: ${money(from)}`}`);
  put(situationLine(view.situation));
  putAll(situationLines(view.situation));
  if (view.incident !== null) {
    put(`Incident: ${view.incident.cause}`);
  }
}

// The cautions, less those the header printed already.
export function putCautions(cautions: Caution[], shown: string[] = []): void {
  const left: string[] = cautions.map((caution: Caution): string => said(caution.text)).filter((text: string): boolean => !shown.includes(text));
  if (left.length > 0) {
    heading("Cautions");
    putAll(left.map((text: string): string => `! ${text}`), 1);
  }
}

export function whyNot(can: Can): string | null {
  return can.allowed ? null : (can.why?.text ?? "Not allowed now.");
}

// Rows of cells, each column as wide as its widest cell. The columns named in
// right line up on their right edge, such as amounts.
export function table(rows: string[][], right: number[] = []): string[] {
  const cells: string[][] = rows.map((row: string[]): string[] => row.map(clean));
  const widths: number[] = [];
  for (const row of cells) {
    row.forEach((cell: string, index: number): void => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return cells.map((row: string[]): string =>
    row
      .map((cell: string, index: number): string =>
        right.includes(index) ? cell.padStart(widths[index] ?? 0) : index < row.length - 1 ? cell.padEnd(widths[index] ?? 0) : cell,
      )
      .join("  ")
      .trimEnd(),
  );
}

// Labelled values, one value a line, the labels in one column.
export function putFields(fields: Field[], indent: number = 1): void {
  const rows: string[][] = fields.flatMap(([label, value]: Field): string[][] =>
    (typeof value === "string" ? [value] : value).map((text: string, index: number): string[] => [index === 0 ? label : "", text]),
  );
  putAll(table(rows), indent);
}

// One timeline line: when, its kind and the line as stored, with the chip a
// decision line carries.
function timelineLine(line: TimelineLine): string[] {
  const repeat: string = line.repeat === null ? "" : ` (${line.repeat.count} times since ${utc(line.repeat.firstAt)})`;
  return [utc(line.at), line.kindLabel, `${line.lead === null ? "" : `${line.lead}: `}${line.text}${repeat}`];
}

// The newest lines of a timeline that are not system lines, oldest first.
export function putTimeline(lines: TimelineLine[], shown: number, indent: number = 1): void {
  putAll(table(lines.filter((line: TimelineLine): boolean => !line.system).slice(0, shown).reverse().map(timelineLine)), indent);
}

// ---------- requests ----------

interface Signing {
  label: string;
  requestedAt: string | null;
  expiresAt: string | null;
  needed: number;
  neededWhy: Why | null;
  signoffs: { name: string; at: string }[];
  approvers: ApproverChoice[];
  barred: Barred[];
}

function approverText(choice: ApproverChoice): string {
  const limit: string = `${choice.name} (up to ${money(choice.limit)})`;
  return choice.canApprove ? `${limit}, can approve` : `${limit}: ${choice.why?.text ?? "cannot approve now"}`;
}

// Who signed a request, who can sign it now and who may not.
export function signingFields(request: Signing): Field[] {
  return [
    ["Requested", utc(request.requestedAt)],
    ["Expires", utc(request.expiresAt)],
    ["Needs", `${count(request.needed, "signoff", "signoffs")}${request.neededWhy === null ? "" : `, because ${request.neededWhy.text}`}`],
    ...(request.signoffs.length === 0
      ? []
      : [["Signed", request.signoffs.map((signoff: { name: string; at: string }): string => `${signoff.name} at ${utc(signoff.at)}`)] as Field]),
    ["Approvers", request.approvers.length === 0 ? "Nobody is on the approver list" : request.approvers.map(approverText)],
    ...(request.barred.length === 0
      ? []
      : [["Barred", request.barred.map((entry: Barred): string => `${entry.name}, who ${entry.why.text}`)] as Field]),
  ];
}

interface Option {
  title: string;
  consequence: string[];
  can: Can;
}

// What choosing an option does, and why it cannot be chosen now.
export function putConsequence(option: Option, indent: number = 1): void {
  putAll(option.consequence, indent);
  const not: string | null = whyNot(option.can);
  if (not !== null) {
    put(`Not now: ${not}`, indent);
  }
}

export function putOption(option: Option, indent: number = 1): void {
  put(option.title, indent);
  putConsequence(option, indent + 1);
}

// ---------- lists ----------

// The command that does what a row's primary action does, where one does.
function commandOf(row: IncidentRow): string | null {
  const id: string = row.invoiceId;
  switch (row.primary?.kind) {
    case "approve":
      return `pnpm approve ${id}`;
    case "close-paid":
    case "close-unpaid":
      return `pnpm close ${id}`;
    case "end-outage":
      return "pnpm outage";
    case "trace":
      return `pnpm outbox ${id}`;
    case "callback":
      return "pnpm ui, on the payment's page";
    default:
      return null;
  }
}

function runCommandOf(item: RunRowItem): string {
  switch (item.primary.kind) {
    case "approve":
      return `pnpm payrun approve ${item.runId}`;
    case "recheck":
      return `pnpm payrun check ${item.runId}`;
    case "end-outage":
      return "pnpm outage";
    case "open":
      return `pnpm payrun show ${item.runId}`;
  }
}

export interface Listed {
  head: string[];
  lines: string[];
}

// A payment as a row in a list: one line to rank it by, then what it waits on.
export function paymentRow(row: IncidentRow, now: string): Listed {
  const situation: Situation = row.situation;
  const command: string | null = commandOf(row);
  // The blockers and the wallet a payment leaves have lines of their own.
  const tags: string[] = row.tags
    .filter((tag: RowTag): boolean => tag.code !== "blocked" && !(tag.code === "cross-currency" && row.fromWallet !== null))
    .map((tag: RowTag): string => tag.text);
  return {
    head: [row.invoiceId, row.supplier, row.amount.text, situation.group === "closed" ? situation.label : `${situation.label}, waiting ${age(row.waitingSince, now)}`],
    lines: [
      ...(situation.detail === null ? [] : [said(situation.detail)]),
      ...(row.fromWallet === null ? [] : [`From the ${row.fromWallet.currency} wallet: ${money(row.fromWallet)}`]),
      ...situationLines(situation),
      ...(tags.length === 0 ? [] : [tags.join(" · ")]),
      ...(command === null ? [] : [`Next step: ${command}`]),
    ],
  };
}

export function runRow(item: RunRowItem, now: string): Listed {
  return {
    head: [`Pay run ${item.runId}`, item.fileName, moneyList(item.totals), `${item.label}, waiting ${age(item.waitingSince, now)}`],
    lines: [said(item.next), `Next step: ${runCommandOf(item)}`],
  };
}

// Rows with their first lines in columns, each followed by its own lines. The
// amount is the third column, unless amountAt says otherwise.
export function putRows(rows: Listed[], amountAt: number = 2, indent: number = 1): void {
  const heads: string[] = table(
    rows.map((row: Listed): string[] => row.head),
    [amountAt],
  );
  rows.forEach((row: Listed, index: number): void => {
    put(heads[index] ?? "", indent);
    putAll(row.lines, indent + 1);
  });
}

// What each wallet has in play, the buckets that hold any.
export function walletLine(total: WalletTotals): string[] {
  const parts: [Money, string][] = [
    [total.promised, "promised"],
    [total.waitingOnPeople, "waiting on people"],
    [total.pausedByOutage, "paused by an outage"],
    [total.runWaiting, "pay run waiting for approval"],
    [total.withBank, "with the bank"],
  ];
  const shown: string[] = parts
    .filter(([amount]: [Money, string]): boolean => amount.minor !== 0)
    .map(([amount, what]: [Money, string]): string => `${what} ${amount.text}`);
  const notes: string[] = [
    ...(total.estimated ? ["part estimated"] : []),
    ...(total.feeUnknown > 0 ? [`fee not known for ${total.feeUnknown}`] : []),
  ];
  return [total.wallet, `${shown.length === 0 ? "nothing" : shown.join(", ")}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`];
}
