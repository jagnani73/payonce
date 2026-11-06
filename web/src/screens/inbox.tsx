import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 5. Data: GET /api/inbox (InboxListView), GET /api/inbox/N (InboxItemView).
export function Inbox(props: ScreenProps): JSX.Element {
  useTitle("Inbox");
  return (
    <NotBuilt title="Inbox">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
