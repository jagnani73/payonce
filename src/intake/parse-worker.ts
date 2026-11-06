import { parentPort, type MessagePort } from "node:worker_threads";
import { parseEmail, type ParsedUpload, type UploadSource } from "./eml.js";

// The worker thread an upload is parsed in (parseUpload in intake.ts). It says
// it is ready, parses the one email it is sent, posts what parseEmail made of it
// and is then terminated. A parse that runs too long or takes too much memory
// costs this thread, never the server's.

interface Job {
  raw: Uint8Array;
  source: UploadSource;
}

const port: MessagePort | null = parentPort;
if (port === null) {
  throw new Error("parse-worker.ts runs only as a worker thread");
}
port.once("message", (job: Job): void => {
  const raw: Buffer = Buffer.from(job.raw.buffer, job.raw.byteOffset, job.raw.byteLength);
  const parsed: ParsedUpload = parseEmail(raw, job.source);
  port.postMessage(parsed);
});
port.postMessage("ready");
