import { World } from "./harness/world.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DuplicateEvidence, HeldPaymentTerms } from "../src/domain/approval.js";
import { payee, type FakeTransfer } from "./harness/fake-airwallex.js";

// README, Duplicate invoices: the same supplier, currency and amount, with a
// number that matches apart from up to four letters added at the end, holds the
// new invoice for a person, who approves paying it or closes it without paying.
// The same supplier includes another record that pays the same account: banks
// credit the account number, not the name, so a record under another account
// name is the same account (accounts.md).

// INV-0042 for 1,250.00 USD is approved, sent and paid through this record.
async function payFirstBill(world: World, beneficiaryId: string): Promise<void> {
  await world.startPayment({ invoiceId: "INV-0042", payee: beneficiaryId, amount: 1_250, starter: "Kim" });
  world.approve("INV-0042", "Alex");
  world.approve("INV-0042", "Yash");
  await world.look("INV-0042");
  world.bank.pay(world.transferOf("INV-0042", "original").id);
  await world.look("INV-0042");
  assert.equal(world.obligation("INV-0042").state, "settled");
}

// INV-0042A for the same amount, through this record, is held as a likely
// second bill for INV-0042, and a person closes it without paying. Only
// INV-0042's transfer ever reaches the bank.
async function holdSecondBill(world: World, beneficiaryId: string): Promise<void> {
  await world.startPayment({ invoiceId: "INV-0042A", payee: beneficiaryId, amount: 1_250, starter: "Kim" });
  assert.equal(world.obligation("INV-0042A").state, "escalated");
  assert.equal(world.reasonCode("INV-0042A"), "second-bill");
  assert.deepEqual(world.obligation("INV-0042A").duplicateOf, ["INV-0042"]);
  const terms: HeldPaymentTerms = world.terms(world.request("INV-0042A").approval) as HeldPaymentTerms;
  assert.deepEqual(
    terms.evidence.duplicates.map((duplicate: DuplicateEvidence): [string, string] => [duplicate.invoiceId, duplicate.state]),
    [["INV-0042", "settled"]],
  );

  await world.look("INV-0042A");
  world.close("INV-0042A", "Alex", "Second bill for INV-0042, which is paid");
  await world.look("INV-0042A");
  assert.equal(world.obligation("INV-0042A").state, "rejected");

  assert.deepEqual(world.attempts("INV-0042A"), []);
  assert.deepEqual(world.transfers("INV-0042A"), []);
  assert.deepEqual(
    world.bank.transfers.map((transfer: FakeTransfer): [string, string] => [transfer.reference, transfer.status]),
    [["INV-0042", "PAID"]],
  );
}

describe("A likely second bill is held, not paid", () => {
  test("INV-0042A to the same record after a paid INV-0042 is held, and closing it pays nothing", async (t) => {
    const world: World = new World();
    t.after(() => world.dispose());
    await payFirstBill(world, payee("B"));
    await holdSecondBill(world, payee("B"));
  });

  test("INV-0042A to another record for the same account, under another account name, is held too", async (t) => {
    const world: World = new World();
    t.after(() => world.dispose());
    // Two records in Airwallex with one account number and routing number, and
    // names that share nothing.
    const first: string = world.bank.addSupplier("Fabrikam Inc", "555000099");
    const second: string = world.bank.addSupplier("Northwind Trading Ltd", "555000099");
    await payFirstBill(world, first);
    await holdSecondBill(world, second);
  });
});
