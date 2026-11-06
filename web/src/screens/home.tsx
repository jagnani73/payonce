import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 1. Data: GET /api/home?me=NAME (HomeView).
export function Home(props: ScreenProps): JSX.Element {
  useTitle("Needs you");
  return (
    <NotBuilt title="Needs you">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
