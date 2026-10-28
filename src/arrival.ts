import type { TransferBankDetails } from "./airwallex/transfers.js";
import type { Ledger, TransferMethod } from "./ledger.js";
import { formatMoney } from "./money.js";

// A route PayOnce knows the usual arrival of, in business days, from Airwallex's
// payout network pages for the United States and Germany, read on 2026-10-28.
// A row with no currency covers every currency the route takes. clearing is the
// local clearing system on the beneficiary record, and a US local record with
// none pays by ACH. Every ACH payment gets 0 to 2 days. Airwallex sends ACH as
// Next Day ACH, 1 to 2 days, above 1,000,000 USD or for a payer outside the US,
// as the sandbox account's is. For those the earliest day shown is a day early,
// and the latest day is right.
interface Corridor {
  country: string;
  currency: string | null;
  method: TransferMethod;
  clearing: string | null;
  route: string;
  minDays: number;
  maxDays: number;
}

const CORRIDORS: readonly Corridor[] = [
  { country: "US", currency: "USD", method: "LOCAL", clearing: "ACH", route: "ACH", minDays: 0, maxDays: 2 },
  {
    country: "US",
    currency: "USD",
    method: "LOCAL",
    clearing: "NEXT_DAY_ACH",
    route: "Next Day ACH",
    minDays: 1,
    maxDays: 2,
  },
  { country: "US", currency: "USD", method: "LOCAL", clearing: "FEDNOW", route: "FedNow", minDays: 0, maxDays: 1 },
  { country: "US", currency: "USD", method: "LOCAL", clearing: "FEDWIRE", route: "Fedwire", minDays: 0, maxDays: 1 },
  { country: "US", currency: null, method: "SWIFT", clearing: null, route: "SWIFT", minDays: 0, maxDays: 3 },
  { country: "DE", currency: "EUR", method: "LOCAL", clearing: null, route: "SEPA", minDays: 0, maxDays: 2 },
  { country: "DE", currency: null, method: "SWIFT", clearing: null, route: "SWIFT", minDays: 0, maxDays: 3 },
];

const DEFAULT_US_CLEARING: string = "ACH";
const DUE_DATE_PATTERN: RegExp = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const FIRST_YEAR: number = 2000;
const LAST_YEAR: number = 2099;
const MS_PER_DAY: number = 86_400_000;

export const HOLIDAYS_NOTE: string =
  "The dates count weekdays only. A public holiday counts as a working day, so a payment may arrive a day or more later";

// When a payment usually arrives, as the people approving it see it. route, the
// days and the dates are null on a route PayOnce has no figures for. from is the
// day the estimate counts from, as if the payment were sent that day, and earliest
// and latest are the business days it usually arrives between. dueDate is the
// invoice's, or null. Build it only with arrivalFor or arrivalBlock, so the key
// order, and with it any binding, stays stable.
export interface ArrivalTerms {
  method: TransferMethod;
  country: string | null;
  route: string | null;
  minDays: number | null;
  maxDays: number | null;
  from: string;
  earliest: string | null;
  latest: string | null;
  dueDate: string | null;
}

// on-time: the latest usual day is on or before the due date. may-be-late: only
// the earliest is. late: even the earliest is after it. passed: the due date was
// before the day the estimate counts from. unknown: the route has no figures.
export type ArrivalRisk = "on-time" | "may-be-late" | "late" | "passed" | "unknown";

const RISK_WORDS: Record<ArrivalRisk, string> = {
  "on-time": "on time",
  "may-be-late": "may arrive late",
  late: "arrives late even at its fastest",
  passed: "the due date has passed",
  unknown: "PayOnce cannot say if it is on time",
};

// Why a due date cannot be read, or null for a calendar day written as
// YYYY-MM-DD. A day in the past is allowed, and the estimate says it has passed.
export function dueDateProblem(raw: string): string | null {
  const match: RegExpExecArray | null = DUE_DATE_PATTERN.exec(raw);
  if (match === null) {
    return `The due date ${raw.slice(0, 20)} is not a date written like 2026-11-02`;
  }
  const year: number = Number(match[1]);
  const month: number = Number(match[2]);
  const day: number = Number(match[3]);
  const date: Date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return `The due date ${raw} is not a day on the calendar`;
  }
  if (year < FIRST_YEAR || year > LAST_YEAR) {
    return `The due date ${raw} is not between ${FIRST_YEAR} and ${LAST_YEAR}`;
  }
  return null;
}

