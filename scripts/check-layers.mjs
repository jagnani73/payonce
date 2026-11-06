// Fails when an import in src/ reaches the wrong way between layers. A build-time
// check, run as pnpm check:layers. docs/architecture.md describes the layers.
//
// domain/ imports nothing of ours. text/ and the email parser in intake/ import
// domain/ and each other. The store and the Airwallex client import those. The
// engine and the subsystems beside it (runs, outages, recon, intake, reader,
// outbox, alerts, explain) import the store and below, and each other one way
// only. The views import everything below them but the engine. The surfaces and
// the settings import anything. A type-only import may also name the shape of a
// row, an Airwallex payload, a subsystem's record or the settings from any
// layer, but never reaches into the engine, the views or a surface.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = resolve(import.meta.dirname, "..", "src");

// Lower ranks are imported by higher ones, never the other way. Layers of one
// rank may import each other, but their runtime imports must not make a cycle.
// parser is the email parser's files, and root the settings and the .env loader.
const RANK = {
  domain: 0,
  text: 1,
  parser: 1,
  store: 2,
  airwallex: 2,
  engine: 3,
  runs: 3,
  outages: 3,
  recon: 3,
  intake: 3,
  reader: 3,
  outbox: 3,
  alerts: 3,
  explain: 3,
  views: 4,
  surfaces: 5,
  root: 5,
};

// The layers whose types any layer may name.
const SHAPES = new Set(["store", "airwallex", "runs", "outages", "recon", "intake", "reader", "outbox", "alerts", "explain", "root"]);

// Imports that break the rule on purpose, by file, each with its reason. An entry
// that no longer matches an import fails the check too, so the list stays true.
const ALLOWED = [
  {
    from: ["views/payment-check.ts"],
    to: "engine/first-payment.ts",
    why: "The New payment preview runs startPayment's own outage gate and holds, on facts read without a lease, so it says what the start would do",
  },
  {
    from: ["views/payment-check.ts"],
    to: "engine/new-payment.ts",
    why: "The preview checks the payee and builds the invoice with the start's own code, for the same reason",
  },
  {
    from: ["domain/situation.ts"],
    to: "text/printable.ts",
    why: "capitalise. situation.ts belongs to the views work, and capitalise moves into domain/ with that work",
  },
];

const PARSER = new Set(["intake/eml.ts", "intake/html-text.ts", "intake/css-text.ts", "intake/parse-worker.ts"]);

function layerOf(file) {
  const parts = relative(SRC, file).split(sep);
  if (PARSER.has(parts.join("/"))) {
    return "parser";
  }
  return parts.length === 1 ? "root" : parts[0];
}

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : path.endsWith(".ts") ? [path] : [];
  });
}

const STATIC = /^(import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+["']([^"']+)["']/gm;
const BARE = /^import\s+["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

// Every import of another of our files: where it points and whether it is erased
// when compiled, as `import type` and imports whose every name is a type are.
function importsOf(file) {
  const text = readFileSync(file, "utf8");
  const found = [];
  const add = (spec, typeOnly) => {
    if (spec.startsWith(".")) {
      found.push({ target: resolve(dirname(file), spec.replace(/\.js$/, ".ts")), typeOnly });
    }
  };
  for (const match of text.matchAll(STATIC)) {
    const names = match[3].trim();
    const inline =
      names.startsWith("{") &&
      names
        .slice(1, -1)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
        .every((name) => name.startsWith("type "));
    add(match[4], match[2] !== undefined || inline);
  }
  for (const match of text.matchAll(BARE)) {
    add(match[1], false);
  }
  for (const match of text.matchAll(DYNAMIC)) {
    add(match[1], false);
  }
  return found;
}

function problemOf(from, to, typeOnly) {
  if (from === to) {
    return null;
  }
  if (from === "views" && to === "engine") {
    return "views never import the engine";
  }
  if (RANK[to] > RANK[from] && !(typeOnly && SHAPES.has(to))) {
    return `${from} imports ${to}, which sits above it`;
  }
  return null;
}

function name(file) {
  return relative(SRC, file).split(sep).join("/");
}

const problems = [];
const used = new Set();
const sideways = new Map();
for (const file of filesIn(SRC)) {
  const from = layerOf(file);
  for (const { target, typeOnly } of importsOf(file)) {
    const to = layerOf(target);
    const key = `${name(file)} -> ${name(target)}`;
    if (!(from in RANK) || !(to in RANK)) {
      problems.push(`${key}: ${from in RANK ? to : from} is not a layer this check knows. Give it a rank`);
      continue;
    }
    const problem = problemOf(from, to, typeOnly);
    if (ALLOWED.some((entry) => entry.from.includes(name(file)) && entry.to === name(target))) {
      used.add(key);
      if (problem === null) {
        problems.push(`${key}: allowed, but it follows the layers now. Take it off the list`);
      }
      continue;
    }
    if (problem !== null) {
      problems.push(`${name(file)} -> ${name(target)}${typeOnly ? " (type)" : ""}: ${problem}`);
    } else if (!typeOnly && from !== to && RANK[from] === RANK[to]) {
      const edges = sideways.get(from) ?? new Map();
      edges.set(to, [...(edges.get(to) ?? []), `${name(file)} -> ${name(target)}`]);
      sideways.set(from, edges);
    }
  }
}

// A cycle among layers of one rank, found by walking each layer's sideways imports.
const reported = new Set();
function walk(start, at, path) {
  for (const [next, via] of sideways.get(at) ?? []) {
    if (next === start) {
      const cycle = [...path, next];
      const key = [...cycle.slice(0, -1)].sort().join(" ");
      if (!reported.has(key)) {
        reported.add(key);
        problems.push(`cycle ${cycle.join(" -> ")}: ${via[0]}${via.length > 1 ? ` and ${via.length - 1} more` : ""}`);
      }
    } else if (!path.includes(next)) {
      walk(start, next, [...path, next]);
    }
  }
}
for (const layer of sideways.keys()) {
  walk(layer, layer, [layer]);
}

for (const entry of ALLOWED) {
  for (const from of entry.from) {
    if (!used.has(`${from} -> ${entry.to}`)) {
      problems.push(`${from} -> ${entry.to}: allowed, but no such import is left. Take it off the list`);
    }
  }
}

if (problems.length > 0) {
  console.error(`The layer check found ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}
console.log(`Every import follows the layers, but for the ${used.size} on the allowed list.`);
