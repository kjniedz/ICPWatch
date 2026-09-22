// Local test harness for the block indexer (wrangler.indexer-dev.jsonc). Not part of the app and never
// deployed. Runs against its own persisted state directory, so it cannot disturb the main dev database.
//   POST /tick?ledger=<id>[,<id>]&ms=20000     one indexTick (omit ledger to use the tokens table)
//   POST /job?ms=45000                         exactly what the cron runs (indexJob)
//   POST /reset?ledger=<id>                    wipe one ledger's index
//   GET  /reconcile?ledger=<id>                indexed sum against icrc1_total_supply
//   GET  /progress[?ledger=<id>]   /holders?ledger=<id>   /stats?ledger=<id>   /big[?ledger=<id>]
//   GET  /daily?ledger=<id>        /account?owner=<principal>
//   GET  /bench?ledger=<id>&start=0            fetch + decode timing for one 2000 block call
import { Hono } from "hono";
import type { Env } from "../env";
import { applyBlocks, newChunk } from "./core";
import { indexJob, indexTick, reconcile, resetLedger } from "./index";
import { archivePage, ledgerArchives, newMeter } from "./ledger";
import * as q from "./queries";

const app = new Hono<{ Bindings: Env }>();
const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

app.post("/tick", async (c) => {
  const ledgers = c.req.query("ledger")?.split(",").filter(Boolean);
  const stats = await indexTick(c.env, { budgetMs: Number(c.req.query("ms") ?? 20000), ledgers, maxSubrequests: Number(c.req.query("sub") ?? 800) });
  return c.json(stats);
});
app.post("/job", async (c) => c.json(await indexJob(c.env, Number(c.req.query("ms") ?? 45000))));
app.post("/reset", async (c) => {
  await resetLedger(c.env.DB, c.req.query("ledger") ?? "");
  return c.json({ ok: true });
});
app.get("/reconcile", async (c) => c.json(await reconcile(c.env, c.req.query("ledger") ?? "")));
app.get("/progress", async (c) => {
  const ledger = c.req.query("ledger");
  return c.json(ledger ? await q.indexProgress(c.env.DB, ledger) : { overview: await q.indexOverview(c.env.DB), ledgers: await q.indexProgressAll(c.env.DB) });
});
app.get("/holders", async (c) => c.json(await q.topHolders(c.env.DB, c.req.query("ledger") ?? "", { limit: Number(c.req.query("limit") ?? 20), totalSupplyRaw: c.req.query("supply") ?? null })));
app.get("/stats", async (c) => c.json(await q.holderStats(c.env.DB, c.req.query("ledger") ?? "", c.req.query("supply") ?? null)));
app.get("/big", async (c) => c.json(await q.largeTransfers(c.env.DB, { ledger: c.req.query("ledger"), limit: Number(c.req.query("limit") ?? 20) })));
app.get("/daily", async (c) => c.json(await q.dailyStats(c.env.DB, c.req.query("ledger") ?? "", Number(c.req.query("days") ?? 30))));
app.get("/account", async (c) => c.json(await q.accountHoldings(c.env.DB, c.req.query("owner") ?? "", { includeEmpty: c.req.query("empty") === "1" })));

app.get("/bench", async (c) => {
  const ledger = c.req.query("ledger") ?? "";
  const start = Number(c.req.query("start") ?? 0);
  const archives = await ledgerArchives(c.env.IC_HOST, ledger, "tx", Number(c.req.query("tip") ?? 0), newMeter());
  const a = archives.find((x) => x.start <= start && start <= x.end);
  if (!a) return c.json({ error: "start is not in an archive", archives }, 400);
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const meter = newMeter();
    const txs = await archivePage(c.env.IC_HOST, a.canister, "tx", start + i * 2000, 2000, meter);
    const t0 = Date.now();
    const state = newChunk(start + i * 2000, null);
    applyBlocks(state, txs, 0n);
    runs.push({ txs: txs.length, bytes: meter.bytes, fetchMs: meter.fetchMs, decodeMs: meter.decodeMs, applyMs: Date.now() - t0, accounts: state.accounts.size });
  }
  return new Response(JSON.stringify({ archive: a.canister, runs }, big), { headers: { "content-type": "application/json" } });
});

export default app;
