import { World } from "./harness/world.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DuplicateEvidence, HeldPaymentTerms } from "../src/domain/approval.js";
import { payee, type FakeTransfer } from "./harness/fake-airwallex.js";

// README, Duplicate invoices: the same supplier, currency and amount, with a
// number that matches apart from up to four letters added at the end, holds the
// new invoice for a person, who approves paying it or closes it without paying.

describe("A likely second bill is held, not paid", () => {
  test("INV-0042A after a paid INV-0042 is held before paying, and closing it pays nothing", async (t) => {
    const world: World = new World();
    t.after(() => world.dispose());

    // INV-0042 is approved, sent and paid.
    await world.startPayment({ invoiceId: "INV-0042", payee: payee("B"), amount: 1_250, starter: "Kim" });
    world.approve("INV-0042", "Alex");
    world.approve("INV-0042", "Yash");
    await world.look("INV-0042");
    world.bank.pay(world.transferOf("INV-0042", "original").id);
    await world.look("INV-0042");
    assert.equal(world.obligation("INV-0042").state, "settled");

    // The same supplier bills the same amount again as INV-0042A. PayOnce holds it
    // as a likely second bill, and the approval request names the paid invoice.
    await world.startPayment({ invoiceId: "INV-0042A", payee: payee("B"), amount: 1_250, starter: "Kim" });
    assert.equal(world.obligation("INV-0042A").state, "escalated");
    assert.equal(world.reasonCode("INV-0042A"), "second-bill");
    assert.deepEqual(world.obligation("INV-0042A").duplicateOf, ["INV-0042"]);
    const terms: HeldPaymentTerms = world.terms(world.request("INV-0042A").approval) as HeldPaymentTerms;
    assert.deepEqual(
      terms.evidence.duplicates.map((duplicate: DuplicateEvidence): [string, string] => [duplicate.invoiceId, duplicate.state]),
      [["INV-0042", "settled"]],
    );

    // Looking again sends nothing. A person closes it without paying.
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
  });
});
