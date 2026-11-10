import { answerAirwallexWith, journeyFolder, OFFLINE_HOST, refused } from "./guard.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock } from "node:test";
import type { ApprovalTerms } from "../../src/domain/approval.js";
import { toMinor } from "../../src/domain/money.js";
import type { Situation } from "../../src/domain/situation.js";
import { createEngine, type EngineBuild } from "../../src/engine/create.js";
import type { Engine } from "../../src/engine/engine.js";
import { resumeIncident } from "../../src/engine/look.js";
import { openPayment, recordPayee, type NewPayment, type Payee } from "../../src/engine/new-payment.js";
import { approvePayment, closeIncident, payAgain, type PayAgainResult } from "../../src/engine/person.js";
import { openScenario } from "../../src/engine/scenario.js";
import { deliverUpload, parseUpload, storeUpload } from "../../src/intake/intake.js";
import { loadSettings, type Settings } from "../../src/settings.js";
import { Ledger, type Approval, type Attempt, type Obligation, type Upload } from "../../src/store/ledger.js";
import { heldBeforePaying } from "../../src/store/read/facts.js";
import { pendingApproval, type PendingApproval } from "../../src/store/read/reviews.js";
import type { IncidentView } from "../../src/views/contract.js";
import { incidentView } from "../../src/views/incident.js";
import { FAKE_API_KEY, FAKE_CLIENT_ID, FakeAirwallex, type FakeTransfer, type Login } from "./fake-airwallex.js";

// Every journey starts on a Monday morning, with an empty ledger, and time moves
// only when the journey moves it.
export const START: string = "2026-11-02T09:00:00.000Z";

// The settings every journey runs with, as .env would give them. A journey may
// change any of them. Nothing here is read from the environment or from a file.
export const SETTINGS: Readonly<Record<string, string>> = {
  AWX_BASE_URL: `https://${OFFLINE_HOST}`,
  AWX_CLIENT_ID: FAKE_CLIENT_ID,
  AWX_API_KEY: FAKE_API_KEY,
  APPROVERS: "Yash:50000,Alex:10000,Kim:10000,Sam:4200",
  TWO_APPROVERS_ABOVE: "5000",
  APPROVAL_TTL_MINUTES: "60",
  RESERVE_FLOORS: "USD:1000,EUR:1000",
  WEBHOOKS: "off",
  RECON_EVERY_MINUTES: "0",
};

export interface WorldOptions {
  settings?: Record<string, string>;
  // Opening balances in major units.
  balances?: Record<string, number>;
}

// A payment a person starts on the New payment form, in USD by local transfer.
export interface Started {
  invoiceId: string;
  payee: string;
  amount: number;
  starter: string;
}

// One journey's PayOnce: an empty ledger in a folder of its own, the engine built
// from explicit settings, and the fake Airwallex it talks to. It drives PayOnce
// the way the page and the CLI do: through the engine's own entry points, one
// look at a time, with no server, watcher or timer running.
export class World {
  readonly bank: FakeAirwallex;
  readonly settings: Settings;
  readonly engine: Engine;
  readonly ledger: Ledger;
  readonly ledgerPath: string;

  constructor(options: WorldOptions = {}) {
    mock.timers.enable({ apis: ["Date"], now: Date.parse(START) });
    this.bank = new FakeAirwallex(options.balances ?? { USD: 100_000, EUR: 100_000 });
    answerAirwallexWith((request: Request): Promise<Response> => this.bank.answer(request));
    this.settings = loadSettings({ ...SETTINGS, ...options.settings });
    this.ledgerPath = join(journeyFolder(), "payonce.db");
    this.ledger = new Ledger(this.ledgerPath);
    const built: EngineBuild = createEngine(this.settings, this.ledger);
    if (built.problem !== null) {
      throw new Error(built.problem);
    }
    // PayOnce's client accepts the two sandbox hosts too. A journey talks only to
    // the fake, so anything else stops it before a single call.
    if (built.engine.client.host !== OFFLINE_HOST) {
      throw new Error(`A journey talks only to https://${OFFLINE_HOST}, not ${built.engine.client.host}`);
    }
    this.engine = built.engine;
  }

  // ---------- what people do ----------

  // A person starts a payment on the New payment form. Like the page, PayOnce
  // then looks at it, and once more when that look held it, so the request is
  // open when this returns.
  async startPayment(started: Started): Promise<Obligation> {
    const payment: NewPayment = {
      invoiceId: started.invoiceId,
      amountMinor: toMinor(started.amount),
      currency: "USD",
      wallet: "USD",
      transferMethod: "LOCAL",
      dueDate: null,
      starter: started.starter,
    };
    const opened: Obligation = await openPayment(
      this.engine,
      payment,
      (): Promise<Payee> => recordPayee(this.engine, started.payee, payment),
    );
    await this.firstLooks(opened.invoiceId);
    return opened;
  }

