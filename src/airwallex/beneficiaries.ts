import { AirwallexError, type AirwallexClient } from "./client.js";
import type { TransferBankDetails } from "./transfers.js";

export interface Beneficiary {
  id: string;
  nickname?: string;
}

interface BeneficiaryList {
  items?: Beneficiary[];
}

// The request body for beneficiaries/create. Required fields differ by corridor.
export interface BeneficiarySpec {
  nickname: string;
  transfer_methods: string[];
  beneficiary: Record<string, unknown>;
}

// Synthetic suppliers. Airwallex checks routing numbers and IBAN checksums when a
// beneficiary is created, so those two values are well-formed.
export const US_LOCAL_SUPPLIER: BeneficiarySpec = {
  nickname: "PayOnce demo supplier",
  transfer_methods: ["LOCAL"],
  beneficiary: {
    entity_type: "COMPANY",
    company_name: "Example Supplier LLC",
    address: {
      street_address: "1 Main St",
      city: "New York",
      state: "NY",
      postcode: "10001",
      country_code: "US",
    },
    bank_details: {
      account_currency: "USD",
      bank_country_code: "US",
      account_name: "Example Supplier LLC",
      account_number: "123456789",
      account_routing_type1: "aba",
      account_routing_value1: "021000021",
      bank_name: "JPMorgan Chase Bank",
      bank_account_category: "Checking",
      local_clearing_system: "ACH",
    },
  },
};

export const DE_SWIFT_SUPPLIER: BeneficiarySpec = {
  nickname: "PayOnce demo supplier GmbH",
  transfer_methods: ["SWIFT"],
  beneficiary: {
    entity_type: "COMPANY",
    company_name: "Example Supplier GmbH",
    address: {
      street_address: "Musterstrasse 1",
      city: "Berlin",
      postcode: "10115",
      country_code: "DE",
    },
    bank_details: {
      account_currency: "EUR",
      bank_country_code: "DE",
      account_name: "Example Supplier GmbH",
      iban: "DE89370400440532013000",
      swift_code: "COBADEFFXXX",
      bank_name: "Commerzbank",
    },
  },
};

// The same supplier for the bank change scenario. Each run gets a record of its
// own, under this nickname and the invoice number, so a bank change in one run
// reaches no other incident.
export const US_BANK_CHANGE_SUPPLIER: BeneficiarySpec = {
  ...US_LOCAL_SUPPLIER,
  nickname: "PayOnce demo supplier (bank change)",
};

// A beneficiary as Airwallex returns it. Only the fields the code reads are named.
export interface BeneficiaryRecord {
  id?: string;
  nickname?: string;
  payer_entity_type?: string;
  transfer_methods?: string[];
  beneficiary?: { bank_details?: TransferBankDetails; [field: string]: unknown };
}

export function getBeneficiary(
  client: AirwallexClient,
  beneficiaryId: string,
): Promise<BeneficiaryRecord> {
  return client.get<BeneficiaryRecord>(`/api/v1/beneficiaries/${beneficiaryId}`);
}

// The record, or undefined when Airwallex has none with this id. The sandbox
// answers 200 with an empty body for an unknown id that is well formed, and 400
// for one that is not. Any other error, such as Airwallex being unreachable, is
// thrown, so an outage never reads as every beneficiary being unknown.
export async function findBeneficiary(
  client: AirwallexClient,
  beneficiaryId: string,
): Promise<BeneficiaryRecord | undefined> {
  try {
    const record: BeneficiaryRecord = await getBeneficiary(client, beneficiaryId);
    return record.id === beneficiaryId ? record : undefined;
  } catch (error: unknown) {
    if (error instanceof AirwallexError && (error.status === 400 || error.status === 404)) {
      return undefined;
    }
    throw error;
  }
}

// Fields of a beneficiary that a bank transfer's record does not need sent back.
const NOT_SENT: readonly string[] = ["card", "digital_wallet"];

// Replaces the record's bank details and keeps the rest of it as it is. Airwallex
// works out the fingerprint of the details itself, so the old one is not sent.
export function updateBankDetails(
  client: AirwallexClient,
  beneficiaryId: string,
  record: BeneficiaryRecord,
  bankDetails: TransferBankDetails,
): Promise<BeneficiaryRecord> {
  const beneficiary: Record<string, unknown> = { ...record.beneficiary };
  for (const field of NOT_SENT) {
    delete beneficiary[field];
  }
  const { fingerprint: _fingerprint, ...details } = bankDetails;
  return client.post<BeneficiaryRecord>(`/api/v1/beneficiaries/${beneficiaryId}/update`, {
    beneficiary: { ...beneficiary, bank_details: details },
    nickname: record.nickname,
    payer_entity_type: record.payer_entity_type,
    transfer_methods: record.transfer_methods,
  });
}

// The bank details a new transfer to this beneficiary would be paid to.
export async function getBankDetails(
  client: AirwallexClient,
  beneficiaryId: string,
): Promise<TransferBankDetails> {
  const record: BeneficiaryRecord = await getBeneficiary(client, beneficiaryId);
  const details: TransferBankDetails | undefined = record.beneficiary?.bank_details;
  if (details === undefined) {
    throw new Error(`Beneficiary ${beneficiaryId} has no bank details`);
  }
  return details;
}

export async function findOrCreateBeneficiary(
  client: AirwallexClient,
  spec: BeneficiarySpec,
): Promise<Beneficiary> {
  const list: BeneficiaryList = await client.get<BeneficiaryList>(
    "/api/v1/beneficiaries",
  );
  const existing: Beneficiary | undefined = (list.items ?? []).find(
    (beneficiary: Beneficiary): boolean => beneficiary.nickname === spec.nickname,
  );
  return existing ?? client.post<Beneficiary>("/api/v1/beneficiaries/create", spec);
}
