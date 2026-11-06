// Build the widget into one small IIFE (dist/widget.js) plus the demo page.
//
//   pnpm --filter @ghilino/widget build          → apps/widget/dist/{widget.js,index.html}
//   pnpm --filter @ghilino/widget dev            → http://localhost:5173 (demo, rebuilds on change)
//
// The demo's data-api defaults to http://localhost:8787 (pnpm dev:api); override with WIDGET_API.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const serve = process.argv.includes("--serve");
const api = process.env.WIDGET_API ?? "http://localhost:8787";

mkdirSync(dist, { recursive: true });
const demo = readFileSync(join(root, "demo/index.html"), "utf8").replaceAll("__WIDGET_API__", api);
writeFileSync(join(dist, "index.html"), demo);

const ctx = await context({
  entryPoints: [join(root, "src/main.ts")],
  outfile: join(dist, "widget.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020", "chrome90", "firefox90", "safari15"],
  minify: !serve,
  sourcemap: serve ? "inline" : false,
  legalComments: "none",
  banner: { js: "/* Dr. Ghilino assistant widget. Source: apps/widget. */" },
  metafile: true,
});

if (serve) {
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, port: 5173 });
  console.log(`widget demo on http://localhost:${port} (API ${api})`);
} else {
  const result = await ctx.rebuild();
  await ctx.dispose();
  const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
  console.log(`apps/widget/dist/widget.js: ${(bytes / 1024).toFixed(1)} KiB`);
}
