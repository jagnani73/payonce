import { World } from "./harness/world.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accountKeyOf } from "../src/domain/approval.js";
import type { Approval } from "../src/store/ledger.js";
import { payee, type FakeTransfer } from "./harness/fake-airwallex.js";

// README, What it guarantees: every payment a person starts waits for someone
// else's approval before its first transfer, and an approval covers exact terms.
// Any change voids it, and terms changed in the ledger by hand send nothing.

describe("A payment a person starts is paid only on someone else's approval of its exact terms", () => {
  test("the starter cannot approve, and an approval of an account that has since changed sends nothing", async (t) => {
    const world: World = new World();
    t.after(() => world.dispose());
    const invoiceId: string = "INV-3001";

    // Kim starts it. Nothing is sent, and it needs two of the other approvers,
    // since PayOnce has never paid this payee.
    await world.startPayment({ invoiceId, payee: payee("A"), amount: 4_000, starter: "Kim" });
    assert.equal(world.reasonCode(invoiceId), "person-started");
    assert.deepEqual(world.situation(invoiceId).waitingOn, { who: "approvers", names: ["Yash", "Alex", "Sam"] });
    assert.equal(world.request(invoiceId).approval.needed, 2);

    // The starter cannot approve it, nor can a name outside APPROVERS. Neither
    // counts as a signoff.
    assert.throws(() => world.approve(invoiceId, "Kim"));
    assert.throws(() => world.approve(invoiceId, "Mallory"));
    assert.equal(world.request(invoiceId).approval.signoffs.length, 0);

    // One of the two approvers it needs is not enough.
    world.approve(invoiceId, "Alex");
    await world.look(invoiceId);
    assert.deepEqual(world.transfers(invoiceId), []);

    // The second approver signs, and before PayOnce looks again someone changes the
    // payee's account number in the Airwallex web app. The approval named the old
    // account, so it is void and nothing is sent.
    const approved: Approval = world.approve(invoiceId, "Yash");
    assert.equal(approved.state, "approved");
    world.bank.editBeneficiary(payee("A"), { account_number: "999999999" });
    await world.look(invoiceId);
    assert.deepEqual(world.transfers(invoiceId), []);
    assert.deepEqual(world.attempts(invoiceId), []);
    assert.equal(world.ledger.approvalsFor(invoiceId).find((each: Approval): boolean => each.id === approved.id)?.state, "void");

    // A new request opens on the account as it is now, and it too needs two
    // approvers. Only their approval of it sends the payment, once, to exactly the
    // account those terms name.
    const renewed: Approval = world.request(invoiceId).approval;
    assert.notEqual(renewed.binding, approved.binding);
    const accountKey: string = world.terms(renewed).accountKey;
    assert.notEqual(accountKey, world.terms(approved).accountKey);
    assert.equal(accountKey, accountKeyOf(world.bank.record(payee("A")).beneficiary.bank_details));
    world.approve(invoiceId, "Alex");
    world.approve(invoiceId, "Yash");
    await world.look(invoiceId);
    const sent: FakeTransfer[] = world.transfers(invoiceId);
    assert.equal(sent.length, 1);
    assert.equal(accountKeyOf(sent[0]?.bankDetails), accountKey);
    assert.equal(sent[0]?.amountMinor, 400_000);
    assert.equal(world.latestApproval(invoiceId)?.state, "used");
  });

  test("an approval whose terms were changed in the ledger by hand sends nothing", async (t) => {
    const world: World = new World();
    t.after(() => world.dispose());
    const invoiceId: string = "INV-3002";

    await world.startPayment({ invoiceId, payee: payee("B"), amount: 4_000, starter: "Kim" });
    world.approve(invoiceId, "Alex");
    const approved: Approval = world.approve(invoiceId, "Yash");

    // Someone with the ledger file raises the amount in the approved terms. They no
    // longer hash to the binding the approvers signed, so every look stops before
    // it pays and the approval stays unspent.
    world.editLedger("UPDATE approvals SET terms = json_set(terms, '$.amountMinor', 4000000) WHERE id = ?", approved.id);
    await assert.rejects(world.look(invoiceId), { name: "StoredShapeError" });
    world.advance(60_000);
    await assert.rejects(world.look(invoiceId), { name: "StoredShapeError" });

    assert.deepEqual(world.attempts(invoiceId), []);
    assert.deepEqual(world.transfers(invoiceId), []);
    assert.equal(world.latestApproval(invoiceId)?.state, "approved");
  });
});
