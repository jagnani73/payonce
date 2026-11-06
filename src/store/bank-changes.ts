import type { TransferBankDetails } from "../airwallex/transfers.js";
import { bankDetailsKey, keyHash, knownRoute, routeKeyOf, routeOfDetailsKey } from "../domain/assess.js";
import type { ContactReads } from "./contacts.js";
import { parsedOf, type Db } from "./db.js";

// A person's callback to the supplier on the number on file, and the bank
// details it confirmed. applied means the supplier's record in Airwallex was
// read back holding them, and appliedKey is that record's bank details as
// bankDetailsKey writes them.
export type BankChangeState = "pending" | "applied" | "failed";

export interface NewBankChange {
  invoiceId: string;
  beneficiaryId: string;
  calledBy: string;
  numberCalled: string;
  calledAt: string;
  spokeTo: string;
  confirmed: string;
  oldDetails: string;
  newDetails: string;
  // The supplier_contacts row of the number called, read before the call was
  // recorded. Null only on a callback made on a number that was never on file.
  contactId: number | null;
}

export interface BankChange extends NewBankChange {
  id: number;
  appliedKey: string | null;
  state: BankChangeState;
  recordedAt: string;
}

interface BankChangeRow {
  id: number;
  invoice_id: string;
  beneficiary_id: string;
  called_by: string;
  number_called: string;
  called_at: string;
  spoke_to: string;
  confirmed: string;
  old_details: string;
  new_details: string;
  applied_key: string | null;
  state: BankChangeState;
  recorded_at: string;
  // Missing on a file opened read-only from before the column.
  contact_id?: number | null;
}

// Who put on file the phone number a callback was made on.
export interface PhoneSetter {
  name: string;
  role: "proposed" | "confirmed";
}

// Each set of bank details a callback applied, with who recorded a callback for
// that account and who put on file a number one of them was made on.
export interface AppliedCallback {
  detailsKey: string;
  recorders: string[];
  phoneSetters: PhoneSetter[];
}

function toBankChange(row: BankChangeRow): BankChange {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    beneficiaryId: row.beneficiary_id,
    calledBy: row.called_by,
    numberCalled: row.number_called,
    calledAt: row.called_at,
    spokeTo: row.spoke_to,
    confirmed: row.confirmed,
    oldDetails: row.old_details,
    newDetails: row.new_details,
    appliedKey: row.applied_key,
    state: row.state,
    recordedAt: row.recorded_at,
    contactId: row.contact_id ?? null,
  };
}

// True when two sets of bank details, as bankDetailsKey writes them, go to the
// same account. False when either cannot be read.
function sameRoute(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  const route: string | null = routeOfDetailsKey(a);
  return route !== null && route === routeOfDetailsKey(b);
}

// Callbacks that confirmed new bank details (bank_changes), and the routeKey of
// every accountKey the ledger keeps.
export class BankChangeStore {
  private readonly db: Db;
  private readonly contacts: ContactReads;

  constructor(db: Db, contacts: ContactReads) {
    this.db = db;
    this.contacts = contacts;
  }

  // The accountKey and routeKey of every set of bank details a callback kept.
  callbackRoutes(): Map<string, string> {
    const routes: Map<string, string> = new Map<string, string>();
    const rows = this.db
      .prepare("SELECT applied_key, old_details FROM bank_changes")
      .all() as unknown as { applied_key: string | null; old_details: string | null }[];
    for (const row of rows) {
      if (row.applied_key !== null) {
        const route: string | null = routeOfDetailsKey(row.applied_key);
        if (route !== null) {
          routes.set(keyHash(row.applied_key), route);
        }
      }
      const before: unknown = row.old_details === null ? null : parsedOf(row.old_details);
      if (before !== null && typeof before === "object" && !Array.isArray(before)) {
        const details: TransferBankDetails = before as TransferBankDetails;
        routes.set(keyHash(bankDetailsKey(details)), routeKeyOf(details));
      }
    }
    return routes;
  }

