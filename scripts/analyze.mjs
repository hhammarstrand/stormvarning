#!/usr/bin/env node
/**
 * Stormvarning – hotanalys
 * ------------------------------------------------------------
 * Hämtar öppna hotsignaler (CERT-SE, MSB, säkerhetsnyheter via RSS/Atom),
 * skickar dem till MiniMax för bedömning och skriver hotnivå + svensk
 * lägesbild till data.json.
 *
 * Körs av GitHub Actions var 30:e minut. Kräver Node 20+ (global fetch).
 * Inga npm-beroenden.
 *
 * Miljövariabler:
 *   MINIMAX_API_KEY   – API-nyckel (från GitHub Secrets). Utan den görs ingen
 *                       AI-analys men data.json skrivs ändå med händelserna.
 *   MINIMAX_MODEL     – modellnamn (default: MiniMax-Text-01)
 *   MINIMAX_BASE_URL  – bas-URL (default: https://api.minimaxi.chat)
 *   MINIMAX_GROUP_ID  – valfritt GroupId (läggs på som query-param om satt)
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "data.json");

const CONFIG = {
  apiKey: process.env.MINIMAX_API_KEY || "",
  model: process.env.MINIMAX_MODEL || "MiniMax-Text-01",
  baseUrl: (process.env.MINIMAX_BASE_URL || "https://api.minimaxi.chat").replace(/\/+$/, ""),
  groupId: process.env.MINIMAX_GROUP_ID || "",
  maxEvents: 15,
  intervalMinutes: 30,
  // E-postnotiser (Buttondown). Utan nyckel skickas inga mejl.
  buttondownKey: process.env.BUTTONDOWN_API_KEY || "",
  buttondownUrl: process.env.BUTTONDOWN_URL || "https://api.buttondown.com/v1/emails",
  siteUrl: process.env.SITE_URL || "https://hhammarstrand.github.io/stormvarning/",
};

/**
 * Öppna feeds. `weight` markerar hur tungt en källa väger i bedömningen
 * (officiella myndighetskällor väger tyngst). Feeds som fallerar hoppas över.
 */
const FEEDS = [
  { name: "CERT-SE", url: "https://www.cert.se/feed.rss", weight: "hög" },
  { name: "MCF", url: "https://www.mcf.se/sv/rss-floden/rss-alla-nyheter-fran-startsidan-pa-mcf.se/", weight: "hög" },
  { name: "The Hacker News", url: "https://feeds.feedburner.com/TheHackersNews", weight: "medel" },
  { name: "BleepingComputer", url: "https://www.bleepingcomputer.com/feed/", weight: "medel" },
];

const LEVEL_LABELS = {
  "grön": "Grön – låg hotnivå",
  "gul": "Gul – förhöjd hotnivå",
  "röd": "Röd – allvarlig hotnivå",
  "okänd": "Okänd – ingen aktuell analys",
};

/* ---------------------------------------------------------------- utils */

function log(...args) {
  console.log("[stormvarning]", ...args);
}

function stripTags(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(block, tags) {
  for (const tag of tags) {
    // <tag ...>value</tag>
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = block.match(re);
    if (m) return m[1];
  }
  return "";
}

function extractLink(block) {
  // RSS: <link>url</link>
  const rss = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (rss && stripTags(rss[1])) return stripTags(rss[1]);
  // Atom: <link href="url" .../>
  const atom = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  if (atom) return atom[1];
  return "";
}

function truncate(s, n) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

/* -------------------------------------------------------------- fetching */

async function fetchFeed(feed) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Stormvarning/1.0 (+https://github.com/hhammarstrand/stormvarning)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseFeed(xml, feed);
    log(`${feed.name}: ${items.length} poster`);
    return items;
  } catch (err) {
    log(`VARNING: kunde inte hämta ${feed.name} (${feed.url}): ${err.message}`);
    return [];
  }
}

function parseFeed(xml, feed) {
  const events = [];
  // Matcha både RSS <item> och Atom <entry>
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    const title = stripTags(firstMatch(block, ["title"]));
    if (!title) continue;
    const link = extractLink(block);
    const rawDate = stripTags(
      firstMatch(block, ["pubDate", "published", "updated", "dc:date"])
    );
    const date = normalizeDate(rawDate);
    const summary = truncate(
      stripTags(firstMatch(block, ["description", "summary", "content"])),
      280
    );
    events.push({ title, source: feed.name, weight: feed.weight, date, link, summary });
  }
  return events;
}

function normalizeDate(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  return isNaN(d) ? "" : d.toISOString();
}

