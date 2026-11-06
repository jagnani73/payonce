import type { Can, SupplierContactView } from "../../types";

// What the contact card sends besides reading SupplierContactView: the source
// codes the routes take and the route bodies.

// Where a person found the number (supplier-contacts.md section 2). Never an
// email and never the Airwallex record. The codes are domain/contacts.ts's.
export type ContactSource = "contract" | "website" | "known-number" | "in-person" | "other";

export const SOURCES: readonly { code: ContactSource; label: string }[] = [
  { code: "contract", label: "Supplier's contract or onboarding form" },
  { code: "website", label: "Supplier's website" },
  { code: "known-number", label: "A call to a number already known for the supplier" },
  { code: "in-person", label: "In person" },
  { code: "other", label: "Other (note required)" },
];

// The bodies of POST /api/suppliers/:key/contact, …/:id/confirm and …/:id/withdraw.
export interface ProposeInput {
  field: "phone";
  value: string;
  name: string;
  source: ContactSource;
  note: string;
}

export interface ConfirmInput {
  value: string;
  name: string;
  source: ContactSource;
  note: string;
}

export interface WithdrawInput {
  name: string;
  note: string;
}

export function actionOf(contact: SupplierContactView, key: "propose" | "confirm" | "withdraw"): Can | null {
  return Object.hasOwn(contact.actions, key) ? (contact.actions[key] ?? null) : null;
}
