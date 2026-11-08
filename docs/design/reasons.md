# Reasons and situations

How PayOnce records why an invoice went to a person, as text with codes beside it, and how it works out a payment's situation: its state, what it waits on and what a person can do. The code is `src/domain/reasons.ts`, `src/domain/live.ts`, `src/domain/situation.ts` and `src/views/snapshot.ts`, with the reason columns written in `src/store/invoices.ts`. It backs invariant 62 in [invariants.md](../invariants.md), and [glossary.md](../glossary.md) defines reason, reason code and situation.

## Rules

### A reason as codes

- A `Reason` is a lead `ReasonCode`, its `Slots` and a list of `Clause`s, each a `ClauseCode` with slots of its own. A text PayOnce does not write is an `UnrecognisedReason` (code `unrecognised`, the text as stored). `StoredReason` is either.
- Slots hold only PayOnce's own values in closed patterns: invoice numbers (`[A-Za-z0-9-]{1,40}`), a wallet currency, a failure code, a transfer kind, a bank reference, a rate and an amount.
- `reasonText` renders a reason to its exact text: the lead's text, then each clause after ", and ". The texts are the strings an older ledger holds, so a reason reads the same with codes or without them.
- `parseReason` reads a text back to a reason. A parse counts only when `reasonText` renders it to the same text, so `reasonText(parseReason(text)) === text` for every text, and anything else is `unrecognised`.
- `parseReason` tries each lead part at the start of the text, then the clauses after it (`clausesFrom`), backtracking, so a clause that also matches a shorter prefix does not hide a longer one.
- `parseClause` reads a lone clause, as an "Also, ..." line holds one, and `clauseText` writes one.
- The grammar is compiled on first use (`grammarOf`), from the lead parts (`leadParts`) and the clause parts (`clauseParts`).

### Which reasons exist

- The policy's reasons are constants in `src/domain/decide.ts`.
- The engine's fixed reasons are constants in `reasons.ts`: `EMAILS_BEFORE_PAYMENT_REASON`, `LATE_TRANSFER_REASON`, `MISMATCHED_TRANSFER_REASON`, `MISMATCHED_FAILED_REASON`, `REPLACEMENT_DEADLINE_REASON`, `ACCOUNT_CHANGED_REASON`, `ACCOUNT_UNKNOWN_REASON`, `CASH_HOLD_REASON`, `RUN_ACCOUNT_CHANGED_REASON`, `BENEFICIARY_MISSING_REASON` and `PERSON_STARTED_REASON`.
- A reason with slots is built by its own function: `heldAsSecondBill`, `heldForSameNumber`, `heldForRate`, `refusedOriginal`, `foundAfterClose`, `accountMismatchOf`, `rateMismatchOf` and `secondBillPaid`. Any other reason is `reasonFor(code)`.
- The clauses are the three floor clauses (`below-floor`, `cash-unreadable`, `no-floor`; `FLOOR_CLAUSES`), `second-bill-paid` and `asks-not-to-pay` (`NOT_TO_PAY`).
- `withClause` joins a clause last, unless the lead or a clause already names it. The engine adds clauses in `src/engine/reason-text.ts` ([uploaded-emails.md](uploaded-emails.md) has the ask not to pay).
- The policy's text reasons become codes as they leave `decide` (`policyReason`, `floorClause`). A text with no code throws, and the look fails closed.
- Every reason has a family (`familyOf`, a `ReasonFamily` such as `bank-details` or `paid-twice`) and a label for people (`labelOf`). `reasonView` gives a view the code, family, label, text and each clause's label.
- `aboutBankDetailsReason`, `accountChangedReason`, `deadlineReason` and `routineApproval` answer what a reason is about, by code.
- `person-started` (`PERSON_STARTED_REASON`, "a person started this payment, so someone else approves it before PayOnce pays it") is the reason a payment a person started waits for an approval when nothing more specific holds it. Its family is `approval`, and both its label and the metrics label of its family are "New payment to approve". `routineApproval` is true for that reason with no clause joined on. That approval is part of the payment, so the incident, the summary and the metrics do not treat it as an incident (below, and [metrics.md](metrics.md)).
- `neededWhyOf` reads why a request needs a second approver (`approvals.needed_why`) to a `NeededWhyCode`. No codes are stored for it.

### How a reason is stored

