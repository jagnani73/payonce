import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { getJson, postJson, query, type ApiError } from "../api";
import { ActionButton, LinkButton } from "../components/Action";
import { Field, NameField, type ControlProps } from "../components/Form";
import { Theirs } from "../components/Text";
import { useTitle } from "../hooks";
import { useNameDraft } from "../me";
import { notify } from "../notices";
import { usePoll, type Polled } from "../poll";
import { navigate, paymentHref, supplierHref, type ScreenProps } from "../router";
import { logAction, useSandboxOutcome } from "../sandbox";
import { joinNames } from "../text";
import type {
  BeneficiaryOption,
  BeneficiaryPickerView,
  CashView,
  NewPaymentInput,
  PaymentCheckView,
  PaymentCreated,
  TransferMethod,
  WalletCashView,
} from "../types";
import { BeneficiaryPicker } from "./new-payment/picker";
import { NextSteps } from "./new-payment/preview";
import "./new-payment.css";

// New payment (ia.md section 4): one supplier invoice, paid once. The form keeps
// its drafts in its own state. Every change asks POST /api/payments/check what
// would happen, 400 ms after the last keystroke, and only the newest answer is
// shown. Start sends POST /api/payments and opens the payment.

const CHECK_MS: number = 400;
// The wallets with a balance, read once and then each minute. Faster while the
// server's first balance read is still running.
const CASH_MS: number = 60_000;
const CASH_FIRST_MS: number = 2_000;

type FieldKey = "supplierKey" | "invoiceId" | "amount" | "currency" | "wallet" | "method" | "dueDate" | "startedBy" | "sandbox";

const METHOD_LABELS: Record<TransferMethod, string> = { LOCAL: "Local transfer", SWIFT: "SWIFT" };
const BOTH_METHODS: readonly TransferMethod[] = ["LOCAL", "SWIFT"];

// "3,750.00" is written with no separator, as the server reads amounts. Only a
// well-formed grouping is undone; anything else goes as typed and the server
// says what is wrong with it.
function amountToSend(typed: string): string {
  const trimmed: string = typed.trim();
  return /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(trimmed) ? trimmed.replace(/,/g, "") : trimmed;
}

// What the form sends: a NewPaymentInput with no method until one is picked,
// which the server answers as a problem with the method field.
type FormInput = Omit<NewPaymentInput, "method"> & { method: TransferMethod | "" };

interface Checked {
  body: string;
  view: PaymentCheckView;
}

