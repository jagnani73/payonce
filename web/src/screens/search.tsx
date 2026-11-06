import type { JSX } from "preact";
import { NotBuilt } from "../components/States";
import { useTitle } from "../hooks";
import type { ScreenProps } from "../router";

// ia.md section 12. Data: GET /api/search?q= (SearchView).
export function SearchResults(props: ScreenProps): JSX.Element {
  useTitle("Search results");
  return (
    <NotBuilt title="Search results">
      <p class="muted mono">{props.route.hash}</p>
    </NotBuilt>
  );
}