// Today on this machine's calendar, as YYYY-MM-DD.
export function today(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dayOf(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function dayText(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function weekend(at: number): boolean {
  const weekday: number = new Date(at).getUTCDay();
  return weekday === 0 || weekday === 6;
}

// The business day a number of business days after the day, counting from the
// day itself, or from the Monday after it when it falls on a weekend. Public
// holidays are not known, so they count as business days.
export function addBusinessDays(day: string, days: number): string {
  let at: number = dayOf(day);
  while (weekend(at)) {
    at += MS_PER_DAY;
  }
  for (let left: number = days; left > 0; ) {
    at += MS_PER_DAY;
    if (!weekend(at)) {
      left -= 1;
    }
  }
  return dayText(at);
}

function field(details: TransferBankDetails | undefined, name: string): string | null {
  const value: unknown = details?.[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim().toUpperCase() : null;
}

function corridorFor(
  method: TransferMethod,
  currency: string,
  country: string | null,
  clearing: string | null,
): Corridor | undefined {
  return CORRIDORS.find(
    (corridor: Corridor): boolean =>
      corridor.country === country &&
      corridor.method === method &&
      (corridor.currency === null || corridor.currency === currency) &&
      (corridor.clearing === null || corridor.clearing === (clearing ?? DEFAULT_US_CLEARING)),
  );
}

// Copies an estimate in one key order.
export function arrivalBlock(arrival: ArrivalTerms): ArrivalTerms {
  return {
    method: arrival.method,
    country: arrival.country,
    route: arrival.route,
    minDays: arrival.minDays,
    maxDays: arrival.maxDays,
    from: arrival.from,
    earliest: arrival.earliest,
    latest: arrival.latest,
    dueDate: arrival.dueDate,
  };
}

// When a payment by this method in this currency, to the bank details on the
// beneficiary record, usually arrives if it is sent on the day from. The record
// gives the country and, for a US local payment, the clearing system.
export function arrivalFor(
  method: TransferMethod,
  currency: string,
  details: TransferBankDetails | undefined,
  dueDate: string | null,
  from: string,
): ArrivalTerms {
  const country: string | null = field(details, "bank_country_code");
  const corridor: Corridor | undefined = corridorFor(
    method,
    currency,
    country,
    field(details, "local_clearing_system"),
  );
  return arrivalBlock({
    method,
    country,
    route: corridor?.route ?? null,
    minDays: corridor?.minDays ?? null,
    maxDays: corridor?.maxDays ?? null,
    from,
    earliest: corridor === undefined ? null : addBusinessDays(from, corridor.minDays),
    latest: corridor === undefined ? null : addBusinessDays(from, corridor.maxDays),
    dueDate,
  });
}

// How the estimate stands against the due date, or null when there is none.
export function arrivalRisk(arrival: ArrivalTerms): ArrivalRisk | null {
  if (arrival.dueDate === null) {
    return null;
  }
  if (arrival.dueDate < arrival.from) {
    return "passed";
  }
  if (arrival.earliest === null || arrival.latest === null) {
    return "unknown";
  }
  if (arrival.earliest > arrival.dueDate) {
    return "late";
  }
  return arrival.latest > arrival.dueDate ? "may-be-late" : "on-time";
}

// True when the payment may miss its due date, or the date has passed.
export function atRisk(arrival: ArrivalTerms): boolean {
  const risk: ArrivalRisk | null = arrivalRisk(arrival);
  return risk === "may-be-late" || risk === "late" || risk === "passed";
}

function daysText(minDays: number, maxDays: number): string {
  return minDays === maxDays
    ? `${maxDays} business ${maxDays === 1 ? "day" : "days"}`
    : `${minDays} to ${maxDays} business days`;
}

// "LOCAL to SG"
function methodText(arrival: ArrivalTerms): string {
  return `${arrival.method}${arrival.country === null ? "" : ` to ${arrival.country}`}`;
}

// The route and how long it usually takes, such as "SWIFT, usually 0 to 3
// business days", or "LOCAL to SG, arrival not known".
export function routeText(arrival: ArrivalTerms): string {
  return arrival.route === null || arrival.minDays === null || arrival.maxDays === null
    ? `${methodText(arrival)}, arrival not known`
    : `${arrival.route}, usually ${daysText(arrival.minDays, arrival.maxDays)}`;
}

// "SWIFT, usually 0 to 3 business days, by 2026-11-02 if sent on 2026-10-28"
function byText(arrival: ArrivalTerms): string {
  const by: string = arrival.latest === null ? "" : `, by ${arrival.latest} if sent on ${arrival.from}`;
  return `${routeText(arrival)}${by}`;
}

// "due 2026-10-30; may arrive late", or null when there is no due date.
function dueText(arrival: ArrivalTerms): string | null {
  const risk: ArrivalRisk | null = arrivalRisk(arrival);
  return risk === null ? null : `due ${arrival.dueDate ?? ""}; ${RISK_WORDS[risk]}`;
}

// "SWIFT, usually 0 to 3 business days, by 2026-11-02 if sent on 2026-10-28;
// due 2026-10-30; may arrive late"
export function arrivalText(arrival: ArrivalTerms): string {
  const due: string | null = dueText(arrival);
  return due === null ? byText(arrival) : `${byText(arrival)}; ${due}`;
}

// The same estimate as if the payment were sent on another day. Only the dates
// change, so nothing is read again.
export function ifSentOn(arrival: ArrivalTerms, day: string): ArrivalTerms {
  return arrivalBlock({
    ...arrival,
    from: day,
    earliest: arrival.minDays === null ? null : addBusinessDays(day, arrival.minDays),
    latest: arrival.maxDays === null ? null : addBusinessDays(day, arrival.maxDays),
  });
}

// What the page and the CLI show for an estimate, so neither keeps its own copy
// of the wording. It is never in the terms, so no binding changes with it. text
// is route and due together. sentToday is set when the estimate counts from a day
// before today, as an open request keeps it after midnight, and says when the
// payment usually arrives if it is sent today.
export interface ArrivalAdvice {
  text: string;
  route: string;
  due: string | null;
  risk: ArrivalRisk | null;
  atRisk: boolean;
  sentToday: { text: string; atRisk: boolean } | null;
  note: string;
}

export function arrivalAdvice(arrival: ArrivalTerms, on: string = today()): ArrivalAdvice {
  const now: ArrivalTerms = ifSentOn(arrival, on);
  const risk: ArrivalRisk | null = arrivalRisk(now);
  return {
    text: arrivalText(arrival),
    route: byText(arrival),
    due: dueText(arrival),
    risk: arrivalRisk(arrival),
    atRisk: atRisk(arrival),
    sentToday:
      arrival.from >= on || now.latest === null
        ? null
        : {
            text: `if sent today, ${on}, usually by ${now.latest}${risk === null ? "" : `; ${RISK_WORDS[risk]}`}`,
            atRisk: atRisk(now),
          },
    note: HOLIDAYS_NOTE,
  };
}

// The timeline line for a payment just sent, such as "Original P261028-ABC usually
// arrives between 2026-10-28 and 2026-10-30. ACH takes 0 to 2 business days. Due
// 2026-11-02, so it should arrive in time. ..."
export function sentArrivalText(payment: string, arrival: ArrivalTerms): string {
  const due: string = arrival.dueDate ?? "";
  if (arrival.route === null || arrival.minDays === null || arrival.maxDays === null) {
    const unknown: string = `${payment} has no arrival estimate, because PayOnce has no figures for ${methodText(arrival)}`;
    return arrival.dueDate === null ? unknown : `${unknown}. Due ${due}`;
  }
  const window: string =
    arrival.earliest === arrival.latest
      ? `${payment} usually arrives on ${arrival.latest ?? ""}`
      : `${payment} usually arrives between ${arrival.earliest ?? ""} and ${arrival.latest ?? ""}`;
  const takes: string = `${window}. ${arrival.route} takes ${daysText(arrival.minDays, arrival.maxDays)}`;
  switch (arrivalRisk(arrival)) {
    case "on-time":
      return `${takes}. Due ${due}, so it should arrive in time. ${HOLIDAYS_NOTE}`;
    case "may-be-late":
      return `${takes}. Due ${due}, so it may arrive late. ${HOLIDAYS_NOTE}`;
    case "late":
      return `${takes}. Due ${due}, so even at its fastest it arrives late. ${HOLIDAYS_NOTE}`;
    case "passed":
      return `${takes}. The due date, ${due}, has already passed. ${HOLIDAYS_NOTE}`;
    default:
      return `${takes}. ${HOLIDAYS_NOTE}`;
  }
}

// What the decision line adds about a replacement: when one sent now usually
// arrives, against the due date.
export function replacementArrivalText(arrival: ArrivalTerms): string {
  const due: string = arrival.dueDate ?? "";
  if (arrival.route === null || arrival.minDays === null || arrival.maxDays === null) {
    return `PayOnce has no arrival estimate for a replacement by ${methodText(arrival)}. Due ${due}`;
  }
  const sent: string = `A replacement sent on ${arrival.from} usually arrives by ${arrival.latest ?? ""} (${arrival.route}, ${daysText(arrival.minDays, arrival.maxDays)})`;
  switch (arrivalRisk(arrival)) {
    case "on-time":
      return `${sent}, in time for the due date, ${due}. ${HOLIDAYS_NOTE}`;
    case "may-be-late":
      return `${sent}, so it may miss the due date, ${due}. ${HOLIDAYS_NOTE}`;
    case "late":
      return `${sent}, and even at its fastest it misses the due date, ${due}. ${HOLIDAYS_NOTE}`;
    case "passed":
      return `${sent}. The due date, ${due}, has passed. ${HOLIDAYS_NOTE}`;
    default:
      return `${sent}. ${HOLIDAYS_NOTE}`;
  }
}

// The fee PayOnce last recorded on a payment in this currency by this method, as
// an estimate, or that it has seen none.
export function feeSeenText(ledger: Ledger, currency: string, method: TransferMethod): string {
  const fee: number | null = ledger.latestFee(currency, method);
  return fee === null
    ? `no ${method} fee in ${currency} seen yet`
    : `${method} fee last seen ${formatMoney(fee, currency)}`;
}
