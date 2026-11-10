import { World } from "./harness/world.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Attempt } from "../src/store/ledger.js";
import { payee, type FakeTransfer } from "./harness/fake-airwallex.js";

// README, What it guarantees: PayOnce replaces a failed payment by itself only if
// the wallet stays above its reserve floor, after the fee and the money already
// promised to other payments.

describe("An automatic resend never takes a wallet below its reserve floor", () => {
  test("a resend that would leave the wallet below its floor goes to a person instead", async (t) => {
    // 10,000 USD in the wallet and a floor of 7,000. A single payment's original
    // is not held to the floor, and resending it would leave 6,000.
    const world: World = new World({ settings: { RESERVE_FLOORS: "USD:7000" }, balances: { USD: 10_000 } });
    t.after(() => world.dispose());
    const invoiceId: string = "INV-5001";

    await world.startPayment({ invoiceId, payee: payee("D"), amount: 4_000, starter: "Kim" });
    world.approve(invoiceId, "Alex");
    world.approve(invoiceId, "Yash");
    await world.look(invoiceId);
    const original: FakeTransfer = world.transferOf(invoiceId, "original");

    // The same channel timeout pays-once.test.ts resends by itself. The refund
    // brings the wallet back to 10,000, and a replacement would leave 6,000.
    world.bank.fail(original.id, "CHANNEL_TIMEOUT");
    await world.look(invoiceId);
    assert.equal(world.bank.availableMinor("USD"), 1_000_000);
    assert.equal(world.obligation(invoiceId).state, "escalated");
    assert.equal(world.reasonCode(invoiceId), "below-floor");
    assert.equal(world.situation(invoiceId).state, "needs-approval");

    // Looking again later changes nothing: only a person's approval sends it.
    world.advance(5 * 60_000);
    await world.look(invoiceId);
    assert.deepEqual(
      world.transfers(invoiceId).map((transfer: FakeTransfer): string => transfer.id),
      [original.id],
    );
    assert.deepEqual(
      world.attempts(invoiceId).map((attempt: Attempt): string => attempt.kind),
      ["original"],
    );
  });
});
