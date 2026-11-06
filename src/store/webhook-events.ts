import type { Db } from "./db.js";

// Webhook events taken, by id, so a redelivered one is ignored (webhook_events).
export class WebhookEventStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Records a webhook event by its id. False when it has been seen before, since
  // Airwallex may deliver an event more than once.
  firstDelivery(eventId: string, name: string): boolean {
    const result: { changes: number | bigint } = this.db
      .prepare(
        "INSERT OR IGNORE INTO webhook_events (id, name, received_at) VALUES (?, ?, ?)",
      )
      .run(eventId, name, new Date().toISOString());
    return Number(result.changes) === 1;
  }
}
