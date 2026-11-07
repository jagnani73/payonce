import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { Icon } from "../components/Icon";
import { Theirs, Time } from "../components/Text";
import { useDismiss } from "../hooks";
import type { Polled } from "../poll";
import { useSettings } from "../settings";
import { count } from "../text";
import type { OutageStrip, SettingsView, StatusView } from "../types";

// The status pill in the top bar and its popover, from GET /api/status (polled
// by the shell every 10 s). Whether webhooks are on comes from the settings,
// read once.

type ChipTone = StatusView["chip"]["tone"];

// "Checking payments with the bank every 3 s (webhooks off)", then how often
// Airwallex's transfers are listed.
function PaymentChecks(props: { pace: StatusView["pace"]; settings: SettingsView | null }): JSX.Element {
  if (props.pace === null) {
    return <>Only pnpm ui checks payments.</>;
  }
  const webhooks: boolean | undefined = props.settings?.airwallex?.webhooks.on;
  return (
    <>
      {`Checking payments with the bank every ${props.pace.checksEverySeconds} s`}
      {webhooks === undefined ? null : webhooks ? " · webhooks on" : " (webhooks off)"}
      <span class="status-pop__line">{`Listing Airwallex's transfers every ${props.pace.listingEverySeconds} s`}</span>
    </>
  );
}

function StatusList(props: { status: StatusView; settings: SettingsView | null }): JSX.Element {
  const status: StatusView = props.status;
  return (
    <dl class="status-pop__list">
      <dt>Airwallex</dt>
      <dd>
        {status.airwallex.text}
        {status.airwallex.lastOkAt === null ? null : (
          <>
            {" · last good read "}
            <Time at={status.airwallex.lastOkAt} />
          </>
        )}
        {status.airwallex.detail === null ? null : (
          <details class="details details--inline">
            <summary>Technical details</summary>
            <Theirs text={status.airwallex.detail} block />
          </details>
        )}
      </dd>
      <dt>Payment checks</dt>
      <dd>
        <PaymentChecks pace={status.pace} settings={props.settings} />
      </dd>
      <dt>Outages</dt>
      <dd class={status.outages.length > 0 ? "status-pop__warn" : undefined}>
        {status.outages.length === 0
          ? "None active"
          : status.outages.map(
              (outage: OutageStrip): JSX.Element => (
                <span class="status-pop__line" key={outage.id}>
                  {`Outage ${outage.id} on ${outage.rail} · pausing ${count(outage.pausing, "payment")}`}
                </span>
              ),
            )}
      </dd>
      <dt>Alerts</dt>
      <dd>
        {status.alerts.text}
        {status.alerts.lastSentAt === null ? null : (
          <>
            {" · last sent "}
            <Time at={status.alerts.lastSentAt} />
          </>
        )}
      </dd>
      <dt>Audit trail</dt>
      <dd class={status.audit.intact ? undefined : "status-pop__danger"}>
        {status.audit.intact ? "Intact" : "Broken"}
        {status.audit.checkedAt === null ? null : (
          <>
            {" · checked "}
            <Time at={status.audit.checkedAt} />
          </>
        )}
      </dd>
      <dt>Reconciliation</dt>
      <dd>
        {status.recon.lastCheckAt === null ? (
          "Not run yet"
        ) : (
          <>
            {"Last check "}
            <Time at={status.recon.lastCheckAt} />
          </>
        )}
        {status.recon.needsPerson === 0
          ? null
          : ` · ${status.recon.needsPerson === 1 ? "1 break needs" : `${status.recon.needsPerson} breaks need`} a person`}
      </dd>
      <dt>Email reader</dt>
      <dd>{status.reader}</dd>
    </dl>
  );
}

export function StatusChip(props: { status: Polled<StatusView>; compact?: boolean }): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const settings: SettingsView | null = useSettings();
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open, (): void => setOpen(false), pop, button);

  const status: StatusView | null = props.status.data;
  const lost: boolean = props.status.error !== null;
  const tone: ChipTone = lost ? "danger" : (status?.chip.tone ?? "starting");
  const label: string = lost ? "PayOnce isn't answering" : (status?.chip.label ?? "Starting");
  return (
    <div class={props.compact === true ? "popover-anchor status status--compact" : "popover-anchor status"}>
      <button
        ref={button}
        type="button"
        class={`status-chip status-chip--${tone}${props.compact === true ? " status-chip--compact" : ""}`}
        aria-expanded={open}
        aria-controls="status-pop"
        title={label}
        onClick={(): void => setOpen(!open)}
      >
        <Icon name={tone === "ok" ? "check" : tone === "warning" ? "pause" : tone === "danger" ? "warning" : "circle"} size={14} />
        <span class="status-chip__label">{label}</span>
      </button>
      {open ? (
        <div ref={pop} id="status-pop" class="popover popover--wide" role="dialog" aria-label="PayOnce status">
          {status === null ? (
            <p class="muted">{props.status.error?.message ?? "Reading PayOnce's status…"}</p>
          ) : (
            <StatusList status={status} settings={settings} />
          )}
          <div class="popover__links">
            <a href="#settings" onClick={(): void => setOpen(false)}>
              Settings
            </a>
            <a href="#reports/audit" onClick={(): void => setOpen(false)}>
              Reports › Audit
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
