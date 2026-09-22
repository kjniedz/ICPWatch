// "Fund this canister" island. Loaded only on pages with the panel. Handles mode and method switching,
// intent registration for the wallet-less flow, live deposit status, and the Plug wallet path.
// Wallet code is only touched after the user clicks Connect, so pages without a wallet pay nothing.

const TPUP_MEMO = "1347768404";

interface PlugApi {
  requestConnect(opts?: { whitelist?: string[]; host?: string }): Promise<boolean | string>;
  isConnected(): Promise<boolean>;
  requestTransfer(opts: { to: string; amount: number; memo?: string }): Promise<{ height: number }>;
  principalId?: string;
}

function init(panel: HTMLElement) {
  const canisterId = panel.dataset.fund!;
  const q = <T extends Element = HTMLElement>(sel: string) => panel.querySelector<T>(sel);
  const qa = <T extends Element = HTMLElement>(sel: string) => Array.from(panel.querySelectorAll<T>(sel));
  const status = q("[data-fund-status]")!;
  const amountEl = q("[data-fund-amount]")!;
  let intentId: string | null = null;

  const selectedPreset = (): { e8s: number | null; cycles: number; key: string } | null => {
    const mode = (q<HTMLInputElement>("input[name=mode]:checked")?.value ?? "keep_alive") as string;
    const box = q(`[data-fund-mode="${mode}"]`);
    const el = box?.querySelector<HTMLElement>(".fund-preset input:checked")?.closest<HTMLElement>(".fund-preset");
    if (!el) return null;
    return { e8s: el.dataset.e8s ? Number(el.dataset.e8s) : null, cycles: Number(el.dataset.cycles), key: el.dataset.preset! };
  };
  const paintAmount = () => {
    const p = selectedPreset();
    amountEl.textContent = p?.e8s != null ? `${(p.e8s / 1e8).toFixed(4)} ICP` : "n/a";
    qa(".fund-preset").forEach((el) => el.classList.toggle("on", !!el.querySelector<HTMLInputElement>("input")?.checked));
  };
  qa<HTMLInputElement>("input[name=mode]").forEach((r) => r.addEventListener("change", () => {
    qa("[data-fund-mode]").forEach((box) => { box.hidden = box.dataset.fundMode !== r.value; });
    paintAmount();
  }));
  qa<HTMLInputElement>("input[name=method]").forEach((r) => r.addEventListener("change", () => {
    qa("[data-fund-method]").forEach((box) => { box.hidden = box.dataset.fundMethod !== r.value; });
  }));
  qa<HTMLInputElement>("input[name^=preset-]").forEach((r) => r.addEventListener("change", paintAmount));
  paintAmount();

  const ackOk = () => {
    const mode = q<HTMLInputElement>("input[name=mode]:checked")?.value;
    const ack = q<HTMLInputElement>(`[data-fund-mode="${mode}"] input[name=ack]`);
    return !ack || ack.checked;
  };

  async function register(): Promise<string | null> {
    if (intentId) return intentId;
    const p = selectedPreset();
    const mode = q<HTMLInputElement>("input[name=mode]:checked")?.value ?? "keep_alive";
    const res = await fetch(`/api/v1/fund/${canisterId}/intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, cycles: p?.cycles ?? null, e8s: p?.e8s ?? null }) });
    if (!res.ok) return null;
    intentId = ((await res.json()) as { id: string }).id;
    return intentId;
  }

  let polling = 0;
  async function poll() {
    try {
      const res = await fetch(`/api/v1/fund/${canisterId}/status`);
      if (!res.ok) return;
      const j = (await res.json()) as { deposits: { block_index: number; status: string; cycles: number | null; e8s: number }[] };
      const latest = j.deposits[0];
      if (!latest) { status.textContent = "Watching the top-up account. Nothing has arrived yet."; return; }
      const text: Record<string, string> = { pending: "ICP arrived, asking the CMC to convert it...", converting: "The CMC is converting your ICP to cycles...", credited: `Credited: ${(latest.cycles ?? 0) / 1e12 >= 0.1 ? `${((latest.cycles ?? 0) / 1e12).toFixed(3)} T` : `${((latest.cycles ?? 0) / 1e9).toFixed(2)} B`} cycles reached the canister.`, refunded: "The CMC refunded that transfer (it had no TPUP memo).", wrong_memo: "That transfer has no TPUP memo, so the CMC refunds it. Send again with the memo.", failed: "The CMC rejected that block. Check the public record below.", too_old: "That block is too old to notify." };
      status.textContent = text[latest.status] ?? latest.status;
      if (latest.status === "credited") { clearInterval(polling); status.textContent += " Reload to see it in the record."; }
    } catch { /* keep polling */ }
  }

  q("[data-fund-sent]")?.addEventListener("click", async () => {
    if (!ackOk()) { status.textContent = "Please tick the acknowledgement first."; return; }
    status.textContent = "Registering...";
    const id = await register();
    status.textContent = id ? "Watching the top-up account for the next 24 hours. This updates automatically." : "Could not register. Your transfer still works: ICPWatch notifies deposits it sees on watched accounts.";
    clearInterval(polling);
    polling = window.setInterval(poll, 15000);
    poll();
  });

  // Plug: ICP transfer with the TPUP memo to the canister's top-up account, then we claim the block.
  q("[data-wallet=plug]")?.addEventListener("click", async () => {
    const out = q("[data-wallet-status]")!;
    const plug = (window as unknown as { ic?: { plug?: PlugApi } }).ic?.plug;
    if (!plug) { out.textContent = "Plug is not installed in this browser. Install it from plugwallet.ooo, or use the send-ICP option."; return; }
    if (!ackOk()) { out.textContent = "Please tick the acknowledgement first."; return; }
    const p = selectedPreset();
    if (!p || p.e8s == null) { out.textContent = "Pick an amount first."; return; }
    try {
      out.textContent = "Connecting...";
      await plug.requestConnect({ whitelist: ["ryjl3-tyaaa-aaaaa-aaaba-cai"] });
      await register();
      out.textContent = "Confirm the transfer in Plug...";
      const r = await plug.requestTransfer({ to: panel.dataset.account!, amount: p.e8s - 10000, memo: TPUP_MEMO });
      out.textContent = `Sent in block ${r.height}. Asking the CMC to convert it...`;
      const res = await fetch(`/api/v1/fund/${canisterId}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ block: r.height, intent: intentId }) });
      const j = (await res.json()) as { status: string; cycles: number | null; error: string | null };
      out.textContent = j.status === "credited" ? `Credited: ${((j.cycles ?? 0) / 1e12).toFixed(3)} T cycles reached the canister. Reload to see it in the record.` : `${j.status}: ${j.error ?? ""}`;
    } catch (e) {
      out.textContent = `Plug: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
    }
  });
}

document.querySelectorAll<HTMLElement>("[data-fund]").forEach(init);
