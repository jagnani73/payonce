import { subscribe } from "../../airwallex/webhooks.js";
import type { ApprovalTerms } from "../../domain/approval.js";
import { note } from "../../engine/lines.js";
import { readingSoft, storedObject, withBank, type Approval, type Attempt, type AttemptKind, type Obligation } from "../../store/ledger.js";
import { say, sayWarning } from "../../text/printable.js";
import type { HttpApp } from "./app.js";
import { openTunnel, type Tunnel } from "./tunnel.js";
import { WEBHOOK_PATH, WebhookReceiver, type WebhookEvent } from "./webhooks.js";

// How often payments in flight are checked when no webhook can arrive, and when
// webhooks are the main signal and the check is a safety net for a late or lost
// event.
export const CHECK_EVERY_MS: number = 3_000;
const CHECK_WITH_WEBHOOKS_MS: number = 15_000;
const SUBSCRIBE_TRIES: number = 3;
const SUBSCRIBE_RETRY_MS: number = 5_000;

// The events that can change a decision. The rest are only logged.
const DECISIVE_EVENTS: Record<string, string> = {
  "payout.transfer.paid": "has been paid",
  "payout.transfer.failed": "has failed",
  "payout.transfer.cancelled": "was cancelled",
  "payout.transfer.overdue": "is overdue",
};

export interface StartUp {
  pickUpInterrupted: () => void;
  connectWebhooks: () => Promise<void>;
  stopTunnel: () => void;
}