async function collectEvents() {
  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all = results.flat();

  // Dedupe på titel+källa
  const seen = new Set();
  const deduped = [];
  for (const ev of all) {
    const key = (ev.source + "|" + ev.title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ev);
  }

  // Sortera nyast först (poster utan datum sist)
  deduped.sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) : 0;
    const tb = b.date ? Date.parse(b.date) : 0;
    return tb - ta;
  });

  return deduped.slice(0, CONFIG.maxEvents);
}

/* --------------------------------------------------------------- MiniMax */

function buildPrompt(events) {
  const list = events
    .map((e, i) => {
      const when = e.date ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ") : "okänt datum";
      return `${i + 1}. [${e.source} · vikt: ${e.weight}] (${when})\n   ${e.title}\n   ${e.summary || ""}`;
    })
    .join("\n\n");

  return `Här är de senaste öppna hotsignalerna (RSS från CERT-SE, MSB och säkerhetsnyheter):

${list || "(inga signaler kunde hämtas)"}

Uppgift: Gör en preliminär, ansvarsfull lägesbedömning av risken för en storskalig, samhällspåverkande cyberattack mot Sverige just nu.`;
}

const SYSTEM_PROMPT = `Du är en säkerhetsanalytiker för "Stormvarning", ett tidigt varningssystem för storskaliga cyberattacker mot Sverige. Du får en lista av öppna hotsignaler.

Bedöm hotnivån enligt en trestegsskala:
- "grön": normalläge, inga tecken på förhöjt hot mot Sverige.
- "gul": förhöjt läge – konkreta indikatorer, pågående kampanjer i regionen eller sårbarheter som aktivt utnyttjas och kan påverka svenska mål.
- "röd": allvarligt läge – tecken på pågående eller nära förestående storskalig attack som påverkar svensk kritisk infrastruktur eller samhällsviktig verksamhet.

Var måttfull och undvik att larma i onödan. Officiella myndighetskällor (CERT-SE, MSB) väger tyngst. Enskilda internationella nyheter utan tydlig svensk koppling motiverar sällan mer än grön nivå.

Svara ENDAST med giltig JSON, inga kodblock eller extra text, på formen:
{
  "level": "grön" | "gul" | "röd",
  "summary": "En kort mening (max ~200 tecken) på svenska som sammanfattar läget.",
  "reasoning": "2–4 meningar på svenska som motiverar nivån och hänvisar till de viktigaste signalerna."
}`;

