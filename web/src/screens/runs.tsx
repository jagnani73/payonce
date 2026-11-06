import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 6. Routes: #runs, #run/N[/tab], #runs/upload (route.word says which). Data: GET /api/runs, GET /api/runs/N.
export function Runs(props: ScreenProps): JSX.Element {
  useTitle("Pay runs");
  return (
    <NotBuilt title="Pay runs">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
