import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 2. Data: GET /api/incidents (IncidentsView).
export function Incidents(props: ScreenProps): JSX.Element {
  useTitle("Incidents");
  return (
    <NotBuilt title="Incidents">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
