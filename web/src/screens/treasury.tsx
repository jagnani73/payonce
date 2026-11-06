import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 8. Routes: #treasury/cash, #treasury/reconciliation, #treasury/outages, #outage/N.
export function Treasury(props: ScreenProps): JSX.Element {
  useTitle("Treasury");
  return (
    <NotBuilt title="Treasury">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