export function NewPayment(props: ScreenProps): JSX.Element {
  useTitle("New payment");
  const supplierParam: string | null = props.route.params.get("supplier");
  const outcome: string = useSandboxOutcome();
  const [name, setName] = useNameDraft();
  const [picked, setPicked] = useState<BeneficiaryOption | null>(null);
  const [invoice, setInvoice] = useState<string>("");
  const [made, setMade] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [typedCurrency, setTypedCurrency] = useState<string>("");
  const [wallet, setWallet] = useState<string | null>(null);
  const [method, setMethod] = useState<TransferMethod | null>(null);
  const [due, setDue] = useState<string>("");
  const [touched, setTouched] = useState<ReadonlySet<FieldKey>>(new Set());
  const [checked, setChecked] = useState<Checked | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ body: string; fields: Record<string, string> } | null>(null);
  const searchId: string = useId();

  const touch = (...fields: FieldKey[]): void =>
    setTouched((now: ReadonlySet<FieldKey>): ReadonlySet<FieldKey> => new Set([...now, ...fields]));

  // Picking fills the currency and the method: the beneficiary's own, the first
  // of two, or none when the record lists neither.
  const pick = (option: BeneficiaryOption): void => {
    setPicked(option);
    setWallet(null);
    setMethod(BOTH_METHODS.find((one: TransferMethod): boolean => option.methods.includes(one)) ?? null);
    touch("supplierKey");
  };

  // #new-payment?supplier=K: that beneficiary, picked once the list answers,
  // unless the person picked one first.
  const pickedRef = useRef<BeneficiaryOption | null>(null);
  pickedRef.current = picked;
  useEffect((): (() => void) | undefined => {
    if (supplierParam === null || supplierParam === "") {
      return undefined;
    }
    let gone: boolean = false;
    getJson<BeneficiaryPickerView>(query("/api/beneficiaries", { q: supplierParam }))
      .then((view: BeneficiaryPickerView): void => {
        const found: BeneficiaryOption | undefined = view.options.find((option: BeneficiaryOption): boolean => option.key === supplierParam);
        if (!gone && found !== undefined && pickedRef.current === null) {
          pick(found);
        }
      })
      .catch((): void => undefined);
    return (): void => {
      gone = true;
    };
  }, [supplierParam]);

  const cash: Polled<CashView> = usePoll<CashView>(
    "/api/cash",
    (view: CashView | null): number => (view !== null && view.balances.readAt === null && view.balances.problem === null ? CASH_FIRST_MS : CASH_MS),
  );

  const currency: string = picked?.currency ?? typedCurrency.trim().toUpperCase();
  const otherWallets: WalletCashView[] = (cash.data?.wallets ?? []).filter(
    (entry: WalletCashView): boolean => entry.wallet !== currency && entry.available !== null && entry.available.minor > 0,
  );
  const payFrom: string = wallet !== null && otherWallets.some((entry: WalletCashView): boolean => entry.wallet === wallet) ? wallet : currency;
  const methods: readonly TransferMethod[] = picked === null || picked.methods.length === 0 ? BOTH_METHODS : picked.methods;

  const input: FormInput = {
    supplierKey: picked?.key ?? "",
    invoiceId: invoice.trim() === "" ? (made ?? "") : invoice.trim(),
    amount: amountToSend(amount),
    currency,
    wallet: payFrom,
    method: method ?? "",
    dueDate: due === "" ? null : due,
    startedBy: name,
    sandbox: { bankOutcome: outcome },
  };
  const body: string = JSON.stringify(input);

  // One check per pause in typing. An answer to an older form is dropped.
  const latest = useRef<number>(0);
  useEffect((): (() => void) => {
    const mine: number = latest.current + 1;
    latest.current = mine;
    const timer: number = window.setTimeout((): void => {
      postJson<PaymentCheckView>("/api/payments/check", JSON.parse(body))
        .then((view: PaymentCheckView): void => {
          if (latest.current !== mine) {
            return;
          }
          setChecked({ body, view });
          setCheckError(null);
          const sentEmpty: boolean = (JSON.parse(body) as FormInput).invoiceId === "";
          if (sentEmpty) {
            setMade(view.invoiceId);
          } else if (invoice.trim() === "" && view.fields["invoiceId"] !== undefined) {
            // The number PayOnce made was taken meanwhile: ask for another.
            setMade(null);
          }
        })
        .catch((error: ApiError): void => {
          if (latest.current === mine) {
            setCheckError(error.message);
          }
        });
    }, CHECK_MS);
    return (): void => window.clearTimeout(timer);
  }, [body]);

  useEffect((): void => {
    if (refused !== null && refused.body !== body) {
      setRefused(null);
    }
  }, [body]);

  const view: PaymentCheckView | null = checked?.view ?? null;
  const filled: Record<FieldKey, boolean> = {
    supplierKey: picked !== null,
    invoiceId: invoice.trim() !== "",
    amount: amount.trim() !== "",
    currency: currency !== "",
    wallet: currency !== "",
    method: method !== null,
    dueDate: due !== "",
    startedBy: name.trim() !== "",
    sandbox: true,
  };
  // A problem shows once its field is filled in or was left, so an empty form
  // is not all red. A refused start shows every problem it named.
  const errorOf = (field: FieldKey): string | null => {
    if (refused !== null) {
      return refused.fields[field] ?? null;
    }
    const text: string | undefined = view?.fields[field];
    return text !== undefined && (filled[field] || touched.has(field)) ? text : null;
  };
  const marked: boolean = (Object.keys(view?.fields ?? {}) as FieldKey[]).some((field: FieldKey): boolean => errorOf(field) !== null);

  const missing: string[] = [
    picked === null ? "pick a beneficiary" : null,
    amount.trim() === "" ? "enter an amount" : null,
    method === null ? "pick a transfer method" : null,
    name.trim() === "" ? "enter who is starting it" : null,
  ].filter((part: string | null): part is string => part !== null);
  const current: boolean = checked !== null && checked.body === body;
  const blocked: boolean = missing.length > 0 || (current && Object.keys(view?.fields ?? {}).length > 0);
  const reason: string = missing.length > 0 ? `To start it, ${joinNames(missing, "and")}.` : "Fix the fields above to start it.";

  async function start(): Promise<void> {
    const created: PaymentCreated = await postJson<PaymentCreated>("/api/payments", input);
    logAction(created.invoiceId, `Started from New payment. ${view?.sandbox?.text ?? `Sandbox bank outcome: ${outcome}.`}`);
    notify(created.notice);
    navigate(paymentHref(created.invoiceId));
  }

  function startRefused(error: ApiError): void {
    const fields: unknown = error.body?.fields;
    if ((error.status === 400 || error.status === 409) && typeof fields === "object" && fields !== null) {
      setRefused({ body, fields: fields as Record<string, string> });
      // Someone took the number PayOnce made before this start: make another.
      if (invoice.trim() === "" && (fields as Record<string, unknown>)["invoiceId"] !== undefined) {
        setMade(null);
      }
    }
  }

  const amountError: string | null = errorOf("amount") ?? errorOf("currency");
  return (
    <div class="screen np">
      <header class="screen__head">
        <h1 class="screen__title">New payment</h1>
        <p class="screen__lede">One supplier invoice, paid once. PayOnce runs its checks before the first transfer.</p>
      </header>
      <div class="np-layout">
        <form class="card np-form" onSubmit={(event: Event): void => event.preventDefault()} noValidate>
          <fieldset class="np-fieldset">
            <legend class="np-legend">
              Supplier <span class="np-legend__aside">(Airwallex beneficiary)</span>
            </legend>
            <label class="visually-hidden" for={searchId}>
              Search beneficiaries
            </label>
            <BeneficiaryPicker
              picked={picked}
              onPick={pick}
              error={errorOf("supplierKey")}
              inputId={searchId}
              describedBy={errorOf("supplierKey") === null ? undefined : `${searchId}-error`}
            />
            {errorOf("supplierKey") === null ? null : (
              <span class="field__error" id={`${searchId}-error`} role="alert">
                {errorOf("supplierKey")}
              </span>
            )}
          </fieldset>

          <div class="np-pair">
            <Field label="Invoice number" error={errorOf("invoiceId")}>
              {(control: ControlProps): JSX.Element => (
                <input
                  {...control}
                  class="input mono"
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  maxLength={40}
                  placeholder={made === null ? "Leave empty and PayOnce makes one" : `Leave empty to use ${made}`}
                  value={invoice}
                  onInput={(event: Event): void => setInvoice((event.currentTarget as HTMLInputElement).value)}
                  onBlur={(): void => touch("invoiceId")}
                />
              )}
            </Field>
            <Field label="Amount" error={amountError}>
              {(control: ControlProps): JSX.Element => (
                <span class={amountError === null ? "np-amount" : "np-amount is-invalid"}>
                  <input
                    {...control}
                    class="np-amount__input"
                    type="text"
                    inputMode="decimal"
                    autocomplete="off"
                    spellcheck={false}
                    maxLength={20}
                    placeholder="0.00"
                    value={amount}
                    onInput={(event: Event): void => setAmount((event.currentTarget as HTMLInputElement).value)}
                    onBlur={(): void => touch("amount")}
                  />
                  {picked === null || picked.currency !== null ? (
                    <span class="np-amount__suffix">{picked === null ? "Currency" : `${currency} (the account's currency)`}</span>
                  ) : (
                    <input
                      class="np-amount__currency"
                      type="text"
                      aria-label="Currency"
                      autocomplete="off"
                      spellcheck={false}
                      maxLength={3}
                      placeholder="USD"
                      value={typedCurrency}
                      onInput={(event: Event): void => setTypedCurrency((event.currentTarget as HTMLInputElement).value)}
                      onBlur={(): void => touch("currency")}
                    />
                  )}
                </span>
              )}
            </Field>
          </div>

          <fieldset class="np-fieldset">
            <legend class="np-legend">Pay from</legend>
            {currency === "" ? (
              <p class="muted">Pick a beneficiary first.</p>
            ) : (
              <div class="np-radios np-radios--stack">
                <label class="np-radio">
                  <input type="radio" name="np-wallet" checked={payFrom === currency} onChange={(): void => setWallet(null)} />
                  {`${currency} wallet`}
                </label>
                {otherWallets.map(
                  (entry: WalletCashView): JSX.Element => (
                    <label class="np-radio" key={entry.wallet}>
                      <input
                        type="radio"
                        name="np-wallet"
                        checked={payFrom === entry.wallet}
                        onChange={(): void => {
                          setWallet(entry.wallet);
                          touch("wallet");
                        }}
                      />
                      <span>
                        {`${entry.wallet} wallet `}
                        <span class="muted">(converts; a person approves the exchange rate before PayOnce pays)</span>
                      </span>
                    </label>
                  ),
                )}
              </div>
            )}
            {errorOf("wallet") === null ? null : (
              <span class="field__error" role="alert">
                {errorOf("wallet")}
              </span>
            )}
          </fieldset>

          <fieldset class="np-fieldset">
            <legend class="np-legend">Transfer method</legend>
            {picked === null ? (
              <p class="muted">Pick a beneficiary first.</p>
            ) : methods.length === 1 && methods[0] !== undefined ? (
              <p class="np-only">{`${METHOD_LABELS[methods[0]]} (the only method this beneficiary has)`}</p>
            ) : (
              <div class="np-radios">
                {methods.map(
                  (one: TransferMethod): JSX.Element => (
                    <label class="np-radio" key={one}>
                      <input
                        type="radio"
                        name="np-method"
                        value={one}
                        checked={method === one}
                        onChange={(): void => {
                          setMethod(one);
                          touch("method");
                        }}
                      />
                      {METHOD_LABELS[one]}
                    </label>
                  ),
                )}
              </div>
            )}
            {errorOf("method") === null ? null : (
              <span class="field__error" role="alert">
                {errorOf("method")}
              </span>
            )}
          </fieldset>

          <div class="np-pair">
            <Field
              label="Due date (optional)"
              hint="When the supplier expects the money. This is advice only and never stops a payment."
              error={errorOf("dueDate")}
            >
              {(control: ControlProps): JSX.Element => (
                <input
                  {...control}
                  class="input"
                  type="date"
                  value={due}
                  onInput={(event: Event): void => setDue((event.currentTarget as HTMLInputElement).value)}
                  onBlur={(): void => touch("dueDate")}
                />
              )}
            </Field>
            <div onFocusOut={(): void => touch("startedBy")}>
              <NameField
                label="Started by"
                value={name}
                onInput={setName}
                hint="You won't be able to approve this payment's transfers."
                error={errorOf("startedBy")}
              />
            </div>
          </div>

          {view?.contact === null || view?.contact === undefined || picked === null ? null : (
            <div class="np-contact">
              <span class="np-contact__title">Contact on file</span>
              {view.contact.phoneEnding === null ? (
                <span class="np-contact__warn">
                  No phone on file. If the supplier ever asks to change bank details, nobody can call back until one is added.
                </span>
              ) : (
                <span>{`Phone: ending ${view.contact.phoneEnding}`}</span>
              )}
              {view.contact.emailDomain === null ? null : (
                <span>
                  {"Email domain: "}
                  <Theirs text={view.contact.emailDomain} />
                </span>
              )}
              {picked.onRecord ? (
                <a class="np-contact__link" href={supplierHref(picked.key)}>
                  Edit on the supplier record
                </a>
              ) : null}
            </div>
          )}
        </form>

        <NextSteps
          check={view}
          waitingFor={picked === null ? "Pick a beneficiary and enter an amount to see what PayOnce will do." : null}
          stale={checked !== null && !current}
          marked={marked}
          error={checkError}
          wantsHeadroom={amount.trim() !== ""}
          sandboxError={errorOf("sandbox")}
        />

        <div class="np-actions">
          <ActionButton
            label="Start payment"
            busyLabel="Starting…"
            kind="primary"
            disabled={blocked}
            reason={reason}
            onAction={start}
            onError={startRefused}
          />
          <LinkButton href={supplierParam === null || supplierParam === "" ? "#home" : supplierHref(supplierParam)}>Cancel</LinkButton>
        </div>
      </div>
    </div>
  );
}
