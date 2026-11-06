import type { BeneficiaryRecord } from "../airwallex/beneficiaries.js";
import { AirwallexError, AirwallexUnreachableError, type AirwallexClient } from "../airwallex/client.js";
import type { TransferBankDetails } from "../airwallex/transfers.js";
import type { Settings } from "../settings.js";
import { readingSoft, type LastPaid, type Ledger, type TransferMethod } from "../store/ledger.js";
import type { BeneficiaryOption, BeneficiaryPickerView } from "./contract.js";
import { REFERENCE_PATTERN } from "../domain/patterns.js";
import { supplierKeyOf } from "./context.js";
import { iso, why } from "./parts.js";
import { CAUTION_LABELS } from "./supplier-pages.js";
import { supplierList, type SupplierSummary } from "./suppliers.js";

// The New payment form's supplier picker: the Airwallex beneficiaries, read with
// GETs only, and what the ledger knows of each.

const SHOWN: number = 20;

// What a read of Airwallex's beneficiary list gave: the records, or why it failed.
export type BeneficiaryRead =
  | { ok: true; records: BeneficiaryRecord[]; readAt: number }
  | { ok: false; problem: string; readAt: number };

interface BeneficiaryList {
  items?: BeneficiaryRecord[];
}

// One GET of the beneficiary list, as findOrCreateBeneficiary reads it. A failed
// read is an answer too: the page shows it and a retry.
export async function readBeneficiaries(client: AirwallexClient, now: () => number = Date.now): Promise<BeneficiaryRead> {
  try {
    const list: BeneficiaryList = await client.get<BeneficiaryList>("/api/v1/beneficiaries");
    return { ok: true, records: Array.isArray(list.items) ? list.items : [], readAt: now() };
  } catch (error: unknown) {
    if (error instanceof AirwallexUnreachableError) {
      return { ok: false, problem: "Couldn't read beneficiaries from Airwallex: the sandbox host did not answer.", readAt: now() };
    }
    if (error instanceof AirwallexError) {
      return { ok: false, problem: `Couldn't read beneficiaries from Airwallex: it answered ${error.status}.`, readAt: now() };
    }
    throw error;
  }
}

function endingOf(details: TransferBankDetails | undefined): string | null {
  const account: string | undefined = details?.account_number ?? details?.iban;
  return account === undefined || !/^[A-Za-z0-9]{4,}$/.test(account) ? null : account.slice(-4);
}

function nameOf(record: BeneficiaryRecord): string {
  const company: unknown = record.beneficiary?.["company_name"];
  return record.beneficiary?.bank_details?.account_name ?? (typeof company === "string" ? company : (record.nickname ?? "A beneficiary with no name"));
}

// The payment PayOnce last paid to the record, by Ledger.lastPaidTransfer, with
// when the bank paid it and the ending of the details it went to.
function lastPaidOf(ledger: Ledger, beneficiaryId: string): BeneficiaryOption["lastPaid"] {
  const lastPaid: LastPaid | undefined = ledger.lastPaidTransfer(beneficiaryId);
  if (lastPaid === undefined) {
    return null;
  }
  const paid: { paidAt: string | null; ending: string | null } | undefined = ledger.paidTransfer(lastPaid.transferId);
  const at: number = paid?.paidAt === null || paid === undefined ? Number.NaN : Date.parse(paid.paidAt);
  const ending: string | null = paid?.ending ?? null;
  return {
    at: Number.isFinite(at) ? iso(at) : null,
    reference: lastPaid.reference !== null && REFERENCE_PATTERN.test(lastPaid.reference) ? lastPaid.reference : null,
    ending: ending !== null && /^[A-Za-z0-9]{1,4}$/.test(ending) ? ending : null,
  };
}

function optionOf(ledger: Ledger, record: BeneficiaryRecord & { id: string }, summaries: Map<string, SupplierSummary>): BeneficiaryOption {
  const details: TransferBankDetails | undefined = record.beneficiary?.bank_details;
  const ending: string | null = endingOf(details);
  const country: unknown = details?.["bank_country_code"];
  return {
    key: record.id,
    name: nameOf(record),
    nickname: record.nickname ?? null,
    country: typeof country === "string" ? country : null,
    currency: details?.account_currency ?? null,
    methods: (record.transfer_methods ?? []).filter((method: string): method is TransferMethod => method === "LOCAL" || method === "SWIFT"),
    account:
      ending === null && details?.bank_name === undefined
        ? null
        : { label: [details?.bank_name, ending === null ? null : `account ending ${ending}`].filter((part: string | null | undefined): part is string => typeof part === "string").join(", "), ending },
    lastPaid: lastPaidOf(ledger, record.id),
    cautions: (summaries.get(record.id)?.cautions ?? []).map((code: SupplierSummary["cautions"][number]): string => CAUTION_LABELS[code]),
    onRecord: summaries.has(record.id),
  };
}

// The name, the nickname and the account ending, never inside the record's id,
// which every sandbox record shares most of. A whole id still finds its record.
function matches(option: BeneficiaryOption, q: string): boolean {
  const lower: string = q.toLowerCase();
  return (
    option.key.toLowerCase() === lower ||
    [option.name, option.nickname ?? "", option.account?.ending ?? ""].some((text: string): boolean => text.toLowerCase().includes(lower))
  );
}

export function beneficiaryPicker(ledger: Ledger, settings: Settings, now: number, q: string, read: BeneficiaryRead): BeneficiaryPickerView {
  return readingSoft((): BeneficiaryPickerView => {
    if (!read.ok) {
      return { view: "beneficiaries", q, options: [], problem: why("airwallex-unreadable", read.problem), readAt: iso(read.readAt) };
    }
    const summaries: Map<string, SupplierSummary> = new Map(
      supplierList(ledger, settings.bankDeadlineMinutes, now).suppliers.flatMap((summary: SupplierSummary): [string, SupplierSummary][] =>
        summary.key === null ? [] : [[summary.key, summary]],
      ),
    );
    return {
      view: "beneficiaries",
      q,
      options: read.records
        .filter((record: BeneficiaryRecord): record is BeneficiaryRecord & { id: string } => typeof record.id === "string" && supplierKeyOf(record.id) !== null)
        .map((record: BeneficiaryRecord & { id: string }): BeneficiaryOption => optionOf(ledger, record, summaries))
        .filter((option: BeneficiaryOption): boolean => q === "" || matches(option, q))
        .slice(0, SHOWN),
      problem: null,
      readAt: iso(read.readAt),
    };
  });
}
