import { spawn, type ChildProcess } from "node:child_process";

const ADDRESS_PATTERN: RegExp = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const START_TIMEOUT_MS: number = 30_000;
const KEPT_OUTPUT_CHARS: number = 4_096;

export interface Tunnel {
  url: string;
  stop(): void;
}

// Opens a Cloudflare quick tunnel to a local port and resolves with its public
// address. A quick tunnel needs no Cloudflare account and gets a new address each
// time it starts. onExit is called if cloudflared stops after the tunnel is up.
export function openTunnel(
  command: string,
  port: number,
  onExit: (code: number | null) => void,
): Promise<Tunnel> {
  return new Promise<Tunnel>((resolve, reject) => {
    const child: ChildProcess = spawn(
      command,
      ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let output: string = "";
    let open: boolean = false;
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      child.kill();
      reject(new Error("cloudflared gave no tunnel address within 30 seconds"));
    }, START_TIMEOUT_MS);

    // Read after the tunnel is up as well, so cloudflared never blocks on a full
    // pipe.
    const read = (chunk: Buffer): void => {
      if (open) {
        return;
      }
      output = (output + chunk.toString("utf8")).slice(-KEPT_OUTPUT_CHARS);
      const match: RegExpExecArray | null = ADDRESS_PATTERN.exec(output);
      if (match !== null) {
        open = true;
        clearTimeout(timer);
        resolve({ url: match[0], stop: (): void => void child.kill() });
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (error: Error): void => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code: number | null): void => {
      clearTimeout(timer);
      if (open) {
        onExit(code);
      } else {
        reject(new Error(`cloudflared stopped before the tunnel was up (exit ${code})`));
      }
    });
  });
}
