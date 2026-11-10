import { createHash } from "node:crypto";

// A stand-in for the Airwallex sandbox API at https://sandbox.invalid, answered
// inside the test process. It keeps the bank in memory and answers each call at
// once, so calls are answered in the order PayOnce makes them. It follows
// docs/design/sandbox-behaviour.md where PayOnce relies on it, and nothing moves
// a transfer by itself: the journey plays the bank (pay, fail) and a person in
// the Airwallex web app (sendOutside, editBeneficiary) between PayOnce's steps.

export const FAKE_CLIENT_ID: string = "journey-client-id-not-a-real-key";
export const FAKE_API_KEY: string = "journey-api-key-not-a-real-key";
const TOKEN_LIFE_MS: number = 30 * 60_000;

export type FailureType = "CHANNEL_TIMEOUT" | "SYSTEM_ERROR" | "ACCOUNT_CLOSED";

const FAILURES: Record<FailureType, { code: string; message: string }> = {
  CHANNEL_TIMEOUT: { code: "91402", message: "Channel timeout" },
  SYSTEM_ERROR: { code: "91401", message: "System error" },
  ACCOUNT_CLOSED: { code: "90701", message: "Account closed" },
};

const FEES_MAJOR: Record<string, number> = { LOCAL: 0, SWIFT: 13.91 };

export type BankDetails = Record<string, string>;

export interface BeneficiaryRecord {
  id: string;
  nickname: string;
  payer_entity_type: string;
  transfer_methods: string[];
  beneficiary: {
    entity_type: string;
    company_name: string;
    address: Record<string, string>;
    bank_details: BankDetails;
  };
}

export interface FakeTransfer {
  id: string;
  requestId: string;
  reference: string;
  shortReference: string;
  createdMs: number;
  status: string;
  failure: { code: string; message: string } | null;
  method: string;
  amountMinor: number;
  currency: string;
  feeMinor: number;
  beneficiaryId: string;
  bankDetails: BankDetails;
  // False for a payout a person sent in the Airwallex web app.
  byPayOnce: boolean;
}

