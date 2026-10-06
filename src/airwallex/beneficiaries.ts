import type { AirwallexClient } from "./client.js";

const DEMO_NICKNAME: string = "PayOnce demo supplier";

export interface Beneficiary {
  id: string;
  nickname?: string;
}

interface BeneficiaryList {
  items?: Beneficiary[];
}

export async function findOrCreateDemoBeneficiary(
  client: AirwallexClient,
): Promise<Beneficiary> {
  const list: BeneficiaryList = await client.get<BeneficiaryList>(
    "/api/v1/beneficiaries",
  );
  const existing: Beneficiary | undefined = (list.items ?? []).find(
    (beneficiary: Beneficiary): boolean => beneficiary.nickname === DEMO_NICKNAME,
  );
  if (existing !== undefined) {
    return existing;
  }

  return client.post<Beneficiary>("/api/v1/beneficiaries/create", {
    nickname: DEMO_NICKNAME,
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
  });
}
