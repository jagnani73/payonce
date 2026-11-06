import { createServer, type Server } from "node:http";
import { BalanceCache, type BalanceState } from "../../airwallex/balances.js";
import { describeAirwallex, type AirwallexClient } from "../../airwallex/client.js";
import { Alerts, describeAlerts, type AlertCash, type AlertSetting } from "../../alerts/alerts.js";
import { describePolicy } from "../../domain/approvers.js";
import { describeQuotes } from "../../domain/fx.js";
import { describeFloors } from "../../domain/reserve.js";
import { cashReport, payRunLines, type CashReport } from "../../engine/cash-position.js";
import { createEngine, type EngineBuild } from "../../engine/create.js";
import { CurrencyBusyError } from "../../engine/currency-lock.js";
import { Dispatcher } from "../../engine/dispatcher.js";
import type { Engine } from "../../engine/engine.js";
import { noteError } from "../../engine/lines.js";
import { recordMissingFees } from "../../engine/payments.js";
import { SandboxBank } from "../../engine/sandbox-bank.js";
import { Watcher } from "../../engine/watcher.js";
import { loadEnvIfPresent } from "../../env-file.js";
import { explainerFor, ExplainLimiter, type Explainer } from "../../explain/explainer.js";
import { describeOutageRule } from "../../outages/outages.js";
import { describeReconSetting, ReconRunner, type ReconSetting } from "../../recon/reconcile.js";
import { releaseRun, runKey, runNoteError } from "../../runs/runs.js";
import { loadSettings, type Settings } from "../../settings.js";
import { LeaseLostError, type Ledger } from "../../store/ledger.js";
import { printableError, say, sayError } from "../../text/printable.js";
import { httpApp, type HttpApp } from "./app.js";
import { HOST, requestListener, type Route } from "./router.js";
import { cashRoutes } from "./routes/cash.js";
import { inboxRoutes } from "./routes/inbox.js";
import { incidentRoutes } from "./routes/incidents.js";
import { optionsRoutes } from "./routes/options.js";
import { outageRoutes } from "./routes/outages.js";
import { outboxRoutes } from "./routes/outbox.js";
import { reconcileRoutes } from "./routes/reconcile.js";
import { reportRoutes } from "./routes/reports.js";
import { runRoutes } from "./routes/runs.js";
import { whyRoutes } from "./routes/why.js";
import { CHECK_EVERY_MS, startUp, type StartUp } from "./start.js";

// How often Airwallex is swept for payouts PayOnce did not send.
const SWEEP_EVERY_MS: number = 30_000;
// How long the cash panel shows a balance before reading it again. The policy
// reads its own, fresh, before any money moves.
const BALANCE_MAX_AGE_MS: number = 30_000;
// How often alerts read the balances when nothing else has.
const ALERT_BALANCE_EVERY_MS: number = 5 * 60_000;

