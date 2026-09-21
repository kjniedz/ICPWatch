// Minimal, safe markdown for proposal summaries. Input is untrusted: everything is HTML-escaped
// first, then a small subset of markdown is applied. Raw HTML never passes through, and links
// are limited to http(s).
import { EM_DASH, esc } from "./format";

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => `<a href="${url}" rel="noopener nofollow ugc">${text}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) => `${pre}<a href="${url}" rel="noopener nofollow ugc">${url}</a>`);
}

export function renderMarkdown(src: string, maxChars = 40000): string {
  const lines = esc(src.slice(0, maxChars).replace(/\r\n?/g, "\n").replace(EM_DASH, " - ")).split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let code: string[] | null = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${code.join("\n")}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushPara();
      closeList();
      code = [];
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      // Proposal headings start at h2 so the page keeps a single h1.
      const level = Math.min(4, h[1]!.length + 1);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const kind = /\d/.test(li[1]!) ? "ol" : "ul";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(li[2]!)}</li>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      closeList();
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  if (code) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flushPara();
  closeList();
  return out.join("\n");
}