  // Every accountKey the ledger keeps with the routeKey of the same details: from
  // attempts, where they went, run rows, payouts sent outside PayOnce, approval
  // requests and the details callbacks kept. The supplier view groups accounts through it, so an
  // approval's accountKey joins the account its details go to.
  accountRoutes(): Map<string, string> {
    const routes: Map<string, string> = this.callbackRoutes();
    const rows = this.db
      .prepare(
        `SELECT account_key AS full, route_key AS route FROM attempts WHERE account_key IS NOT NULL AND route_key IS NOT NULL
          UNION SELECT sent_key, sent_route FROM attempts WHERE sent_key IS NOT NULL AND sent_route IS NOT NULL
          UNION SELECT sent_key, sent_route FROM outside_payouts WHERE sent_key IS NOT NULL AND sent_route IS NOT NULL
          UNION SELECT account_key, route_key FROM run_rows WHERE account_key IS NOT NULL AND route_key IS NOT NULL
          UNION SELECT json_extract(terms, '$.accountKey'), route_key FROM approvals
                 WHERE route_key IS NOT NULL
                   AND CASE WHEN json_valid(terms) THEN json_type(terms, '$.accountKey') = 'text' ELSE 0 END`,
      )
      .all() as unknown as { full: string; route: string }[];
    for (const row of rows) {
      const route: string | null = knownRoute(row.route);
      if (route !== null) {
        routes.set(row.full, route);
      }
    }
    return routes;
  }

  // Written before the supplier's record is changed, so a change that fails part
  // way is still on file. One statement, written only while the number called is
  // still the record's phone on file, so a callback on a number that changed
  // while it was being recorded is never on file. Null when it was not written.
  addBankChange(input: NewBankChange): number | null {
    const result: { changes: number | bigint; lastInsertRowid: number | bigint } = this.db
      .prepare(
        `INSERT INTO bank_changes
           (invoice_id, beneficiary_id, called_by, number_called, called_at, spoke_to,
            confirmed, old_details, new_details, recorded_at, contact_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM supplier_contacts
                         WHERE id = ? AND beneficiary_id = ? AND field = 'phone' AND state = 'on_file')`,
      )
      .run(
        input.invoiceId,
        input.beneficiaryId,
        input.calledBy,
        input.numberCalled,
        input.calledAt,
        input.spokeTo,
        input.confirmed,
        input.oldDetails,
        input.newDetails,
        new Date().toISOString(),
        input.contactId,
        input.contactId,
        input.beneficiaryId,
      );
    return Number(result.changes) === 1 ? Number(result.lastInsertRowid) : null;
  }

  finishBankChange(id: number, state: BankChangeState, appliedKey: string | null): void {
    this.db
      .prepare("UPDATE bank_changes SET state = ?, applied_key = ? WHERE id = ?")
      .run(state, appliedKey, id);
  }

  // The latest callback applied to this beneficiary, from any invoice paid to it,
  // when it verified the account the record holds now: where the money goes, so a
  // bank name Airwallex rewrote since does not undo it. A record changed to
  // another account since, in PayOnce or outside it, has none, even when it
  // changed back to an account an older callback verified. It counts only while
  // the number it was made on is the record's phone on file, so a changed number
  // retires it.
  verifiedBankChange(beneficiaryId: string, details: TransferBankDetails): BankChange | undefined {
    const row: BankChangeRow | undefined = this.db
      .prepare(
        `SELECT * FROM bank_changes WHERE beneficiary_id = ? AND state = 'applied'
          ORDER BY id DESC LIMIT 1`,
      )
      .get(beneficiaryId) as unknown as BankChangeRow | undefined;
    if (row === undefined || row.applied_key === null || !sameRoute(row.applied_key, bankDetailsKey(details))) {
      return undefined;
    }
    const contactId: number | null = row.contact_id ?? null;
    if (this.contacts.kept() && (contactId === null || contactId !== this.contacts.onFile(beneficiaryId, "phone")?.id)) {
      return undefined;
    }
    return toBankChange(row);
  }

