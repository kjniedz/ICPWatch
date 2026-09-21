// Seed registry for tokens that cannot be discovered from the SNS aggregator or the ck orchestrator.
// Every id here was verified on chain (icrc1_symbol, or controller status for frozen ledgers) on 2026-09-21.
// Symbol, name, and decimals are fallbacks: live ledger metadata wins whenever the ledger answers.

export interface SeedToken {
  ledger: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: "native" | "ck" | "community";
  /** undefined: discover via ICRC-106. null: known to have none. */
  index?: string | null;
  archives?: string[];
  /** Balance source known to work, saves a probe round. */
  hint?: "nns-root" | "metrics" | "blackhole" | null;
  via?: string;
  description?: string;
  url?: string;
  extra?: { id: string; role: string; label: string }[];
}

export const SEED_TOKENS: SeedToken[] = [
  {
    ledger: "ryjl3-tyaaa-aaaaa-aaaba-cai", symbol: "ICP", name: "Internet Computer", decimals: 8, kind: "native", index: "qhbym-qaaaa-aaaaa-aaafq-cai", hint: "nns-root",
    description: "The native token of the Internet Computer. It is converted to cycles to pay for computation and staked in neurons to govern the network.",
    url: "https://internetcomputer.org",
  },
  {
    ledger: "mxzaz-hqaaa-aaaar-qaada-cai", symbol: "ckBTC", name: "ckBTC", decimals: 8, kind: "ck", index: "n5wcd-faaaa-aaaar-qaaea-cai", hint: "nns-root",
    description: "Bitcoin on the Internet Computer, backed 1:1 by BTC held by the ckBTC minter canister using threshold ECDSA.",
    extra: [{ id: "mqygn-kiaaa-aaaar-qaadq-cai", role: "minter", label: "ckBTC Minter" }],
  },
  {
    ledger: "ss2fx-dyaaa-aaaar-qacoq-cai", symbol: "ckETH", name: "ckETH", decimals: 18, kind: "ck", index: "s3zol-vqaaa-aaaar-qacpa-cai", hint: "nns-root",
    description: "Ether on the Internet Computer, backed 1:1 by ETH held by the ckETH minter canister.",
    extra: [
      { id: "sv3dd-oaaaa-aaaar-qacoa-cai", role: "minter", label: "ckETH Minter" },
      { id: "vxkom-oyaaa-aaaar-qafda-cai", role: "orchestrator", label: "ck Ledger Suite Orchestrator" },
    ],
  },
  // Community tokens
  { ledger: "eayyd-iiaaa-aaaah-adtea-cai", symbol: "IDOGE", name: "iDoge", decimals: 8, kind: "community", hint: "blackhole", description: "Community meme token. Its ledger is controlled only by a blackhole canister, so nobody can upgrade it and anyone can top it up." },
  { ledger: "7pail-xaaaa-aaaas-aabmq-cai", symbol: "BOB", name: "BOB", decimals: 8, kind: "community", hint: "nns-root" },
  { ledger: "rh2pm-ryaaa-aaaan-qeniq-cai", symbol: "EXE", name: "Windoge98", decimals: 8, kind: "community", hint: "nns-root" },
  { ledger: "6qfxa-ryaaa-aaaai-qbhsq-cai", symbol: "TAGGR", name: "TAGGR", decimals: 2, kind: "community", hint: "nns-root", index: null },
  { ledger: "buwm7-7yaaa-aaaar-qagva-cai", symbol: "nICP", name: "neuron ICP", decimals: 8, kind: "community", hint: "metrics" },
  { ledger: "6c7su-kiaaa-aaaar-qaira-cai", symbol: "GLDT", name: "Gold Token", decimals: 8, kind: "community", hint: "metrics" },
  { ledger: "n6tkf-tqaaa-aaaal-qsneq-cai", symbol: "cICP", name: "cICP", decimals: 8, kind: "community", hint: "metrics" },
  { ledger: "iwv6l-6iaaa-aaaal-ajjjq-cai", symbol: "CLOWN", name: "CLOWN", decimals: 8, kind: "community", hint: "metrics" },
  { ledger: "7xkvf-zyaaa-aaaal-ajvra-cai", symbol: "PARTY", name: "PARTY", decimals: 8, kind: "community", hint: "metrics" },
  { ledger: "vpyot-zqaaa-aaaaa-qavaq-cai", symbol: "FUNNAI", name: "funnAI", decimals: 8, kind: "community", hint: "metrics" },
  { ledger: "icaf7-3aaaa-aaaam-qcx3q-cai", symbol: "RUGGY", name: "RUGGY", decimals: 8, kind: "community", hint: "metrics" },
  // Custom ledger code with no public controller: liveness probing only.
  { ledger: "wkv3f-iiaaa-aaaap-ag73a-cai", symbol: "WUMBO", name: "WUMBO", decimals: 8, kind: "community", index: null },
  { ledger: "zzsnb-aaaaa-aaaap-ag66q-cai", symbol: "DAMONIC", name: "DAMONIC", decimals: 8, kind: "community", index: null },
];
