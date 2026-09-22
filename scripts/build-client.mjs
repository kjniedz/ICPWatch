// Bundles the client islands and stylesheet into public/assets with content hashes,
// then writes src/asset-manifest.json so the Worker can reference immutable URLs.
import { build, context } from "esbuild";
import { readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { basename } from "node:path";

const watch = process.argv.includes("--watch");
const outdir = "public/assets";
mkdirSync(outdir, { recursive: true });

for (const f of readdirSync(outdir)) {
  if (/\.(js|css|map)$/.test(f)) rmSync(`${outdir}/${f}`);
}

const entries = { app: "client/app.ts", chart: "client/chart.ts", fund: "client/fund.ts", styles: "client/styles.css" };

const options = {
  entryPoints: entries,
  outdir,
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  format: "esm",
  target: ["es2022"],
  entryNames: watch ? "[name]" : "[name]-[hash]",
  metafile: true,
  logLevel: "info",
  loader: { ".woff2": "file" },
  external: ["/fonts/*"],
};

function writeManifest(metafile) {
  const manifest = {};
  for (const [out, info] of Object.entries(metafile.outputs)) {
    if (out.endsWith(".map")) continue;
    const file = basename(out);
    const name = Object.keys(entries).find((k) => info.entryPoint === entries[k] || file.startsWith(`${k}.`) || file.startsWith(`${k}-`));
    if (!name) continue;
    manifest[file.endsWith(".css") ? `${name}.css` : `${name}.js`] = `/assets/${file}`;
  }
  writeFileSync("src/asset-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
}

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{ name: "manifest", setup(b) { b.onEnd((r) => r.metafile && writeManifest(r.metafile)); } }],
  });
  await ctx.watch();
} else {
  const result = await build(options);
  writeManifest(result.metafile);
}
