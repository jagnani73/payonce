import { readFileSync } from "node:fs";

const BOX: URL = new URL("../../deploy/box/", import.meta.url);
const END: string = "PAYONCE_BOX_FILE";

interface BoxFile {
  name: string;
  path: string;
  mode: string;
}

// Each file in deploy/box, where the first boot writes it, and its mode.
const FILES: readonly BoxFile[] = [
  { name: "payonce.service", path: "/etc/systemd/system/payonce.service", mode: "0644" },
  { name: "payonce-env.service", path: "/etc/systemd/system/payonce-env.service", mode: "0644" },
  { name: "payonce-imds.service", path: "/etc/systemd/system/payonce-imds.service", mode: "0644" },
  { name: "imds-block.nft", path: "/etc/payonce/imds-block.nft", mode: "0644" },
  { name: "payonce-morning.service", path: "/etc/systemd/system/payonce-morning.service", mode: "0644" },
  { name: "payonce-morning.timer", path: "/etc/systemd/system/payonce-morning.timer", mode: "0644" },
  { name: "payonce-env", path: "/usr/local/lib/payonce/payonce-env", mode: "0755" },
  { name: "payonce-sandbox.sh", path: "/usr/local/lib/payonce/sandbox.sh", mode: "0644" },
  { name: "payonce-deploy", path: "/usr/local/sbin/payonce-deploy", mode: "0755" },
  { name: "payonce-morning", path: "/usr/local/sbin/payonce-morning", mode: "0755" },
  { name: "nginx-payonce.conf", path: "/etc/nginx/sites-available/payonce", mode: "0644" },
  { name: "journald.conf", path: "/etc/systemd/journald.conf.d/payonce.conf", mode: "0644" },
];

// A file as the instance gets it: without its full-line comments, which the
// files in deploy/box keep, because EC2 takes at most 16 KB of user data. A
// shebang stays. None of these files has a heredoc or a multi-line string whose
// lines start with #.
function box(name: string): string {
  const lines: string[] = readFileSync(new URL(name, BOX), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line: string): boolean => !/^\s*#(?!!)/.test(line));
  if (lines.includes(END)) {
    throw new Error(`deploy/box/${name} has a line ${END}, which ends the heredoc that writes it`);
  }
  const text: string = lines.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

// The instance's user data: stack.env (stackEnv may hold CloudFormation tokens),
// every file in FILES, then deploy/box/bootstrap.sh. A change to any of them
// gives the launch template a new version, which replaces the instance.
export function userDataText(stackEnv: string): string {
  const parts: string[] = [
    "#!/bin/bash",
    "set -euo pipefail",
    'put() { mkdir -p "$(dirname "$1")"; cat >"$1"; chmod "$2" "$1"; }',
    `put /etc/payonce/stack.env 0644 <<'${END}'\n${stackEnv}${END}`,
    ...FILES.map((file: BoxFile): string => `put ${file.path} ${file.mode} <<'${END}'\n${box(file.name)}${END}`),
    box("bootstrap.sh"),
  ];
  return parts.join("\n");
}
