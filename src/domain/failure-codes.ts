// The bank failure codes PayOnce knows, each with its own words and what it
// says about the payment. Any other code has no words and is none of these.
export interface FailureCode {
  words: string;
  // The failure happened on the sending side, so the beneficiary details were
  // never rejected and the same payment can be sent again.
  resendable: boolean;
  // The rail failed, not the payee's account, so it counts toward an outage.
  rail: boolean;
  // The account itself is closed or wrong, which the supplier view cautions about.
  account: boolean;
}

// The sandbox reports failure.details.type as INCORRECT_ROUTING for every
// failure, so the code is the only field worth reading. Recall and duplication
// returns are neither the rail's fault nor the account's.
export const FAILURE_CODES: Readonly<Record<string, FailureCode>> = {
  "90101": { words: "invalid account name or number", resendable: false, rail: false, account: true },
  "90701": { words: "account closed", resendable: false, rail: false, account: true },
  "90802": { words: "beneficiary bank returned", resendable: false, rail: false, account: true },
  "91001": { words: "recall requested", resendable: false, rail: false, account: false },
  "91301": { words: "duplication return", resendable: false, rail: false, account: false },
  "91401": { words: "system error", resendable: true, rail: true, account: false },
  "91402": { words: "channel timeout", resendable: true, rail: true, account: false },
  "99901": { words: "unable to apply", resendable: false, rail: true, account: false },
  "99902": { words: "other", resendable: false, rail: true, account: false },
};

const ENTRIES: [string, FailureCode][] = Object.entries(FAILURE_CODES);

// Every known code in PayOnce's words.
export const FAILURE_WORDS: Readonly<Record<string, string>> = Object.fromEntries(
  ENTRIES.map(([code, failure]: [string, FailureCode]): [string, string] => [code, failure.words]),
);

// The rail-level codes, in PayOnce's words. Account codes, unknown codes and a
// transfer with no code never count toward an outage.
export const RAIL_FAILURE_CODES: Readonly<Record<string, string>> = Object.fromEntries(
  ENTRIES.filter(([, failure]: [string, FailureCode]): boolean => failure.rail).map(
    ([code, failure]: [string, FailureCode]): [string, string] => [code, failure.words],
  ),
);

export const RESENDABLE_FAILURE_CODES: ReadonlySet<string> = codesWhere(
  (failure: FailureCode): boolean => failure.resendable,
);

export const ACCOUNT_FAILURE_CODES: ReadonlySet<string> = codesWhere((failure: FailureCode): boolean => failure.account);

function codesWhere(test: (failure: FailureCode) => boolean): ReadonlySet<string> {
  return new Set<string>(
    ENTRIES.filter(([, failure]: [string, FailureCode]): boolean => test(failure)).map(
      ([code]: [string, FailureCode]): string => code,
    ),
  );
}
