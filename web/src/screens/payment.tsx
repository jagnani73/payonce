import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Card, Tabs, type TabItem } from "../components/Layout";
import { Empty, LoadError, Loading } from "../components/States";
import { Timeline } from "../components/Timeline";
import { useTitle } from "../hooks";
import { notify } from "../notices";
import { FAST_MS, SLOW_MS, usePoll, type Polled } from "../poll";
import { navigate, paymentHref, type ScreenProps } from "../router";
import type { Acted, DraftView, IncidentView } from "../types";
import { AuditTab } from "./payment/audit";
import { Decision, isKind } from "./payment/decision";
import { EmailsTab } from "./payment/emails";
import { Header } from "./payment/header";
import { MessagesTab } from "./payment/messages";
import type { Acts } from "./payment/parts";
import { Rail } from "./payment/rail";
import { Summary } from "./payment/summary";
import { TransfersTab } from "./payment/transfers";
import "./payment.css";

// The payment page (ia.md section 3), the most important screen: one payment's
// state, what happened, the Decision panel where a person acts, the record in
// tabs, and the supplier, money and related payments beside it. Data: GET
// /api/incidents/:id (IncidentView), every 1.5 s while PayOnce is working on it
// or a transfer is with the bank, else every 5 s. Route: #incident/ID[/tab][?do=…].

type Tab = "timeline" | "transfers" | "emails" | "messages" | "audit";

const TABS: readonly Tab[] = ["timeline", "transfers", "emails", "messages", "audit"];

function tabOf(segment: string | undefined): Tab {
  return (TABS as readonly string[]).includes(segment ?? "") ? (segment as Tab) : "timeline";
}

function pace(view: IncidentView | null): number {
  return view !== null && (view.activity.busy || view.activity.watching) ? FAST_MS : SLOW_MS;
}

function openDrafts(view: IncidentView): number {
  return view.messages.drafts.filter((draft: DraftView): boolean => draft.state === "draft" || draft.state === "copied").length;
}

function NotFound(props: { invoiceId: string }): JSX.Element {
  return (
    <Empty title={`PayOnce has no payment ${props.invoiceId}.`}>
      <p class="muted">Check the invoice number, or search for it in the top bar.</p>
      <a href="#incidents">Open Incidents</a>
    </Empty>
  );
}

function Record(props: { view: IncidentView; tab: Tab; acts: Acts; openDraft: number | null }): JSX.Element {
  const v: IncidentView = props.view;
  const id: string = v.payment.invoiceId;
  const tabs: TabItem[] = [
    { key: "timeline", label: "Timeline", href: paymentHref(id, "timeline") },
    { key: "transfers", label: "Transfers", count: v.transfers.length, href: paymentHref(id, "transfers") },
    { key: "emails", label: "Emails", count: v.emails.count, href: paymentHref(id, "emails") },
    { key: "messages", label: "Messages", count: openDrafts(v), href: paymentHref(id, "messages") },
    { key: "audit", label: "Audit", href: paymentHref(id, "audit") },
  ];
  return (
    <Card flush class="pay-record">
      <Tabs label="Payment record" tabs={tabs} current={props.tab} />
      <div class="pay-record__panel">
        {props.tab === "timeline" ? <Timeline timeline={v.timeline} /> : null}
        {props.tab === "transfers" ? <TransfersTab view={v} /> : null}
        {props.tab === "emails" ? <EmailsTab view={v} /> : null}
        {props.tab === "messages" ? <MessagesTab view={v} acts={props.acts} openDraft={props.openDraft} onDrafted={props.acts.openDraft} /> : null}
        {props.tab === "audit" ? <AuditTab view={v} /> : null}
      </div>
    </Card>
  );
}

export function Payment(props: ScreenProps): JSX.Element {
  const invoiceId: string = props.route.segments[0] ?? "";
  useTitle(invoiceId === "" ? "Payment" : `Payment ${invoiceId}`);
  const path: string = `/api/incidents/${encodeURIComponent(invoiceId)}`;
  const v: Polled<IncidentView> = usePoll<IncidentView>(invoiceId === "" ? null : path, pace);
  const tab: Tab = tabOf(props.route.segments[1]);
  const want: string | null = props.route.params.get("do");
  const [openDraft, setOpenDraft] = useState<number | null>(null);

  // A link that names an option ("Review and approve") brings the panel into view.
  const shownDecision = useRef<boolean>(false);
  useEffect((): void => {
    if (v.data !== null && want !== null && !shownDecision.current) {
      shownDecision.current = true;
      document.getElementById("decision")?.scrollIntoView({ block: "start" });
    }
  }, [v.data !== null, want]);

  const acts: Acts = {
    invoiceId,
    path,
    done: (acted: Acted<IncidentView>): void => {
      v.replace(acted.view);
      notify(acted.notice);
    },
    refresh: v.refresh,
    openDraft: (draftId: number): void => {
      setOpenDraft(draftId);
      navigate(paymentHref(invoiceId, "messages"));
    },
  };

  const missing: boolean = invoiceId === "" || v.error?.status === 404;
  return (
    <div class="screen pay">
      <nav class="pay-crumbs" aria-label="Breadcrumb">
        <a href="#incidents">Incidents</a>
        <span aria-hidden="true">{" › "}</span>
        <span class="mono">{invoiceId}</span>
      </nav>
      {missing ? null : <LoadError what="this payment" error={v.error} />}
      {missing ? (
        <NotFound invoiceId={invoiceId} />
      ) : v.data === null ? (
        v.error === null ? (
          <Loading rows={4} label="Loading the payment" />
        ) : null
      ) : (
        <div class="pay-grid">
          <div class="pay-main">
            <Header view={v.data} acts={acts} />
            <Summary view={v.data} acts={acts} />
            <Decision view={v.data} acts={acts} want={isKind(want) ? want : null} />
            <Record view={v.data} tab={tab} acts={acts} openDraft={openDraft} />
          </div>
          <Rail view={v.data} />
        </div>
      )}
    </div>
  );
}