// One API call PayOnce made, as the bank answered it.
export interface BankCall {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface Login {
  clientId: string;
  apiKey: string;
}

interface Answer {
  status: number;
  body?: unknown;
}

// The records the bank starts with. The demo supplier is the one the scripted
// incidents pay (by its nickname), and payees A to D are plain US suppliers.
export const DEMO_SUPPLIER: string = "b0000001-0000-4000-8000-000000000001";

export function payee(letter: "A" | "B" | "C" | "D"): string {
  return `b0000001-0000-4000-8000-00000000001${"ABCD".indexOf(letter)}`;
}

function usSupplier(id: string, nickname: string, name: string, accountNumber: string): BeneficiaryRecord {
  return {
    id,
    nickname,
    payer_entity_type: "COMPANY",
    transfer_methods: ["LOCAL"],
    beneficiary: {
      entity_type: "COMPANY",
      company_name: name,
      address: { street_address: "1 Main St", city: "New York", state: "NY", postcode: "10001", country_code: "US" },
      bank_details: fingerprinted({
        account_currency: "USD",
        bank_country_code: "US",
        account_name: name,
        account_number: accountNumber,
        account_routing_type1: "aba",
        account_routing_value1: "021000021",
        bank_name: "JPMorgan Chase Bank",
        bank_account_category: "Checking",
        local_clearing_system: "ACH",
      }),
    },
  };
}

function seedRecords(): BeneficiaryRecord[] {
  return [
    usSupplier(DEMO_SUPPLIER, "PayOnce demo supplier", "Example Supplier LLC", "123456789"),
    ...(["A", "B", "C", "D"] as const).map(
      (letter: "A" | "B" | "C" | "D", index: number): BeneficiaryRecord =>
        usSupplier(payee(letter), `Journey payee ${letter}`, `Payee ${letter} Inc`, `55500000${index}`),
    ),
  ];
}

// Airwallex keeps a fingerprint of the bank details inside them, on the record
// and on every transfer made to it.
function fingerprinted(details: BankDetails): BankDetails {
  const { fingerprint: _old, ...rest } = details;
  return { ...rest, fingerprint: createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 32) };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toMinor(amount: unknown): number {
  return Math.round(Number(amount) * 100);
}

function toMajor(minor: number): number {
  return minor / 100;
}

// 2026-11-02T09:00:00+0000, as Airwallex writes created_at.
function airwallexTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}+0000`;
}

function refusal(status: number, code: string, message: string): Answer {
  return { status, body: { code, message } };
}

export class FakeAirwallex {
  readonly calls: BankCall[] = [];
  readonly logins: Login[] = [];
  readonly transfers: FakeTransfer[] = [];
  private readonly records: BeneficiaryRecord[] = seedRecords();
  private readonly balances: Map<string, number>;
  private readonly tokens: Map<string, number> = new Map<string, number>();

  // Opening balances in major units, such as { USD: 100000 }.
  constructor(balances: Record<string, number>) {
    this.balances = new Map<string, number>(
      Object.entries(balances).map(([currency, amount]: [string, number]): [string, number] => [currency, toMinor(amount)]),
    );
  }

  // ---------- the API PayOnce calls ----------

  async answer(request: Request): Promise<Response> {
    const url: URL = new URL(request.url);
    const text: string = await request.text();
    const body: unknown = text === "" ? undefined : JSON.parse(text);
    const answer: Answer = this.route(request.method, url, request.headers, body);
    this.calls.push({ method: request.method, path: `${url.pathname}${url.search}`, status: answer.status, body });
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }

  private route(method: string, url: URL, headers: Headers, body: unknown): Answer {
    const path: string = url.pathname;
    if (method === "POST" && path === "/api/v1/authentication/login") {
      return this.login(headers);
    }
    const token: string = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    if ((this.tokens.get(token) ?? 0) <= Date.now()) {
      return refusal(401, "unauthorized", "Access denied, authentication failed");
    }
    const input: Record<string, unknown> = (body ?? {}) as Record<string, unknown>;
    const parts: string[] = path.split("/").filter((part: string): boolean => part !== "");
    if (method === "GET" && path === "/api/v1/balances/current") {
      return { status: 200, body: this.balanceRows() };
    }
    if (method === "GET" && path === "/api/v1/beneficiaries") {
      return { status: 200, body: { items: copy(this.records), has_more: false } };
    }
    if (method === "POST" && path === "/api/v1/beneficiaries/create") {
      return this.createRecord(input);
    }
    if (parts[2] === "beneficiaries" && parts.length >= 4) {
      return this.onRecord(method, parts, input);
    }
    if (method === "POST" && path === "/api/v1/transfers/create") {
      return this.createTransfer(input);
    }
    if (method === "GET" && path === "/api/v1/transfers") {
      return { status: 200, body: { items: this.listTransfers(url.searchParams), page_after: null } };
    }
    if (method === "GET" && parts[2] === "transfers" && parts.length === 4) {
      const transfer: FakeTransfer | undefined = this.transfers.find((each: FakeTransfer): boolean => each.id === parts[3]);
      return transfer === undefined
        ? refusal(404, "resource_not_found", "The transfer was not found")
        : { status: 200, body: this.view(transfer) };
    }
    return refusal(404, "resource_not_found", `The fake Airwallex has no route for ${method} ${path}`);
  }

  private login(headers: Headers): Answer {
    const login: Login = { clientId: headers.get("x-client-id") ?? "", apiKey: headers.get("x-api-key") ?? "" };
    this.logins.push(login);
    if (login.clientId !== FAKE_CLIENT_ID || login.apiKey !== FAKE_API_KEY) {
      return refusal(401, "credentials_invalid", "The client id or API key is not valid");
    }
    const token: string = `journey-token-${this.logins.length}`;
    const expiresMs: number = Date.now() + TOKEN_LIFE_MS;
    this.tokens.set(token, expiresMs);
    return { status: 201, body: { token, expires_at: new Date(expiresMs).toISOString() } };
  }

  private balanceRows(): unknown[] {
    return [...this.balances.keys()].sort().map((currency: string): unknown => {
      const available: number = toMajor(this.balances.get(currency) ?? 0);
      return { currency, available_amount: available, reserved_amount: 0, pending_amount: 0, total_amount: available };
    });
  }

  private createRecord(input: Record<string, unknown>): Answer {
    const given: BeneficiaryRecord = copy(input) as unknown as BeneficiaryRecord;
    const record: BeneficiaryRecord = {
      ...given,
      id: `b0000001-0000-4000-8000-${String(this.records.length + 100).padStart(12, "0")}`,
      payer_entity_type: "COMPANY",
      beneficiary: { ...given.beneficiary, bank_details: fingerprinted(given.beneficiary.bank_details) },
    };
    this.records.push(record);
    return { status: 201, body: copy(record) };
  }

  // A well-formed id Airwallex does not have answers 200 with an empty body.
  private onRecord(method: string, parts: string[], input: Record<string, unknown>): Answer {
    const id: string = parts[3] ?? "";
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) {
      return refusal(400, "invalid_argument", "The beneficiary id is not valid");
    }
    const record: BeneficiaryRecord | undefined = this.records.find((each: BeneficiaryRecord): boolean => each.id === id);
    if (method === "GET" && parts.length === 4) {
      return { status: 200, body: record === undefined ? undefined : copy(record) };
    }
    if (method === "POST" && parts[4] === "update" && parts.length === 5) {
      if (record === undefined) {
        return refusal(404, "resource_not_found", "The beneficiary was not found");
      }
      const given: { bank_details?: BankDetails } = (input["beneficiary"] ?? {}) as { bank_details?: BankDetails };
      record.beneficiary.bank_details = fingerprinted({ ...(given.bank_details ?? {}) });
      return { status: 200, body: copy(record) };
    }
    return refusal(404, "resource_not_found", `The fake Airwallex has no route for ${method} ${parts.join("/")}`);
  }

  // A reused request id names the transfer it made, before anything else is checked.
  private createTransfer(input: Record<string, unknown>): Answer {
    const requestId: string = String(input["request_id"] ?? "");
    const existing: FakeTransfer | undefined = this.transfers.find((each: FakeTransfer): boolean => each.requestId === requestId);
    if (existing !== undefined) {
      return refusal(400, "duplicate_request_id", `The request_id ${requestId} was already used by transfer ${existing.id}`);
    }
    if (input["quote_id"] !== undefined || (input["source_currency"] ?? input["transfer_currency"]) !== input["transfer_currency"]) {
      return refusal(400, "invalid_argument", "The fake Airwallex does not convert currencies");
    }
    const record: BeneficiaryRecord | undefined = this.records.find(
      (each: BeneficiaryRecord): boolean => each.id === input["beneficiary_id"],
    );
    if (record === undefined) {
      return refusal(400, "invalid_argument", "The beneficiary was not found");
    }
    const currency: string = String(input["transfer_currency"]);
    const method: string = String(input["transfer_method"]);
    const amountMinor: number = toMinor(input["transfer_amount"]);
    const feeMinor: number = toMinor(FEES_MAJOR[method] ?? 0);
    if ((this.balances.get(currency) ?? 0) < amountMinor + feeMinor) {
      return refusal(400, "insufficient_fund", "Insufficient balance");
    }
    const transfer: FakeTransfer = this.addTransfer({
      requestId,
      reference: String(input["reference"] ?? ""),
      method,
      amountMinor,
      currency,
      feeMinor,
      record,
      byPayOnce: true,
    });
    return { status: 201, body: this.view(transfer) };
  }

  // Newest first, as Airwallex lists them, all on one page.
  private listTransfers(params: URLSearchParams): unknown[] {
    const requestId: string | null = params.get("request_id");
    const from: string | null = params.get("from_created_at");
    const fromMs: number = from === null ? 0 : Math.floor(Date.parse(from) / 1000) * 1000;
    return this.transfers
      .filter((each: FakeTransfer): boolean => requestId === null || each.requestId === requestId)
      .filter((each: FakeTransfer): boolean => each.createdMs >= fromMs)
      .slice()
      .reverse()
      .map((each: FakeTransfer): unknown => this.view(each));
  }

  private addTransfer(input: {
    requestId: string;
    reference: string;
    method: string;
    amountMinor: number;
    currency: string;
    feeMinor: number;
    record: BeneficiaryRecord;
    byPayOnce: boolean;
  }): FakeTransfer {
    const n: number = this.transfers.length + 1;
    const day: string = new Date(Date.now()).toISOString().slice(2, 10).replaceAll("-", "");
    const transfer: FakeTransfer = {
      id: `t0000001-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
      requestId: input.requestId,
      reference: input.reference,
      shortReference: `P${day}-${String(n).padStart(7, "0")}`,
      createdMs: Date.now(),
      // The sandbox moves a new transfer from SCHEDULED to PROCESSING within
      // seconds, so the journeys start it there.
      status: "PROCESSING",
      failure: null,
      method: input.method,
      amountMinor: input.amountMinor,
      currency: input.currency,
      feeMinor: input.feeMinor,
      beneficiaryId: input.record.id,
      bankDetails: copy(input.record.beneficiary.bank_details),
      byPayOnce: input.byPayOnce,
    };
    this.transfers.push(transfer);
    this.balances.set(input.currency, (this.balances.get(input.currency) ?? 0) - input.amountMinor - input.feeMinor);
    return transfer;
  }

  private view(transfer: FakeTransfer): unknown {
    const amount: number = toMajor(transfer.amountMinor);
    const fee: number = toMajor(transfer.feeMinor);
    return {
      id: transfer.id,
      request_id: transfer.requestId,
      status: transfer.status,
      reference: transfer.reference,
      short_reference_id: transfer.shortReference,
      created_at: airwallexTime(transfer.createdMs),
      updated_at: airwallexTime(Date.now()),
      transfer_method: transfer.method,
      transfer_amount: amount,
      transfer_currency: transfer.currency,
      source_amount: amount,
      source_currency: transfer.currency,
      fee_amount: fee,
      fee_currency: transfer.currency,
      fee_paid_by: "PAYER",
      amount_payer_pays: toMajor(transfer.amountMinor + transfer.feeMinor),
      reason: "professional_business_services",
      beneficiary_id: transfer.beneficiaryId,
      beneficiary: { bank_details: copy(transfer.bankDetails), entity_type: "COMPANY", type: "BANK_ACCOUNT" },
      ...(transfer.failure === null
        ? {}
        : { failure: { ...transfer.failure, details: { type: "INCORRECT_ROUTING" } } }),
    };
  }

  // ---------- the bank, and people in the Airwallex web app ----------

  private transfer(id: string): FakeTransfer {
    const transfer: FakeTransfer | undefined = this.transfers.find((each: FakeTransfer): boolean => each.id === id);
    if (transfer === undefined) {
      throw new Error(`The fake Airwallex has no transfer ${id}`);
    }
    if (!["SCHEDULED", "PROCESSING", "SENT"].includes(transfer.status)) {
      throw new Error(`Transfer ${id} is ${transfer.status} already`);
    }
    return transfer;
  }

  // The bank pays a transfer.
  pay(id: string): void {
    this.transfer(id).status = "PAID";
  }

  // The bank fails a transfer and refunds its amount. The fee is not refunded.
  fail(id: string, type: FailureType): void {
    const transfer: FakeTransfer = this.transfer(id);
    transfer.status = "FAILED";
    transfer.failure = { ...FAILURES[type] };
    this.balances.set(transfer.currency, (this.balances.get(transfer.currency) ?? 0) + transfer.amountMinor);
  }

  // A person pays an invoice from the Airwallex web app, outside PayOnce.
  sendOutside(payout: { reference: string; beneficiaryId: string; amountMajor: number; currency: string }): FakeTransfer {
    const record: BeneficiaryRecord = this.recordById(payout.beneficiaryId);
    return this.addTransfer({
      requestId: `web-app-${this.transfers.length + 1}`,
      reference: payout.reference,
      method: "LOCAL",
      amountMinor: toMinor(payout.amountMajor),
      currency: payout.currency,
      feeMinor: 0,
      record,
      byPayOnce: false,
    });
  }

  // A person changes a supplier's bank details on its record in the Airwallex
  // web app, outside PayOnce.
  editBeneficiary(id: string, changes: BankDetails): void {
    const record: BeneficiaryRecord = this.recordById(id);
    record.beneficiary.bank_details = fingerprinted({ ...record.beneficiary.bank_details, ...changes });
  }

  private recordById(id: string): BeneficiaryRecord {
    const record: BeneficiaryRecord | undefined = this.records.find((each: BeneficiaryRecord): boolean => each.id === id);
    if (record === undefined) {
      throw new Error(`The fake Airwallex has no beneficiary ${id}`);
    }
    return record;
  }

  // ---------- what a journey reads ----------

  // The record as Airwallex holds it now.
  record(id: string): BeneficiaryRecord {
    return copy(this.recordById(id));
  }

  // Every transfer the bank has with this reference, oldest first.
  transfersFor(reference: string): FakeTransfer[] {
    return this.transfers.filter((each: FakeTransfer): boolean => each.reference === reference).map(copy);
  }

  // Every call that asked the bank to change something: a transfer, a record.
  writes(): BankCall[] {
    return this.calls.filter((call: BankCall): boolean => call.method === "POST" && !call.path.endsWith("/authentication/login"));
  }

  availableMinor(currency: string): number {
    return this.balances.get(currency) ?? 0;
  }
}
