import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 9. Data: GET /api/reports?period=, GET /api/audit.
export function Reports(props: ScreenProps): JSX.Element {
  useTitle("Reports");
  return (
    <NotBuilt title="Reports">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