function extractJson(text) {
  if (!text) return null;
  // Plocka ut första balanserade { ... }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function analyzeWithMiniMax(events) {
  if (!CONFIG.apiKey) {
    log("Ingen MINIMAX_API_KEY satt – hoppar över AI-analys.");
    return null;
  }

  let url = `${CONFIG.baseUrl}/v1/text/chatcompletion_v2`;
  if (CONFIG.groupId) url += `?GroupId=${encodeURIComponent(CONFIG.groupId)}`;

  const body = {
    model: CONFIG.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompt(events) },
    ],
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${truncate(text, 200)}`);

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Kunde inte tolka MiniMax-svar som JSON");
    }

    // MiniMax kan signalera fel i base_resp
    if (payload.base_resp && payload.base_resp.status_code) {
      throw new Error(
        `MiniMax base_resp ${payload.base_resp.status_code}: ${payload.base_resp.status_msg || ""}`
      );
    }

    const content =
      payload.choices &&
      payload.choices[0] &&
      payload.choices[0].message &&
      payload.choices[0].message.content;

    const parsed = extractJson(typeof content === "string" ? content : "");
    if (!parsed || !parsed.level) {
      throw new Error("MiniMax-svaret innehöll ingen giltig bedömnings-JSON");
    }

    const level = normalizeLevel(parsed.level);
    log(`MiniMax-bedömning: ${level}`);
    return {
      level,
      summary: truncate(parsed.summary || "", 400),
      reasoning: truncate(parsed.reasoning || "", 1000),
    };
  } catch (err) {
    log(`VARNING: MiniMax-analys misslyckades: ${err.message}`);
    return null;
  }
}

function normalizeLevel(raw) {
  const k = String(raw || "").trim().toLowerCase();
  if (["grön", "gron", "green"].includes(k)) return "grön";
  if (["gul", "yellow"].includes(k)) return "gul";
  if (["röd", "rod", "red"].includes(k)) return "röd";
  return "okänd";
}

const LEVEL_RANK = { "grön": 0, "gul": 1, "röd": 2 };

// Rang för jämförelse. Okänd/saknad behandlas som grön (0) så vi inte råkar
// larma bara för att en tidigare körning saknade AI-bedömning.
function levelRank(level) {
  const r = LEVEL_RANK[normalizeLevel(level)];
  return typeof r === "number" ? r : 0;
}

/* ---------------------------------------------------------- e-postnotiser */

/**
 * Skickar ett mejl till alla Buttondown-prenumeranter. Avsiktligt tunt:
 * status "about_to_send" gör att Buttondown skickar direkt (default är annars
 * ett utkast). Fel loggas men får aldrig krascha jobbet.
 */
async function sendNotification(data) {
  const subjectPrefix = data.level === "röd" ? "🔴 RÖD" : "🟡 GUL";
  const subject = `Stormvarning: ${subjectPrefix} hotnivå`;
  const body = [
    `**${data.level_label}**`,
    "",
    data.summary,
    "",
    data.reasoning,
    "",
    `Aktuell lägesbild: ${CONFIG.siteUrl}`,
    "",
    "---",
    "Stormvarning är ett automatiserat stödverktyg och ingen officiell källa. " +
      "Följ alltid CERT-SE och MSB vid en pågående incident.",
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(CONFIG.buttondownUrl, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Authorization": `Token ${CONFIG.buttondownKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ subject, body, status: "about_to_send" }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${truncate(text, 200)}`);
    log(`Notis skickad via Buttondown (nivå: ${data.level}).`);
    return true;
  } catch (err) {
    log(`VARNING: kunde inte skicka e-postnotis: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ main */

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUT, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  const now = new Date();
  const next = new Date(now.getTime() + CONFIG.intervalMinutes * 60 * 1000);

  const events = await collectEvents();
  log(`Totalt ${events.length} unika händelser efter dedupe.`);

  const analysis = await analyzeWithMiniMax(events);
  const prev = await readPrevious();

  let level, summary, reasoning;
  if (analysis) {
    ({ level, summary, reasoning } = analysis);
  } else {
    // Fallback: ingen färsk AI-bedömning. Behåll händelserna men var tydlig
    // med att nivån inte kunde beräknas den här körningen.
    level = "okänd";
    summary = events.length
      ? "Nya hotsignaler hämtades, men ingen automatisk hotbedömning kunde göras denna körning."
      : "Inga hotsignaler kunde hämtas och ingen bedömning kunde göras denna körning.";
    reasoning = CONFIG.apiKey
      ? "AI-analysen (MiniMax) svarade inte som väntat. Se senaste händelser nedan och följ officiella källor (CERT-SE, MSB) för bekräftad information."
      : "Ingen MINIMAX_API_KEY är konfigurerad, så någon automatisk bedömning görs inte. Händelselistan nedan visar de senaste öppna signalerna.";
    if (prev && prev.updated) {
      reasoning += ` Föregående bedömning (${prev.level || "okänd"}) gjordes ${new Date(prev.updated).toLocaleString("sv-SE")}.`;
    }
  }

  // Avgör om vi ska larma. `notified_level` minns nivån vi senast mejlade om,
  // så vi bara skickar vid en faktisk HÖJNING till gul/röd – inte var 30:e minut
  // och inte när en tidigare körning tillfälligt saknade AI-bedömning.
  const baseline = prev && prev.notified_level ? normalizeLevel(prev.notified_level) : "grön";
  let notifiedLevel = baseline;
  let shouldNotify = false;
  if (level !== "okänd") {
    // Följ aktuell nivå (även vid nedgång) men larma bara vid uppgång till gul/röd.
    notifiedLevel = level;
    if (levelRank(level) > levelRank(baseline) && levelRank(level) >= LEVEL_RANK["gul"]) {
      shouldNotify = true;
    }
  }

  const data = {
    updated: now.toISOString(),
    next_update: next.toISOString(),
    level,
    level_label: LEVEL_LABELS[level] || LEVEL_LABELS["okänd"],
    summary,
    reasoning,
    events: events.map(({ weight, ...rest }) => rest),
    sources: [...new Set(events.map((e) => e.source))].length
      ? [...new Set(events.map((e) => e.source))]
      : FEEDS.map((f) => f.name),
    model: analysis ? CONFIG.model : null,
    notified_level: notifiedLevel,
  };

  if (shouldNotify) {
    if (CONFIG.buttondownKey) {
      log(`Nivåhöjning ${baseline} → ${level}: skickar e-postnotis.`);
      await sendNotification(data);
    } else {
      log(`Nivåhöjning ${baseline} → ${level}, men BUTTONDOWN_API_KEY saknas – hoppar över notis.`);
    }
  }

  await writeFile(OUT, JSON.stringify(data, null, 2) + "\n", "utf8");
  log(`Skrev ${OUT} (nivå: ${level}, händelser: ${data.events.length}).`);
}

main().catch((err) => {
  console.error("[stormvarning] FATAL:", err);
  process.exit(1);
});
