import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import manifest from "../asset-manifest.json";

const assets = manifest as Record<string, string>;

export type Section = "home" | "lifeline" | "markets" | "network" | "none";

export interface PageMeta {
  title: string;
  description: string;
  path: string;
  section: Section;
  /** JSON-LD object, optional */
  jsonLd?: Record<string, unknown>;
  noindex?: boolean;
  /** Load the chart island on this page */
  chart?: boolean;
}

const SITE = "https://icpwatch.com";

// Runs before first paint so the stored theme never flashes. Dark is the default.
const themeBoot = `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;else document.documentElement.dataset.theme="dark"}catch(e){document.documentElement.dataset.theme="dark"}})()`;

// Prefetch same-origin links on hover or touch so navigation feels instant.
const speculation = JSON.stringify({
  prefetch: [{ where: { and: [{ href_matches: "/*" }, { not: { href_matches: "/api/*" } }, { not: { selector_matches: "[data-no-prefetch]" } }] }, eagerness: "moderate" }],
});

export function Layout({ meta, children }: { meta: PageMeta; children?: Child }) {
  const url = SITE + meta.path;
  const fullTitle = meta.path === "/" ? meta.title : `${meta.title} | ICPWatch`;
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>{fullTitle}</title>
        <meta name="description" content={meta.description} />
        <link rel="canonical" href={url} />
        {meta.noindex ? <meta name="robots" content="noindex" /> : null}
        <meta name="theme-color" content="#0a1019" />
        <meta property="og:site_name" content="ICPWatch" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={meta.description} />
        <meta property="og:url" content={url} />
        <meta property="og:image" content={`${SITE}/og.png`} />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="preload" href="/fonts/poppins-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin="" />
        <link rel="preload" href="/fonts/poppins-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin="" />
        <link rel="stylesheet" href={assets["styles.css"]} />
        <script>{raw(themeBoot)}</script>
        <script type="speculationrules">{raw(speculation)}</script>
        {meta.jsonLd ? <script type="application/ld+json">{raw(JSON.stringify(meta.jsonLd).replace(/</g, "\\u003c"))}</script> : null}
        <script type="module" src={assets["app.js"]}></script>
        {meta.chart ? <script type="module" src={assets["chart.js"]}></script> : null}
      </head>
      <body>
        <Header section={meta.section} />
        <main>{children}</main>
        <Footer />
      </body>
    </html>
  );
}

/** Radar sweep mark: conic ICP-gradient ring (CSS), fading trail, pink hand, center dot. */
export function BrandMark({ small }: { small?: boolean }) {
  return (
    <span class={`brand-mark${small ? " sm" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <g class="sweep">
          <line x1="16" y1="16" x2="22.6" y2="12.2" stroke="#ed1e79" stroke-width="2.3" stroke-linecap="round" />
        </g>
        <circle cx="16" cy="16" r="2.3" class="hub" />
      </svg>
    </span>
  );
}

function Header({ section }: { section: Section }) {
  const cur = (s: Section) => (section === s ? { "aria-current": "page" as const } : {});
  return (
    <header class="hdr">
      <div class="hdr-in">
        <a href="/" class="brand" aria-label="ICPWatch home">
          <BrandMark />
          <span>ICP<b>Watch</b></span>
        </a>
        <nav class="nav" aria-label="Primary">
          <a href="/lifeline" {...cur("lifeline")}>Lifeline</a>
          <a href="/markets" {...cur("markets")}>Markets</a>
          <a href="/network" {...cur("network")}>Network</a>
        </nav>
        <span class="hdr-sp"></span>
        <form class="hdr-search" action="/search" method="get" role="search" data-search>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input type="search" name="q" placeholder="Search canister, token, proposal" autocomplete="off" spellcheck={false} aria-label="Search" />
          <kbd>/</kbd>
        </form>
        <div class="theme" role="group" aria-label="Theme">
          <button type="button" data-theme-set="light" aria-pressed="false">Light</button>
          <button type="button" data-theme-set="dark" aria-pressed="true">Dark</button>
        </div>
        <a href="/lifeline/alerts" class="btn btn-primary">Get alerts</a>
      </div>
    </header>
  );
}

const footerCols: [string, [string, string][]][] = [
  ["Product", [["Markets", "/markets"], ["Network", "/network"], ["Lifeline", "/lifeline"], ["Price alerts", "/lifeline/alerts"], ["API", "/api"]]],
  ["Explore", [["Whale alerts", "/markets/whales"], ["New listings", "/markets/new"], ["On Life Support", "/lifeline/life-support"], ["Subnets", "/network/subnets"], ["Proposals", "/network/proposals"]]],
  ["Resources", [["Documentation", "/docs"], ["Changelog", "/changelog"], ["Listing request", "/listing-request"], ["Status", "/status"]]],
  ["About", [["FAQ", "/faq"], ["How it works", "/how-it-works"], ["Data sources", "/data-sources"], ["Contact", "/contact"]]],
];

// Set the real profile URLs here once the accounts exist. Until then the chips point at /contact
// so we never link to a handle someone else owns.
const socials: [string, string, string | null][] = [
  ["X", "X", null],
  ["TG", "Telegram", null],
  ["GH", "GitHub", null],
  ["OC", "OpenChat", null],
];

function Footer() {
  return (
    <footer class="ftr">
      <div class="ftr-in">
        <div>
          <a href="/" class="brand">
            <BrandMark small />
            <span>ICP<b>Watch</b></span>
          </a>
          <p class="blurb">Real-time markets, network activity and canister health for the Internet Computer ecosystem.</p>
          <div class="soc">
            {socials.map(([abbr, label, href]) => (
              <a href={href ?? "/contact"} rel={href ? "noopener" : undefined} aria-label={label}>{abbr}</a>
            ))}
          </div>
        </div>
        {footerCols.map(([title, links]) => (
          <div>
            <h5>{title}</h5>
            <ul>
              {links.map(([label, href]) => (
                <li><a href={href}>{label}</a></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div class="ftr-bot">
        <span>&copy; 2026 ICPWatch. All rights reserved.</span>
        <nav aria-label="Legal">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="/disclaimer">Disclaimer</a>
          <span>Powered by the Internet Computer</span>
        </nav>
      </div>
    </footer>
  );
}
