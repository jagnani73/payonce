import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 10. Data: GET /api/settings (SettingsView).
export function Settings(props: ScreenProps): JSX.Element {
  useTitle("Settings");
  return (
    <NotBuilt title="Settings">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
