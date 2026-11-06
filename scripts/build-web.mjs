import { build, context } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, sep } from "node:path";

// Builds the page: web/src/main.tsx and every stylesheet it imports into
// web/dist/app.js and web/dist/app.css, plus the files copied as they are.
// pnpm build:web builds once; pnpm build:web --watch builds again on every save.
// The server serves web/dist/ and nothing else.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = fileURLToPath(new URL("../web/src/", import.meta.url));
const DIST = fileURLToPath(new URL("../web/dist/", import.meta.url));
const COPIED = ["index.html", "favicon.svg"];
const watching = process.argv.includes("--watch");

// The page only renders the server's views. It may import types from src/, which
// esbuild never loads, but no code: a file outside web/src/ and node_modules/
// stops the build.
const pageOnly = {
  name: "page-only",
  setup(builder) {
    builder.onLoad({ filter: /.*/ }, (args) => {
      const path = relative(ROOT, args.path);
      if (path.startsWith(`web${sep}src${sep}`) || path.split(sep).includes("node_modules")) {
        return undefined;
      }
      return { errors: [{ text: `The page may import only types from src/views/contract.ts, and it loads ${path}` }] };
    });
  },
};

const copyFiles = {
  name: "copy-files",
  setup(builder) {
    builder.onEnd((result) => {
      if (result.errors.length === 0) {
        for (const name of COPIED) {
          copyFileSync(`${SRC}${name}`, `${DIST}${name}`);
        }
      }
    });
  },
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const options = {
  entryPoints: { app: `${SRC}main.tsx` },
  outdir: DIST,
  bundle: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: !watching,
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "warning",
  plugins: [pageOnly, copyFiles],
};

if (watching) {
  const builder = await context(options);
  await builder.watch();
  console.log("Building web/dist/ on every change. Stop with Ctrl+C");
} else {
  // esbuild has already printed what went wrong.
  await build(options).catch(() => process.exit(1));
}