  // A person starts one of the simulator's scripted incidents, such as usd-local.
  // Its supplier has an email domain on file, which the sender check compares
  // with. No script plays it: the journey plays the bank and the supplier.
  async startScenario(invoiceId: string, scenarioId: string, starter: string): Promise<Obligation> {
    const opened: Obligation = await openScenario(this.engine, invoiceId, scenarioId, starter);
    await this.firstLooks(invoiceId);
    return opened;
  }

  private async firstLooks(invoiceId: string): Promise<void> {
    await this.look(invoiceId);
    if (heldBeforePaying(this.ledger, this.obligation(invoiceId))) {
      await this.look(invoiceId);
    }
  }

  // One look by the agent, as a webhook, the watcher or Check now would ask for.
  look(invoiceId: string): Promise<void> {
    return resumeIncident(this.engine, invoiceId, { runTurn: false });
  }

  // One person's approval of the request the invoice waits on, as they read it off
  // the payment page.
  approve(invoiceId: string, approver: string): Approval {
    return approvePayment(this.ledger, this.settings.approvals, invoiceId, approver, this.request(invoiceId).approval.id);
  }

  close(invoiceId: string, closer: string, finding: string): void {
    closeIncident(this.ledger, invoiceId, closer, finding);
  }

  payAgain(invoiceId: string): PayAgainResult {
    return payAgain(this.ledger, invoiceId);
  }

  // A person uploads a supplier's raw email on the Inbox screen. It is parsed in
  // the worker thread the server uses, and kept waiting in the inbox.
  async uploadEmail(eml: string, uploader: string): Promise<Upload> {
    return storeUpload(this.ledger, await parseUpload(Buffer.from(eml, "utf8"), "paste"), uploader, "paste", null);
  }

  // A person delivers a waiting upload to the invoice it is about.
  deliverEmail(upload: Upload, invoiceId: string, deliverer: string): void {
    deliverUpload(this.ledger, upload.id, invoiceId, deliverer);
  }

  // Someone edits the ledger file by hand, while PayOnce is idle.
  editLedger(sql: string, ...params: (string | number)[]): void {
    const file: DatabaseSync = new DatabaseSync(this.ledgerPath);
    try {
      file.prepare(sql).run(...params);
    } finally {
      file.close();
    }
  }

  advance(ms: number): void {
    mock.timers.tick(ms);
  }

  // ---------- what a journey reads ----------

  obligation(invoiceId: string): Obligation {
    const obligation: Obligation | undefined = this.ledger.obligation(invoiceId);
    assert.ok(obligation !== undefined, `${invoiceId} is not in the ledger`);
    return obligation;
  }

  // The code of the reason the invoice went to a person, or null.
  reasonCode(invoiceId: string): string | null {
    return this.ledger.reasonOf(this.obligation(invoiceId))?.code ?? null;
  }

  attempts(invoiceId: string): Attempt[] {
    return this.ledger.attempts(invoiceId);
  }

  // The request the invoice waits on, with its terms, as the payment page shows it.
  request(invoiceId: string): PendingApproval {
    const pending: PendingApproval | undefined = pendingApproval(this.ledger, invoiceId);
    assert.ok(pending !== undefined, `No approval request is waiting for ${invoiceId}`);
    return pending;
  }

  terms(approval: Approval): ApprovalTerms {
    return JSON.parse(approval.terms) as ApprovalTerms;
  }

  latestApproval(invoiceId: string): Approval | undefined {
    return this.ledger.latestApproval(invoiceId);
  }

  // The payment page's situation: what a person reads the invoice waits on.
  situation(invoiceId: string): Situation {
    const view: IncidentView | null = incidentView(this.ledger, this.settings, Date.now(), invoiceId);
    assert.ok(view !== null, `${invoiceId} has no payment page`);
    return view.situation;
  }

  // Every transfer the bank has for the invoice, oldest first.
  transfers(invoiceId: string): FakeTransfer[] {
    return this.bank.transfersFor(invoiceId);
  }

  // The one transfer the invoice's attempt of this kind made.
  transferOf(invoiceId: string, kind: Attempt["kind"]): FakeTransfer {
    const attempt: Attempt | undefined = this.attempts(invoiceId).find((each: Attempt): boolean => each.kind === kind);
    const transfer: FakeTransfer | undefined = this.transfers(invoiceId).find(
      (each: FakeTransfer): boolean => attempt !== undefined && each.id === attempt.transferId,
    );
    assert.ok(transfer !== undefined, `${invoiceId} has no ${kind} at the bank`);
    return transfer;
  }

  // Ends the journey: the ledger is closed and time is real again. It fails the
  // journey when anything tried to leave the fake, or Airwallex was ever offered
  // credentials other than the fake ones.
  dispose(): void {
    this.ledger.close();
    answerAirwallexWith(null);
    mock.timers.reset();
    assert.deepEqual(refused, [], "A journey tried to reach something other than the fake Airwallex");
    for (const login of this.bank.logins) {
      assert.deepEqual(login, { clientId: FAKE_CLIENT_ID, apiKey: FAKE_API_KEY } satisfies Login);
    }
  }
}