- The text is the record. Approval terms carry `reasonText(reason)`, the same text a ledger without codes holds, so no binding moves.
- Every escalation writes the text and its codes in one statement (`SET_REASON`, `reasonColumns`): `escalation_reason`, `escalation_code`, `escalation_clauses` and `escalation_slots`. [ledger.md](ledger.md) has the columns.
- The store's escalation methods take a `Reason` or `StoredReason`, never a string: `escalate`, `escalateIfChanged`, `rewordEscalation`, `holdBeforePaying`, `escalateIfOpen`, `escalateUnlessSettled`, `linkOutsidePayout`'s reopen and `addMismatched`.
- A reason that never went to a person has an empty text and code.
- `Ledger.reasonOf(obligation)` reads the stored codes while the row's text is still the text the obligation was read with, and parses that text otherwise. Either way the reason renders `obligation.escalationReason` exactly.
- `storedReason` takes the codes only when they render the stored text exactly. A row whose codes do not is read by parsing its text, and the first such row in a process prints one warning.

### What live means

- `domain/live.ts` defines each test of "live" for one transfer: `ownLive`, `mismatchedLive`, `liveAtBank`, `withBank`, `sending`, `inFlight`, `unrecognisedLive`, `unrecognisedPaid` and `unrecognisedUncleared`.
- It also defines, for one transfer, `stillWithBank`, `nothingWithBank`, `keptFailedLive` and `neverSent`.
- For one outside payout: `payoutLive`, `payoutNotFailed`, `payoutPays` and `payoutNamesOnly`.
- For one payment over its transfers and payouts: `lateBesideLive`, `paidOnce`, `paidByReplacement`, `closeRefusedBy`, `closesItself`, `paidOutside`, `paidMismatched`, `couldStillPay`, `heldBeforePaying` and `watching`.
- For one request: `expiryOf`, `isExpired`, `awaitingSignoffs`, `approvedUnspent`, `requestOpen`, `requestExpired` and `approvedUnderway`.
- `deadlineAt` counts a bank deadline from the creation time Airwallex gave. `pastDeadline` compares it with now, and with no creation time on file it asks whether the reason is a deadline reason.
- Three SQL guards in the store's write transactions are the same tests over rows: `LIVE_ATTEMPT` is `liveAtBank`, `LIVE_OUTSIDE_PAYOUT` is `payoutNotFailed` and `UNCLEARED_MISMATCH` is `unrecognisedUncleared`. Two have no test in code: `BLOCKING_OUTSIDE_PAYOUT` (a payout in flight, in an unknown status, or paid and paying the invoice) and `SENT_ATTEMPT` (an attempt with a transfer, or not failed).
- Where a predicate restates a guard, the guard inside its write transaction stays the authority. `closeRefusedBy` restates what `CloseStore.settle` refuses, and settle's SQL decides.
- The store keeps only the SQL forms. Where store code tests a row in TypeScript (`store/closes.ts`, `store/payouts.ts`, `store/read/`), it imports the test from `domain/live.ts`.

### The snapshot

