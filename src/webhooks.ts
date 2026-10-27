import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export const WEBHOOK_PATH: string = "/airwallex/webhooks";

const HOST: string = "127.0.0.1";
const MAX_BODY_BYTES: number = 256 * 1024;
// A signed event older or newer than this is refused, so a captured one cannot be
// played back later.
const MAX_CLOCK_SKEW_MS: number = 5 * 60_000;

// The fields PayOnce reads. data is the transfer, as Get transfer returns it.
export interface WebhookEvent {
  id: string;
  name: string;
  data: {
    id?: string;
    request_id?: string;
    short_reference_id?: string;
    status?: string;
  };
}

// Airwallex signs the timestamp header followed by the raw body with HMAC-SHA256,
// keyed with the subscription's secret.
export function verifySignature(
  secret: string,
  timestamp: string,
  body: Buffer,
  signature: string,
  now: number = Date.now(),
): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS) {
    return false;
  }
  const expected: Buffer = createHmac("sha256", secret)
    .update(timestamp)
    .update(body)
    .digest();
  const given: Buffer = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The transfer examples carry the transfer in data, while Airwallex's general
// event format nests the resource under data.object. Both are accepted.
function toEvent(body: Buffer): WebhookEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) {
    return undefined;
  }
  const id: unknown = parsed["id"];
  const name: unknown = parsed["name"];
  const data: unknown = parsed["data"];
  if (typeof id !== "string" || typeof name !== "string" || !isObject(data)) {
    return undefined;
  }
  const object: unknown = data["object"];
  return { id, name, data: (isObject(object) ? object : data) as WebhookEvent["data"] };
}

function answer(response: ServerResponse, status: number, text: string): void {
  if (status !== 200) {
    console.warn(`  webhook  answered ${status} ${text}`);
  }
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

// Receives Airwallex webhooks on its own port. It answers one path and nothing
// else, so the tunnel that makes it public exposes no other part of PayOnce. An
// event is passed on only once its signature checks out.
export class WebhookReceiver {
  private readonly server: Server;
  private readonly onEvent: (event: WebhookEvent) => void;
  private secret: string | null = null;

  constructor(onEvent: (event: WebhookEvent) => void) {
    this.onEvent = onEvent;
    this.server = createServer(
      (request: IncomingMessage, response: ServerResponse): void => {
        this.handle(request, response).catch((error: unknown): void => {
          console.error(error);
          if (!response.headersSent) {
            answer(response, 500, "Could not take the event");
          }
        });
      },
    );
  }

  setSecret(secret: string): void {
    this.secret = secret;
  }

  listen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, HOST, (): void => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname: string = new URL(request.url ?? "/", `http://${HOST}`).pathname;
    if (request.method !== "POST" || pathname !== WEBHOOK_PATH) {
      answer(response, 404, "Not found");
      return;
    }
    // Without the secret nothing can be checked. Airwallex retries a failed
    // delivery, so the event is not lost.
    if (this.secret === null) {
      answer(response, 503, "Not ready");
      return;
    }

    const chunks: Buffer[] = [];
    let size: number = 0;
    for await (const chunk of request) {
      const buffer: Buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        answer(response, 413, "Too large");
        return;
      }
      chunks.push(buffer);
    }
    const body: Buffer = Buffer.concat(chunks);
    const timestamp: string = String(request.headers["x-timestamp"] ?? "");
    const signature: string = String(request.headers["x-signature"] ?? "");
    if (!verifySignature(this.secret, timestamp, body, signature)) {
      answer(response, 401, "Bad or old signature");
      return;
    }
    const event: WebhookEvent | undefined = toEvent(body);
    if (event === undefined) {
      answer(response, 400, "Not an event");
      return;
    }
    this.onEvent(event);
    answer(response, 200, "OK");
  }
}
