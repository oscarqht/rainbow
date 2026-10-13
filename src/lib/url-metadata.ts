import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Parser } from "htmlparser2";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function parseMetadata(html: string): { title: string; description: string } {
  let inTitle = false, title = "";
  const meta: Record<string, string> = {};
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === "title") inTitle = true;
      if (name === "meta") {
        const key = (attrs.property || attrs.name || "").toLowerCase();
        if (attrs.content?.trim() && !meta[key]) meta[key] = attrs.content;
      }
    },
    ontext(text) { if (inTitle) title += text; },
    onclosetag(name) { if (name === "title") inTitle = false; },
  }, { decodeEntities: true });
  parser.end(html);
  const clean = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);
  return { title: clean(meta["og:title"] || title || meta["twitter:title"] || "", 500), description: clean(meta["description"] || meta["og:description"] || meta["twitter:description"] || "", 5000) };
}

// Resolve and pin a public address on every hop, including redirects, so a
// submitted URL cannot reach private services or rebind DNS after validation.
export async function fetchUrlMetadata(input: string): Promise<{ title: string; description: string }> {
  const signal = AbortSignal.timeout(8000);
  let url = new URL(input);
  for (let hop = 0; hop < 4; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (isIP(host) && !isPublicAddress(host))) throw new Error("Unsupported metadata URL.");
    const result = await new Promise<{ html?: string; redirect?: string }>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(url, {
        signal,
        agent: false,
        headers: { Accept: "text/html, application/xhtml+xml", "User-Agent": "Rainbow/1.0 (bookmark metadata)" },
        lookup(hostname, options, callback) {
          dns.lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error, "", 4);
            if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) return callback(new Error("Private metadata address."), "", 4);
            const address = addresses[0];
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          });
        },
      }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
          resolve({ redirect: response.headers.location }); response.destroy(); return;
        }
        if (response.statusCode !== 200 || !/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers["content-type"] || "")) {
          reject(new Error("No HTML metadata.")); response.destroy(); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_000_000) request.destroy(new Error("Metadata page is too large."));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      });
      request.on("error", reject);
    });
    if (result.redirect) url = new URL(result.redirect, url);
    else return parseMetadata(result.html!);
  }
  throw new Error("Too many metadata redirects.");
}
