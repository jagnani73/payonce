import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 7. Routes: #suppliers, #supplier/K (route.word says which).
export function Suppliers(props: ScreenProps): JSX.Element {
  useTitle("Suppliers");
  return (
    <NotBuilt title="Suppliers">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