// What the server does once it listens, beyond starting its timers: picking up
// payments a restart interrupted, and connecting Airwallex's webhooks.
export function startUp(app: HttpApp): StartUp {
  const { settings, engine, agent, bank, watcher, isWatching } = app;
  const WEBHOOK_PORT: number = settings.server.webhookPort;
  const WEBHOOK_API_VERSION: string = settings.server.webhookApiVersion;

  // What was running lives in memory, so a restart forgets it. Any invoice with a
  // payment still pending or in flight is looked at again, which syncs it with
  // Airwallex and never sends a new payment by itself. In the sandbox the bank
  // also goes back to paying a replacement it had not finished with, an original
  // paid on an approval after a hold, and a pay run row's original, which gets the
  // row's sandbox outcome. A released row that never sent is left to the watcher,
  // which wakes such rows one at a time. What to pick up is read soft, so a row a
  // look cannot read does not stop the server: that look throws and sends nothing.
  // The wakes come after the read, so no look runs inside it.
  function pickUpInterrupted(): void {
    const picked: { invoiceId: string; sent: { kind: AttemptKind; transferId: string; reference: string | null }[] }[] = readingSoft(() =>
      engine.ledger
        .obligations()
        .filter(
          (obligation: Obligation): boolean =>
            obligation.state !== "settled" && obligation.state !== "rejected" && isWatching(obligation.invoiceId),
        )
        .map((obligation: Obligation) => ({ invoiceId: obligation.invoiceId, sent: resumedBySandbox(obligation) })),
    );
    for (const { invoiceId, sent } of picked) {
      for (const { kind, transferId, reference } of sent) {
        bank.sent(invoiceId, kind, transferId, reference);
      }
      agent.wake(invoiceId);
    }
  }

  // The payments in flight the sandbox bank goes back to paying.
  function resumedBySandbox(obligation: Obligation): { kind: AttemptKind; transferId: string; reference: string | null }[] {
    const sent: { kind: AttemptKind; transferId: string; reference: string | null }[] = [];
    for (const attempt of engine.ledger.attempts(obligation.invoiceId)) {
      if (attempt.state !== "in_flight" || attempt.transferId === null) {
        continue;
      }
      // The approval this attempt was opened on, so a request opened since does
      // not decide it.
      const approval: Approval | undefined = engine.ledger.approvalOf(attempt);
      const released: boolean =
        obligation.runRowId !== null ||
        (approval?.state === "used" && storedObject<ApprovalTerms>(approval.terms)?.action === "pay");
      if (attempt.kind === "replacement" || released) {
        sent.push({ kind: attempt.kind, transferId: attempt.transferId, reference: attempt.reference });
      }
    }
    return sent;
  }

  // A signed event only wakes the agent, which reads the transfer from Airwallex
  // itself and decides on that, not on what the event said.
  function onWebhook(event: WebhookEvent): void {
    if (!engine.ledger.firstDelivery(event.id, event.name)) {
      return;
    }
    const attempt: Attempt | undefined = engine.ledger.attemptOf(
      event.data.request_id ?? "",
      event.data.id ?? "",
    );
    const reference: string = attempt?.reference ?? event.data.short_reference_id ?? "";
    say(`  webhook  ${event.name} ${reference}`);
    const news: string | undefined = DECISIVE_EVENTS[event.name];
    if (news === undefined) {
      return;
    }
    if (attempt === undefined) {
      // A payout already tied to an invoice wakes that invoice. Any other is one
      // the sweep has not seen.
      const invoiceId: string | undefined = engine.ledger.outsideInvoiceOf(
        event.data.id ?? "",
      );
      if (invoiceId === undefined) {
        watcher.sweepSoon();
      } else {
        agent.wake(invoiceId);
      }
      return;
    }
    // An attempt marked failed with no transfer on it, which no look reads again:
    // the sweep records the transfer on it.
    if (attempt.state === "failed" && attempt.transferId === null) {
      watcher.sweepSoon();
      return;
    }
    // A failed transfer is cancelled a few seconds later, and a status check may
    // have got there first. Either way the ledger already has the news. A transfer
    // the ledger keeps failed while the bank has it in flight is news.
    if (!withBank(attempt)) {
      return;
    }
    note(
      engine.ledger,
      attempt.invoiceId,
      "bank",
      `Webhook from Airwallex: ${attempt.kind} ${reference} ${news}. Checking it`,
    );
    agent.wake(attempt.invoiceId);
  }

  let tunnel: Tunnel | null = null;

  async function subscribeWithRetry(url: string): Promise<string> {
    for (let attempt: number = 1; ; attempt += 1) {
      try {
        return await subscribe(engine.client, url, WEBHOOK_API_VERSION);
      } catch (error: unknown) {
        // A new tunnel address can take a few seconds to resolve.
        if (attempt >= SUBSCRIBE_TRIES) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, SUBSCRIBE_RETRY_MS));
      }
    }
  }

  // Starts the webhook receiver, gives it a public address and points the Airwallex
  // subscription at it. If any step fails, the watcher keeps checking payments
  // often enough that nothing waits long.
  async function connectWebhooks(): Promise<void> {
    // On or off in any case, and unset or empty is on. Any other value, such as
    // on|off copied from .env.example, is off, so no tunnel opens that nobody asked for.
    const setting: string = settings.server.webhooks;
    if (setting !== "on") {
      say(
        setting === "off"
          ? "Webhooks are off. Payments in flight are checked every 3 seconds"
          : "Webhooks are off: WEBHOOKS must be on or off, and it is neither. Payments in flight are checked every 3 seconds",
      );
      return;
    }
    try {
      const receiver: WebhookReceiver = new WebhookReceiver(onWebhook);
      await receiver.listen(WEBHOOK_PORT);
      let address: string | undefined = settings.server.webhookUrl;
      if (!address) {
        tunnel = await openTunnel(
          settings.server.cloudflared,
          WEBHOOK_PORT,
          (code: number | null): void => {
            tunnel = null;
            watcher.every(CHECK_EVERY_MS);
            sayWarning(
              `The webhook tunnel closed (exit ${code}). Payments in flight are checked every 3 seconds`,
            );
          },
        );
        address = tunnel.url;
      }
      const url: string = `${address.replace(/\/+$/, "")}${WEBHOOK_PATH}`;
      receiver.setSecret(await subscribeWithRetry(url));
      watcher.every(CHECK_WITH_WEBHOOKS_MS);
      say(`Airwallex webhooks arrive at ${url}`);
    } catch (error: unknown) {
      sayWarning(
        `Webhooks are not connected, so payments in flight are checked every 3 seconds: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { pickUpInterrupted, connectWebhooks, stopTunnel: (): void => tunnel?.stop() };
}
