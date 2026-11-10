import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What a journey must never do, refused for the whole test process before any
// PayOnce code runs: load .env, read a credential from the environment, reach a
// host other than the fake Airwallex, or write in the repository. Each test file
// runs in a process of its own, so every file gets these from its first import.

// The only host a journey's Airwallex calls may go to. PayOnce's client accepts
// it as its offline host, and the fake answers it inside this process.
export const OFFLINE_HOST: string = "sandbox.invalid";

// Every call or connection a journey tried outside the fake, refused. A journey
// fails when it ends with any here (World.dispose).
export const refused: string[] = [];

// The prefixes of every variable that could carry a real credential, a real
// address or another ledger into this process. The journeys build their settings
// from an explicit list and never read these, and they are removed so nothing
// else in the process can.
const OUTSIDE_PREFIXES: readonly string[] = ["AWX_", "CLAUDE_", "READER_", "ALERT_", "WEBHOOK", "PAYONCE_LEDGER"];

for (const name of Object.keys(process.env)) {
  if (OUTSIDE_PREFIXES.some((prefix: string): boolean => name.startsWith(prefix))) {
    delete process.env[name];
  }
}

process.loadEnvFile = (): void => {
  throw new Error("A journey never loads .env: its settings come from an explicit list");
};

type Answer = (request: Request) => Promise<Response>;
let airwallex: Answer | null = null;

// The fake Airwallex the next calls to OFFLINE_HOST go to, or null for none.
export function answerAirwallexWith(answer: Answer | null): void {
  airwallex = answer;
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request: Request = new Request(input, init);
  const url: URL = new URL(request.url);
  if (url.protocol !== "https:" || url.hostname !== OFFLINE_HOST || airwallex === null) {
    refused.push(`${request.method} ${url.origin}`);
    throw new TypeError(`A journey reaches no network, so the call to ${url.origin} was refused`);
  }
  return airwallex(request);
};

// fetch is not the only way out: every TCP connection is refused too. A local
// pipe (a path, as tsx uses to talk to its own CLI) cannot leave the machine.
const connect: Socket["connect"] = Socket.prototype.connect;
Socket.prototype.connect = function connectLocalOnly(this: Socket, ...args: unknown[]): Socket {
  const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
  const local: boolean =
    (typeof first === "string" && !/^[0-9]+$/.test(first)) ||
    (typeof first === "object" && first !== null && "path" in first && typeof first.path === "string");
  if (!local) {
    refused.push("a network connection");
    throw new Error("A journey opens no network connection");
  }
  return Reflect.apply(connect, this, args) as Socket;
} as Socket["connect"];

// What PayOnce prints as it works is left out, so the report shows only the
// tests. JOURNEY_LOG=1 lets it through.
if (process.env["JOURNEY_LOG"] !== "1") {
  for (const method of ["log", "info", "warn", "error"] as const) {
    console[method] = (): void => undefined;
  }
}

// The process works in a fresh folder outside the repository, so a relative
// path such as payonce.db or .env can only name something in it. Removed when the
// process exits. A folder left behind, as when Windows still holds a file in it,
// is only litter in the temporary folder, so that is not an error.
const root: string = mkdtempSync(join(tmpdir(), "payonce-journeys-"));
process.chdir(root);
process.on("exit", (): void => {
  process.chdir(tmpdir());
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Left for the system to clear.
  }
});

// A new folder for one journey's ledger.
export function journeyFolder(): string {
  return mkdtempSync(join(root, "journey-"));
}
