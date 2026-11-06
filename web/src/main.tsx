// The shared stylesheet comes first, so a screen's own stylesheet, imported by
// its module, follows it in app.css and can build on it.
import "./styles.css";
import { render } from "preact";
import { App } from "./app";

const root: HTMLElement | null = document.getElementById("app");
if (root !== null) {
  render(<App />, root);
}