- `views/snapshot.ts` loads what a situation is worked from, from the ledger alone, in one `readSnapshot`, reading stored JSON soft (`readingSoft`). It writes nothing.
- An `InvoiceSnapshot` holds the obligation, its attempts and payouts, every request oldest first with its terms (null when they do not parse), the stored reason (`Ledger.reasonOf`) and the email counts and findings.
- It also holds the active outage on the invoice's rail with its holds on this invoice and who may end it, the pay run row and the run's turn, what the inbox names it, and `callbackBlocked`.
- The rest: the signing facts (the policy, who is barred, whether the starter is known), the bank deadline in minutes, the next check (`Ledger.nextCheckAt`), the last check, whether a step is running, the times and whether Ask why is set up.
- `callbackBlocked` is `domain/callback.ts` on `callbackFacts` from `store/read/callback.ts`, the same check the engine's callback form and `recordBankChange` read.
- Who is barred: while the latest request on an escalated invoice waits for signoffs, those `barredFrom` bars for its account, as the engine bars them; otherwise whoever started the payment.
- `SnapshotOptions` carries the approval policy and whether Ask why is on. `lastCheck` and `busy` are optional callbacks for a process that keeps them.
- The reads every invoice shares (the metrics rows the times come from, outage holds, pay run rows and the inbox's names) are made once per call (`sharedOf`).
- `readInvoiceSnapshots` reads every invoice or the ones named. `invoiceSnapshotsWithin` does the same inside a view's own read snapshot. `readRunSnapshot` and `readRunSnapshots` load a `RunSnapshot`.

### The situation

- `situationOf(snapshot, now)` is pure: it reads no ledger, clock or settings. Nothing in `situation.ts` pays, holds, approves or closes.
- A `Situation` holds a state and variant, a label and detail, a tone, a queue group, who it waits on, the next step in words, the reason's view, blockers, extra lines, times and `can`.
- The state is the first whose test holds, in this order (`placed`): `paid`, `closed-unpaid`, `paid-twice`, `unrecognised-transfer`, `closing` for an escalated invoice that closes itself, `ready-to-close`, `paused-by-outage`, `needs-approval`, `approved` and `renewing-request`.
- After those: `bank-late`, `with-bank`, `sending` (or `needs-decision` while changed bank details hold it), `queued-in-run`, `reading-emails`, `needs-callback`, `needs-phone`, `no-approvers`, `needs-decision`, `closing` for an open invoice paid once, `deciding`, `starting` and `checking`.
- The last five person states (`reading-emails` to `needs-decision`) apply only to an escalated invoice a person could close without paying that has no request open.
- `needs-callback` needs the bank details in question, a phone on file and no `callbackBlocked`. `needs-phone` needs the bank details in question and no phone on file.
- Each state has one label, tone and `QueueGroup` (`STATES`): `needs-you`, `bank-late`, `with-bank`, `payonce` or `closed`.
- `closeKindFor` says what a person's close would record: the paid payment's kind, `outside`, `mismatched`, or, once nothing that may pay it is live, `duplicate` for a held second bill nobody closed before and `unpaid` for the rest. Undefined while it cannot close.
- `can` says what a person can do now: `approve`, `recordCallback`, `closeAsPaid`, `closeUnpaid`, `endOutage`, `draftTrace`, `checkNow` and `askWhy`, each allowed or refused with a coded `Why`. It is display only: the engine checks again when the person acts.
- `approverChoices` gives each approver and whether they can sign the latest request, with `checkSigner`'s own words when they cannot. `whyNoRequest` says why an escalated payment a person could pay has no request.
- Blockers: Airwallex unreachable or answering with an error at the last check, an outage that would hold an approval given now, the email reader failing, and a check more than 2 minutes overdue while no step runs.
- `incidentOf` gives a payment's incident (its cause, when it opened and ended, whether it needed a person), or null for one paid by its first transfer with nothing else on file.
- A reason that is only the routine approval (`routineApproval`) opens no incident: a payment waiting for that approval has none, and neither does one its first transfer pays after it. The time the payment first went to a person for that approval is not when an incident opened, and a first transfer sent on it is not a held payment, so a later incident's cause is its own reason's label, not "On hold: ...". `routineRequest` reads a request's terms to tell.
- `requestStateOf` gives a request's state for people: `waiting`, `approved`, `used`, `expired`, `replaced` or `withdrawn`.
- `runSituationOf` does the same for a pay run, `runStatusOf` is `runStatus`'s rule with the clock passed in, and `runRowStateOf` gives a run row's state.

### Who reads codes and situations

- Alerts work out an invoice's need from `situationOf` and leave the floor clauses out of the fingerprint with `withoutClauses(reason, FLOOR_CLAUSES)` ([alerts.md](alerts.md)).
- The page's Incidents and home screens, search, the inbox's candidates and the pay run views read situations (`views/incidents.ts`, `views/rows.ts`, `views/home.ts`, `views/search.ts`, `views/inbox.ts`, `views/runs.ts`).
- The incident view (`views/incident.ts`) reads the situation and `incidentOf`. The request view reads the terms' reason with `parseReason` and why a second approver is needed with `neededWhyOf`.
- The summary's "PayOnce did" (`views/summary.ts`) names the routine approval only when PayOnce did nothing since that says more, such as a replacement it sent by itself. Home's last close (`lastClosedAt`, "Last incident closed") counts only payments with an incident, and the Incidents list without `clean` leaves out closed payments with none.
- The payment check, the summary and the decision card read `reasonView`, `reasonText` and `closeKindOf`. `views/contract.ts` re-exports the domain types unchanged.
- The incident's cautions (`views/cautions.ts`) come from clause codes, the situation's extra lines and blockers, and the reason's code.
- The supplier view's cautions test `accountChangedReason` on `Ledger.reasonOf`, and the `paid-twice` and `needs-phone` states ([supplier-view.md](supplier-view.md)).
- The outbox suggests a callback notice by `aboutBankDetailsReason` and a bank trace on `inFlight` and `pastDeadline` ([outbox.md](outbox.md)).
- Metrics count reasons by `familyOf`, and `REASON_LABELS` is keyed by family. A closed invoice whose reason is only the routine approval counts by what happened after it (`closeHow`, [metrics.md](metrics.md)).
- Ask why takes the escalation reason from its codes and reads every other reason text with `parseReason` and `parseClause` ([ask-why.md](ask-why.md)).
- The incident board (`views/incident-board.ts`, `pnpm board`) reads the reason text, not the codes: it tests the text's start against `DEADLINE_REASONS`, `BANK_DETAILS_REASONS` and `OUTAGE_REASON` ([incident-board.md](incident-board.md)).
- The engine reads its own reasons by code where it needs to, takes `closeKindFor` for `pendingClose` and `paidByReplacement` for the look's own close, and reads no situation.

## Why

- The text stays the record because approval terms and bindings hold it, alerts post it and an older ledger has nothing else. The codes are an index that can always be rebuilt from the text, so they change no binding.
- `parseReason` counts a parse only when it renders back exactly, so the codes can never describe a different reason from the one stored. A text an older PayOnce wrote either matches a part exactly or reads as `unrecognised`.
- `policyReason` throws on a policy text with no code because that reason would otherwise be stored as `unrecognised` and reach alerts and Ask why as a stand-in. A failed look shows the missing code at once.
- `reasonOf` compares the row's text with the text the obligation was read with, so a reason another process wrote since is never taken for the one the look read.
- `situationOf` is pure, and the page's screens, alerts, the supplier cautions and MCP answers all call it on the same kind of snapshot, so they cannot disagree about what a payment waits on.
- The guard inside the write transaction stays the authority because a view reads a snapshot that may already be stale, and two processes share the ledger.
- `live.ts` gives one definition of each kind of live, and the situation, alerts, the outbox and the views import it, so they read a transfer as live or not in the same way.
- Every payment a person starts waits for the routine approval, so counting it as an incident would make each of them one and put it under Needed a person in Reports. Its reason stays stored as it is, because terms and bindings hold the text, and only the views and the metrics read it as routine. Alerts, the board and the situation still show the wait, since a person has to approve.
- The supplier view's cautions load no approver list (`situationsOf` passes `policyFromEnv({})`) because `paid-twice` and `needs-phone` come before every state the approver list decides.

## Edge cases

- A ledger written before the code columns gets them from `Schema.backfillReasonCodes`, once, when the columns are added under the write lock. A text PayOnce does not write gets `unrecognised`.
- An older PayOnce that rewrites the text of a row this one coded leaves the codes behind. They no longer render the text, so the row is read by parsing, with one warning per process.
- Older wordings still parse: the second bill's "case, spacing, zeros or a letter suffix" and the misdirected transfer's "the ones it was approved for". They carry `wording: "legacy"` and render back as written.
- A rate mismatch can have no rate on the transfer, an amount that could not be read, or no approved quote at all, and each renders as the engine wrote it.
- A held invoice whose reason is `unrecognised` has no codes to join a clause to, so the ask not to pay is added as text by `decide.ts`'s `namingNotToPay`, and the result stays `unrecognised`.
- `account-unknown-before-send` (`ACCOUNT_UNKNOWN_REASON`) is family `bank-details`, label "Bank details not known before sending". The situation's `detailsChanged` names it, so it waits on a person as `details-changed`. Its next step says PayOnce does not know which details the payment was for and will not send it again. `accountChangedReason` does not name it, because the supplier caution that test feeds says the details changed.
- `escalateIfOpen` leaves all four reason columns as they are on an invoice that is already escalated, so the reason it went to a person for stands.
- A payment a person started and closed without paying while it waited for the routine approval has the incident "Closed without paying", which needed a person.
- The routine reason stops being routine once a clause joins it, as when the supplier asks not to pay. The payment then has an incident, and metrics count it with a person.
- An escalated payment whose own transfer is with the bank is `with-bank`, in the `with-bank` group, not `needs-you`. Alerts give it a need all the same ([alerts.md](alerts.md)).
- A request whose terms do not parse is told apart by the invoice: a held invoice's is a payment, any other a replacement.
- No caller passes `lastCheck`, so the two Airwallex blockers do not show, and `sending` reads as retrying from the attempt's last try time alone.
- A next check time that is blank or cannot be read is null, and the wording says "at its next check" with no time.
- The times come from the metrics read (`metricsRead`). A time that cannot be read is null.
