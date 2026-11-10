import { World } from "./harness/world.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OutsidePayout } from "../src/store/ledger.js";
import { payee, type BankCall, type FakeTransfer } from "./harness/fake-airwallex.js";

// README, What it guarantees: an invoice has at most one live payment, a retry
// creates at most one transfer, and a payout someone sent outside PayOnce holds
// the invoice for a person.

function creates(world: World): BankCall[] {
  return world.bank.writes().filter((call: BankCall): boolean => call.path === "/api/v1/transfers/create");
}

describe("PayOnce never pays an invoice twice", () => {
  test("a channel timeout is resent once, and the invoice closes paid by exactly one transfer", async (t) => {
    const world: World = new World();
    t.after(() => world.dispose());
    const invoiceId: string = "INV-1001";

    await world.startPayment({ invoiceId, payee: payee("A"), amount: 4_000, starter: "Kim" });
    world.approve(invoiceId, "Alex");
    world.approve(invoiceId, "Yash");
    await world.look(invoiceId);
    const original: FakeTransfer = world.transferOf(invoiceId, "original");

    // The duplicate lock refuses a second payment while the first is with the bank.
    assert.equal(world.payAgain(invoiceId).refused, true);

    // The bank's channel times out: a failure a resend can fix, so PayOnce sends
    // one replacement by itself, under a request id of its own.
    world.bank.fail(original.id, "CHANNEL_TIMEOUT");
    await world.look(invoiceId);
    const replacement: FakeTransfer = world.transferOf(invoiceId, "replacement");
    assert.notEqual(replacement.requestId, original.requestId);
    assert.equal(world.obligation(invoiceId).state, "open");

    // Looking again while the replacement is with the bank sends nothing more, and
    // Pay again is refused.
    await world.look(invoiceId);
    assert.equal(world.payAgain(invoiceId).refused, true);
    assert.equal(world.transfers(invoiceId).length, 2);

    world.bank.pay(replacement.id);
    await world.look(invoiceId);
    assert.equal(world.obligation(invoiceId).state, "settled");
    assert.equal(world.situation(invoiceId).state, "paid");

    // Closed, it sends nothing whatever is asked of it: the paid replacement holds
    // the duplicate lock for good.
    await world.look(invoiceId);
    assert.equal(world.payAgain(invoiceId).refused, true);
    await world.look(invoiceId);

    assert.deepEqual(
      world.transfers(invoiceId).map((transfer: FakeTransfer): [string, string] => [transfer.id, transfer.status]),
      [
        [original.id, "FAILED"],
        [replacement.id, "PAID"],
      ],
    );
    assert.equal(creates(world).length, 2);
  });

  test("a payout someone sent outside PayOnce is tied to the invoice, and PayOnce sends nothing", async (t) => {
    const world: World = new World();
    t.after(() => world.dispose());
    const invoiceId: string = "INV-1002";

    await world.startPayment({ invoiceId, payee: payee("C"), amount: 4_000, starter: "Kim" });
    assert.equal(world.reasonCode(invoiceId), "person-started");

    // While the payment waits for its approval, someone pays the invoice from the
    // Airwallex web app. The approvers have not seen it, and approve.
    const payout: FakeTransfer = world.bank.sendOutside({
      reference: invoiceId,
      beneficiaryId: payee("C"),
      amountMajor: 4_000,
      currency: "USD",
    });
    world.approve(invoiceId, "Alex");
    world.approve(invoiceId, "Yash");

    // Just before paying, PayOnce lists the transfers again, ties the payout to the
    // invoice and sends nothing. The approval is withdrawn, never spent.
    await world.look(invoiceId);
    await world.look(invoiceId);
    assert.deepEqual(
      world.ledger.outsidePayouts(invoiceId).map((tied: OutsidePayout): string => tied.transferId),
      [payout.id],
    );
    assert.equal(world.obligation(invoiceId).state, "escalated");
    assert.equal(world.latestApproval(invoiceId)?.state, "void");

    // The bank pays the payout. PayOnce still sends nothing, and the invoice waits
    // for a person to close it as paid outside PayOnce.
    world.bank.pay(payout.id);
    await world.look(invoiceId);
    assert.equal(world.situation(invoiceId).state, "ready-to-close");
    world.close(invoiceId, "Alex", "Dana paid it from the Airwallex web app");
    await world.look(invoiceId);
    assert.equal(world.obligation(invoiceId).state, "settled");

    assert.deepEqual(world.attempts(invoiceId), []);
    assert.deepEqual(
      world.transfers(invoiceId).map((transfer: FakeTransfer): [string, boolean] => [transfer.id, transfer.byPayOnce]),
      [[payout.id, false]],
    );
    assert.equal(creates(world).length, 0);
  });
});
