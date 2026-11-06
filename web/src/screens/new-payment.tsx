import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 4. Data: GET /api/beneficiaries, POST /api/payments/check, POST /api/payments.
export function NewPayment(props: ScreenProps): JSX.Element {
  useTitle("New payment");
  return (
    <NotBuilt title="New payment">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
