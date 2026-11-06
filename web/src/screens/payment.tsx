import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 3. Data: GET /api/incidents/:id (IncidentView). Route: #incident/ID[/tab][?do=…].
export function Payment(props: ScreenProps): JSX.Element {
  useTitle("Payment");
  return (
    <NotBuilt title="Payment">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