  // Everyone who recorded an applied callback for the account these details go
  // to, of this beneficiary. None of them may approve a payment to it. A callback
  // whose details cannot be read bars its recorder too.
  bankChangeRecorders(beneficiaryId: string, detailsKey: string): string[] {
    return [
      ...new Set<string>(
        (
          this.db
            .prepare(
              `SELECT called_by, applied_key FROM bank_changes
                WHERE beneficiary_id = ? AND state = 'applied' AND applied_key IS NOT NULL ORDER BY id`,
            )
            .all(beneficiaryId) as unknown as { called_by: string; applied_key: string }[]
        )
          .filter(
            (row: { applied_key: string }): boolean =>
              sameRoute(row.applied_key, detailsKey) ||
              routeOfDetailsKey(row.applied_key) === null ||
              routeOfDetailsKey(detailsKey) === null,
          )
          .map((row: { called_by: string }): string => row.called_by),
      ),
    ];
  }

  // Who recorded each callback on this invoice, in any state, oldest first. Only
  // the names: the number called and what was said stay out.
  callbackRecorders(invoiceId: string): string[] {
    return (
      this.db
        .prepare("SELECT called_by FROM bank_changes WHERE invoice_id = ? ORDER BY id")
        .all(invoiceId) as unknown as { called_by: string }[]
    ).map((row: { called_by: string }): string => row.called_by);
  }

  // Who proposed and who confirmed the phone number each applied callback for the
  // account these details go to was made on, of this beneficiary, by the route
  // test bankChangeRecorders uses. None of them may approve a payment to it,
  // whatever number is on file now. A callback with no contact row bars nobody
  // here, since it verifies nothing.
  callbackPhoneSetters(beneficiaryId: string, detailsKey: string): PhoneSetter[] {
    if (!this.contacts.kept()) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT bank_changes.applied_key, supplier_contacts.proposed_by, supplier_contacts.confirmed_by
           FROM bank_changes JOIN supplier_contacts ON supplier_contacts.id = bank_changes.contact_id
          WHERE bank_changes.beneficiary_id = ? AND bank_changes.state = 'applied'
            AND bank_changes.applied_key IS NOT NULL
          ORDER BY bank_changes.id`,
      )
      .all(beneficiaryId) as unknown as { applied_key: string; proposed_by: string | null; confirmed_by: string | null }[];
    const setters: PhoneSetter[] = [];
    for (const row of rows) {
      if (
        !sameRoute(row.applied_key, detailsKey) &&
        routeOfDetailsKey(row.applied_key) !== null &&
        routeOfDetailsKey(detailsKey) !== null
      ) {
        continue;
      }
      const found: PhoneSetter[] = [
        ...(row.proposed_by === null ? [] : [{ name: row.proposed_by, role: "proposed" as const }]),
        ...(row.confirmed_by === null ? [] : [{ name: row.confirmed_by, role: "confirmed" as const }]),
      ];
      for (const setter of found) {
        if (!setters.some((known: PhoneSetter): boolean => known.name === setter.name && known.role === setter.role)) {
          setters.push(setter);
        }
      }
    }
    return setters;
  }

  // Each set of bank details a callback applied to this beneficiary, with
  // everyone who recorded a callback for that account (bankChangeRecorders) and
  // who put on file a number one was made on (callbackPhoneSetters): what
  // barredFrom reads.
  callbacksFor(beneficiaryId: string): AppliedCallback[] {
    return this.appliedKeys(beneficiaryId).map((detailsKey: string): AppliedCallback => ({
      detailsKey,
      recorders: this.bankChangeRecorders(beneficiaryId, detailsKey),
      phoneSetters: this.callbackPhoneSetters(beneficiaryId, detailsKey),
    }));
  }

  // The applied callback whose record matches an approval's accountKey, keyed by
  // the hash the terms carry.
  appliedKeys(beneficiaryId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT applied_key FROM bank_changes
            WHERE beneficiary_id = ? AND state = 'applied' AND applied_key IS NOT NULL`,
        )
        .all(beneficiaryId) as unknown as { applied_key: string }[]
    ).map((row: { applied_key: string }): string => row.applied_key);
  }

  bankChange(id: number): BankChange | undefined {
    const row: BankChangeRow | undefined = this.db
      .prepare("SELECT * FROM bank_changes WHERE id = ?")
      .get(id) as unknown as BankChangeRow | undefined;
    return row === undefined ? undefined : toBankChange(row);
  }
}
