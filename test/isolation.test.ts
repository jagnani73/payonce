import { OFFLINE_HOST, refused } from "./harness/guard.js";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { describe, test } from "node:test";
import { AirwallexClient } from "../src/airwallex/client.js";
import { loadSettings } from "../src/settings.js";
import { SETTINGS } from "./harness/world.js";

// What keeps the journeys away from the real sandbox and from a real .env, on a
// machine that has both. docs/design/tests.md says how.

describe("The journeys never reach Airwallex or read .env", () => {
  test("a journey's settings come from an explicit list, and name only the offline host", () => {
    assert.equal(loadSettings(SETTINGS).airwallex.client().host, OFFLINE_HOST);
    assert.deepEqual(
      Object.keys(process.env).filter((name: string): boolean => /^(AWX_|CLAUDE_|READER_|ALERT_|WEBHOOK)/.test(name)),
      [],
    );
  });

  test("PayOnce's own client refuses any host but the sandbox and the offline one", () => {
    assert.throws(() => new AirwallexClient("https://api.airwallex.com", "id", "key"));
    assert.equal(new AirwallexClient("https://api-demo.airwallex.com", "id", "key").host, "api-demo.airwallex.com");
  });

  test("a call or connection to anything but the fake Airwallex is refused", async () => {
    await assert.rejects(fetch("https://api-demo.airwallex.com/api/v1/authentication/login", { method: "POST" }));
    assert.throws(() => connect({ host: "api-demo.airwallex.com", port: 443 }));
    assert.deepEqual(refused.splice(0), ["POST https://api-demo.airwallex.com", "a network connection"]);
  });

  test(".env cannot be loaded, and relative paths name nothing in the repository", () => {
    assert.throws(() => process.loadEnvFile(".env"));
    const fromRepository: string = relative(join(import.meta.dirname, ".."), process.cwd());
    assert.ok(fromRepository.startsWith("..") || isAbsolute(fromRepository));
  });
});
