import type { JSX } from "preact";
import { Icon } from "../components/Icon";
import type { StatusView } from "../types";

// The global banners under the top bar (ia.md section 0.1), from GET
// /api/status: a broken audit trail, Airwallex unreachable, an active outage,
// alerts stopped. The server lists them most severe first.

type Banner = StatusView["banners"][number];

const LINKS: Record<Banner["code"], string> = {
  audit: "Check the audit trail",
  airwallex: "Open Airwallex settings",
  outage: "Open outages",
  alerts: "Open alert settings",
};

// "Outage 3 on USD local: PayOnce opens…" leads with its subject in bold.
function Text(props: { text: string }): JSX.Element {
  const colon: number = props.text.indexOf(": ");
  if (colon <= 0 || colon > 60) {
    return <>{props.text}</>;
  }
  return (
    <>
      <strong>{props.text.slice(0, colon + 1)}</strong>
      {props.text.slice(colon + 1)}
    </>
  );
}

export function Banners(props: { status: StatusView | null }): JSX.Element | null {
  const banners: Banner[] = props.status?.banners ?? [];
  if (banners.length === 0) {
    return null;
  }
  return (
    <div class="banners" role="status">
      {banners.map(
        (banner: Banner): JSX.Element => (
          <div class={`banner banner--${banner.tone}`} key={banner.code}>
            <div class="banner__inner">
              <Icon name="warning" size={18} />
              <span class="banner__text">
                <Text text={banner.text} />
              </span>
              <a class="banner__link" href={banner.href}>
                {LINKS[banner.code]}
              </a>
            </div>
          </div>
        ),
      )}
    </div>
  );
}
