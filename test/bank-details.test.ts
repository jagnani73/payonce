import { World } from "./harness/world.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accountKeyOf } from "../src/domain/approval.js";
import type { Upload } from "../src/store/ledger.js";
import { DEMO_SUPPLIER, type BankCall, type BeneficiaryRecord, type FakeTransfer } from "./harness/fake-airwallex.js";

// README, What it guarantees: bank details change only after a callback to the
// phone on file. New details never come from an email or a model, and an email
// can only add caution.

const NEW_ACCOUNT: string = "9988776655";
const NEW_ROUTING: string = "000000000";

// A reply from a look-alike of the supplier's domain (a digit 1 for the l),
// asking for the payment to go to a new account.
function lookalikeEmail(invoiceId: string): string {
  return [
    "From: Example Supplier Accounts <accounts@example-supp1ier.test>",
    "To: payables@payonce.test",
    `Subject: RE: ${invoiceId} payment`,
    "Date: Mon, 02 Nov 2026 09:30:00 +0000",
    `Message-ID: <${invoiceId.toLowerCase()}-new-bank@example-supp1ier.test>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hi,",
    "",
    `Our bank has put the old account under audit. Please send the payment for ${invoiceId} to our new account today:`,
    "",
    "Bank: First Example Bank",
    `Routing: ${NEW_ROUTING}`,
    `Account: ${NEW_ACCOUNT}`,
    "",
    "Regards,",
    "Accounts, Example Supplier",
    "",
  ].join("\r\n");
}

describe("Bank details never come from an email", () => {
  test("an email asking for a new account sends the invoice to a person, and no money goes to the new details", async (t) => {
    const world: World = new World();
    t.after(() => world.dispose());
    const invoiceId: string = "INV-4001";
    const before: BeneficiaryRecord = world.bank.record(DEMO_SUPPLIER);
    const onFile: string = accountKeyOf(before.beneficiary.bank_details);

    // The usd-local scenario pays the demo supplier, whose emails come from
    // example-supplier.test.
    await world.startScenario(invoiceId, "usd-local", "Kim");
    world.approve(invoiceId, "Alex");
    world.approve(invoiceId, "Yash");
    await world.look(invoiceId);
    const original: FakeTransfer = world.transferOf(invoiceId, "original");

    // While the original is with the bank, the look-alike email is uploaded and
    // delivered to the invoice. The next look reads it and hands the invoice to a
    // person.
    const upload: Upload = await world.uploadEmail(lookalikeEmail(invoiceId), "Kim");
    world.deliverEmail(upload, invoiceId, "Kim");
    await world.look(invoiceId);
    assert.equal(world.obligation(invoiceId).state, "escalated");
    assert.equal(world.reasonCode(invoiceId), "new-bank-details");

    // The channel then times out. Without the email PayOnce would resend by itself
    // (pays-once.test.ts). With it, nothing more is sent until a person approves.
    world.bank.fail(original.id, "CHANNEL_TIMEOUT");
    await world.look(invoiceId);
    assert.equal(world.transfers(invoiceId).length, 1);
    assert.equal(world.reasonCode(invoiceId), "new-bank-details");

    // What a person is asked to approve is a replacement to the account on file,
    // and that is where it goes.
    assert.equal(world.terms(world.request(invoiceId).approval).accountKey, onFile);
    world.approve(invoiceId, "Alex");
    await world.look(invoiceId);
    const replacement: FakeTransfer = world.transferOf(invoiceId, "replacement");
    assert.deepEqual(replacement.bankDetails, original.bankDetails);
    world.bank.pay(replacement.id);
    await world.look(invoiceId);
    assert.equal(world.obligation(invoiceId).state, "settled");

    // The email's details reached no transfer, and PayOnce never changed the
    // supplier's record in Airwallex.
    for (const transfer of world.transfers(invoiceId)) {
      assert.equal(accountKeyOf(transfer.bankDetails), onFile);
      assert.ok(!JSON.stringify(transfer.bankDetails).includes(NEW_ACCOUNT));
      assert.ok(!JSON.stringify(transfer.bankDetails).includes(NEW_ROUTING));
    }
    assert.deepEqual(world.bank.record(DEMO_SUPPLIER), before);
    assert.deepEqual(
      world.bank.writes().filter((call: BankCall): boolean => call.path.startsWith("/api/v1/beneficiaries")),
      [],
    );
  });
});
