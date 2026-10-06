import type { AirwallexClient } from "./client.js";

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