// pnpm ui: the page, the JSON API, the watcher, webhooks, alerts and the
// reconciliation timer, in one process.
function main(): void {
  // Before any setting is read. Without a .env, the client stops the server
  // with the missing setting's name.
  loadEnvIfPresent();
  const settings: Settings = loadSettings();
  const port: number = settings.server.port;

  // A credential missing from .env, or an address that is not the sandbox, stops
  // the server in PayOnce's words and with no stack trace, before anything opens.
  const built: EngineBuild = createEngine(settings);
  if (built.problem !== null) {
    say(built.problem);
    process.exit(1);
  }
  const client: AirwallexClient = built.engine.client;
  const ledger: Ledger = built.engine.ledger;
  // A pay run row's original gets the row's sandbox outcome, kept in the ledger.
  const bank: SandboxBank = new SandboxBank(
    client,
    (invoiceId: string, error: unknown): void => noteError(ledger, invoiceId, error),
    (invoiceId: string): string | null => ledger.runRowOf(invoiceId)?.sandboxOutcome ?? null,
  );
  const engine: Engine = { ...built.engine, bank };
  const agent: Dispatcher = new Dispatcher(engine);
  // Explains an incident on the reader's keys and models. Null without
  // CLAUDE_API_KEY or READER_API_KEY, and then the page's button says the model
  // reader is off.
  const explainer: Explainer | null = explainerFor(settings.models.askServices());
  const explainLimiter: ExplainLimiter = new ExplainLimiter();

  // Starts releasing an approved run in its turn and does not wait for it, because
  // the release goes on to send its rows one at a time.
  function startRelease(runId: number): void {
    agent
      .run(runKey(runId), (): Promise<void> => releaseRun(engine, agent, runId))
      .catch((error: unknown): void => {
        // Those two say already that PayOnce tries again in a minute.
        const lock: boolean = error instanceof CurrencyBusyError || error instanceof LeaseLostError;
        runNoteError(
          engine.ledger,
          runId,
          error,
          lock
            ? "The run could not be released: "
            : "The run could not be released, and PayOnce tries again in a minute: ",
        );
      });
  }

  const watcher: Watcher = new Watcher(engine, agent, CHECK_EVERY_MS, SWEEP_EVERY_MS, startRelease);
  // Reconciliation reads Airwallex on its own timer, never in an invoice's turn,
  // and takes no currency lease, because it moves no money and changes no invoice.
  const reconSetting: ReconSetting = settings.recon;
  const reconRunner: ReconRunner = new ReconRunner(client, ledger, reconSetting.everyMs);
  // After each read it fills in the fees of failed transfers the ledger has none for.
  // That writes only fee columns, so it runs outside the invoices' turns.
  const balances: BalanceCache = new BalanceCache(
    client,
    BALANCE_MAX_AGE_MS,
    async (): Promise<void> => {
      await recordMissingFees(client, ledger);
    },
  );

  // The panel's report from the cache as it is. The alerts' cash check reads it
  // strict.
  function cash(): CashReport {
    return cashReport({
      ledger: engine.ledger,
      reserve: engine.reserve,
      balances: balances.latest(),
      statesCheckedAt: watcher.lastCheckedAt,
      payRunLines: payRunLines(engine.ledger),
    });
  }

  // While alerts are on, the balances are read every 5 minutes even with no page
  // open, so a headroom below 0 is noticed. Null until a balance has been read,
  // and "reading" while none has and a read is running.
  let alertBalanceAskedAt: number = Number.NEGATIVE_INFINITY;

  function alertCash(): AlertCash {
    const now: number = Date.now();
    const state: BalanceState = balances.latest();
    if (
      now - alertBalanceAskedAt >= ALERT_BALANCE_EVERY_MS &&
      (state.readAt === null || now - state.readAt >= ALERT_BALANCE_EVERY_MS)
    ) {
      alertBalanceAskedAt = now;
      balances.refreshIfOld(now);
    }
    if (state.readAt !== null) {
      return cash();
    }
    return balances.latest().refreshing ? "reading" : null;
  }

  const alertSetting: AlertSetting = settings.alerts;
  const alerts: Alerts | null =
    alertSetting.target === null
      ? null
      : new Alerts(engine.ledger, alertSetting.target, `http://${HOST}:${port}`, alertCash);

  const app: HttpApp = httpApp({
    settings,
    engine,
    agent,
    bank,
    watcher,
    balances,
    explainer,
    explainLimiter,
    readerNames: settings.models.readerNames,
    reconRunner,
    alerts,
    alertSetting,
    startRelease,
    cash,
  });
  const routes: Route[] = [
    ...optionsRoutes(app),
    ...outageRoutes(app),
    ...cashRoutes(app),
    ...reportRoutes(app),
    ...reconcileRoutes(app),
    ...inboxRoutes(app),
    ...runRoutes(app),
    ...incidentRoutes(app),
    ...whyRoutes(app),
    ...outboxRoutes(app),
  ];
  const start: StartUp = startUp(app);
  const server: Server = createServer(requestListener(routes, port));

  // One failed step must not take the server, and every other incident, down with it.
  process.on("unhandledRejection", (reason: unknown): void => {
    sayError(`Unhandled rejection: ${printableError(reason)}`);
  });

  process.on("exit", (): void => {
    start.stopTunnel();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, (): void => {
      process.exit(0);
    });
  }

  server.listen(port, HOST, (): void => {
    say(`PayOnce is at http://${HOST}:${port} (sandbox only, no real money)`);
    say(describeAirwallex(client));
    say(`Supplier emails are read by: ${engine.reader.name}`);
    say(describePolicy(engine.approvals));
    say(describeFloors(engine.reserve));
    say(describeQuotes(settings.fxQuotes));
    say(describeOutageRule(settings.outageRule));
    say(describeAlerts(alertSetting));
    say(describeReconSetting(reconSetting));
    // The first page load then has balances to show.
    balances.refreshIfOld();
    start.pickUpInterrupted();
    watcher.start();
    alerts?.start();
    reconRunner.start();
    void start.connectWebhooks();
  });
}

main();
