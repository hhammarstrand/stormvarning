#!/usr/bin/env node
/**
 * Stormvarning – hotanalys
 * ------------------------------------------------------------
 * Hämtar öppna hotsignaler från flera källor (svenska myndigheter, CISA KEV
 * (aktivt utnyttjade sårbarheter), internationella CERT:er och säkerhetsnyheter),
 * beräknar deterministiska indikatorer, låter MiniMax göra en lägesbedömning och
 * skriver hotnivå + lägesbild till data.json. Historiken sparas i history.json.
 *
 * Körs av GitHub Actions var 30:e minut. Kräver Node 20+ (global fetch).
 * Inga npm-beroenden.
 *
 * Miljövariabler:
 *   MINIMAX_API_KEY   – API-nyckel (från GitHub Secrets). Utan den används en
 *                       deterministisk heuristik som fallback.
 *   MINIMAX_MODEL     – modellnamn (default: MiniMax-Text-01)
 *   MINIMAX_BASE_URL  – bas-URL (default: https://api.minimaxi.chat)
 *   MINIMAX_GROUP_ID  – valfritt GroupId (läggs på som query-param om satt)
 *   BUTTONDOWN_API_KEY – valfritt, för e-postnotiser vid höjd nivå
 *   SITE_URL          – publik URL (används i notismejl)
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "data.json");
const HISTORY = join(ROOT, "history.json");

const CONFIG = {
  apiKey: process.env.MINIMAX_API_KEY || "",
  model: process.env.MINIMAX_MODEL || "MiniMax-Text-01",
  baseUrl: (process.env.MINIMAX_BASE_URL || "https://api.minimaxi.chat").replace(/\/+$/, ""),
  groupId: process.env.MINIMAX_GROUP_ID || "",
  maxEvents: 24,
  maxPromptEvents: 20,
  historyLength: 480, // ~10 dygn @ 30 min
  kevWindowDays: 7,
  intervalMinutes: 30,
  buttondownKey: process.env.BUTTONDOWN_API_KEY || "",
  buttondownUrl: process.env.BUTTONDOWN_URL || "https://api.buttondown.com/v1/emails",
  siteUrl: process.env.SITE_URL || "https://hhammarstrand.github.io/stormvarning/",
};

/**
 * Öppna källor. `weight` = hur tungt källan väger (myndigheter tyngst),
 * `region` SE/INT, `type` avgör parser. Källor som fallerar hoppas över och
 * markeras som nere i källhälsan.
 */
const SOURCES = [
  { name: "CERT-SE", type: "rss", region: "SE", weight: "hög", url: "https://www.cert.se/feed.rss" },
  { name: "MCF", type: "rss", region: "SE", weight: "hög", cyberFilter: true, url: "https://www.mcf.se/sv/rss-floden/rss-alla-nyheter-fran-startsidan-pa-mcf.se/" },
  { name: "Krisinformation", type: "krisinfo", region: "SE", weight: "hög", cyberFilter: true, url: "https://api.krisinformation.se/v3/news?format=json" },
  { name: "CISA KEV", type: "kev", region: "INT", weight: "hög", url: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json" },
  { name: "CISA", type: "rss", region: "INT", weight: "medel", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml" },
  { name: "NCSC-UK", type: "rss", region: "INT", weight: "medel", url: "https://www.ncsc.gov.uk/api/1/services/v1/news-rss-feed.xml" },
  { name: "The Hacker News", type: "rss", region: "INT", weight: "medel", url: "https://feeds.feedburner.com/TheHackersNews" },
  { name: "BleepingComputer", type: "rss", region: "INT", weight: "medel", url: "https://www.bleepingcomputer.com/feed/" },
];

const AUTHORITY_SOURCES = new Set(["CERT-SE", "MCF", "Krisinformation", "CISA", "CISA KEV", "NCSC-UK"]);

const LEVEL_LABELS = {
  "grön": "Grön – låg hotnivå",
  "gul": "Gul – förhöjd hotnivå",
  "röd": "Röd – allvarlig hotnivå",
  "okänd": "Okänd – ingen aktuell analys",
};

// Nyckelord för att flagga signaler deterministiskt (oberoende av AI).
const RE_SWEDEN = /\b(sverige|svensk\w*|swedish|sweden)\b/i;
const RE_EXPLOITED = /(aktivt utnyttja\w*|utnyttjas aktivt|actively exploited|exploited in the wild|in-the-wild|zero[- ]day|nolldag|0-day|under active attack)/i;
const RE_CRITICAL = /(kritisk\w* sårbarhet|critical vulnerabilit|cvss[: ]*(9|10)|\brce\b|remote code execution|wormable|maskmask|pre-auth)/i;
const RE_CYBER = /(cyber|it-attack|it-angrepp|dataintrång|hackare|hackad|ransomware|utpressning|överbelastning|ddos|driftstörning|sårbarhet|skadlig kod|malware|phishing|nätfiske|informationssäkerhet|angrepp|intrång)/i;

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
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = block.match(re);
    if (m) return m[1];
  }
  return "";
}

function extractLink(block) {
  const rss = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
  if (rss && stripTags(rss[1])) return stripTags(rss[1]);
  const atom = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  if (atom) return atom[1];
  return "";
}

function truncate(s, n) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

function normalizeDate(raw) {
  if (!raw) return "";
  const d = new Date(raw);
  return isNaN(d) ? "" : d.toISOString();
}

async function fetchText(url, timeoutMs = 15000, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Stormvarning/2.0 (+https://github.com/hhammarstrand/stormvarning)",
        "Accept": accept || "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------- parsers */

function parseRss(xml, source) {
  const events = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    const title = stripTags(firstMatch(block, ["title"]));
    if (!title) continue;
    const link = extractLink(block);
    const date = normalizeDate(stripTags(firstMatch(block, ["pubDate", "published", "updated", "dc:date"])));
    const summary = truncate(stripTags(firstMatch(block, ["description", "summary", "content"])), 280);
    events.push(makeEvent({ title, source, date, link, summary }));
  }
  return events;
}

// CISA Known Exploited Vulnerabilities – guldstandard för "aktivt utnyttjas".
function parseKev(jsonText, source) {
  const data = JSON.parse(jsonText);
  const vulns = Array.isArray(data.vulnerabilities) ? data.vulnerabilities : [];
  const cutoff = Date.now() - CONFIG.kevWindowDays * 86400000;
  const events = [];
  for (const v of vulns) {
    const added = v.dateAdded ? Date.parse(v.dateAdded) : NaN;
    if (isNaN(added) || added < cutoff) continue;
    const cve = v.cveID || "";
    const title = `${cve}: ${v.vulnerabilityName || v.product || "Aktivt utnyttjad sårbarhet"}`;
    events.push(makeEvent({
      title,
      source,
      date: new Date(added).toISOString(),
      link: cve ? `https://nvd.nist.gov/vuln/detail/${cve}` : "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
      summary: truncate(`${v.vendorProject || ""} ${v.product || ""} – ${v.shortDescription || ""}`.trim(), 280),
      flags: { activelyExploited: true, cve },
    }));
  }
  return events;
}

// krisinformation.se – officiella svenska krishändelser (filtreras till cyberrelevanta).
function parseKrisinfo(jsonText, source) {
  let data;
  try { data = JSON.parse(jsonText); } catch { return []; }
  const items = Array.isArray(data) ? data : (Array.isArray(data.news) ? data.news : []);
  const events = [];
  for (const it of items) {
    const title = stripTags(it.Headline || it.headline || "");
    if (!title) continue;
    const summary = truncate(stripTags(it.Preamble || it.preamble || it.BodyText || ""), 280);
    if (!RE_CYBER.test(title + " " + summary)) continue; // bara cyberrelevant
    const date = normalizeDate(it.Published || it.Updated || it.PublishedDate || "");
    const link = it.Web || it.web || (it.Links && it.Links[0] && it.Links[0].Url) || "https://www.krisinformation.se";
    events.push(makeEvent({ title, source, date, link, summary }));
  }
  return events;
}

function makeEvent({ title, source, date, link, summary, flags }) {
  return { title, source: source.name, region: source.region, weight: source.weight, date: date || "", link: link || "", summary: summary || "", flags: flags || {} };
}

// Flagga varje händelse deterministiskt (Sverige-relevans, exploit, kritisk).
function annotate(ev) {
  const text = `${ev.title} ${ev.summary}`;
  const f = ev.flags || {};
  ev.flags = {
    activelyExploited: !!f.activelyExploited || RE_EXPLOITED.test(text),
    critical: RE_CRITICAL.test(text),
    swedenRelevant: ev.region === "SE" || RE_SWEDEN.test(text),
    cve: f.cve || (text.match(/CVE-\d{4}-\d{4,7}/i) || [null])[0],
  };
  return ev;
}

/* -------------------------------------------------------------- fetching */

async function fetchSource(source) {
  const health = { name: source.name, region: source.region, ok: false, count: 0 };
  try {
    const timeout = source.type === "kev" ? 25000 : 15000;
    const body = await fetchText(source.url, timeout);
    let events;
    if (source.type === "kev") events = parseKev(body, source);
    else if (source.type === "krisinfo") events = parseKrisinfo(body, source);
    else events = parseRss(body, source);
    // Källor med blandat innehåll (MCF, krisinformation) filtreras till cyber.
    if (source.cyberFilter) events = events.filter((e) => RE_CYBER.test(`${e.title} ${e.summary}`));
    health.ok = true;
    health.count = events.length;
    log(`${source.name}: ${events.length} poster`);
    return { events, health };
  } catch (err) {
    log(`VARNING: kunde inte hämta ${source.name} (${source.url}): ${err.message}`);
    return { events: [], health };
  }
}

async function collectSignals() {
  const results = await Promise.all(SOURCES.map(fetchSource));
  const health = results.map((r) => r.health);
  let all = results.flatMap((r) => r.events).map(annotate);

  // Dedupe på titel (normaliserad) – samma story kan finnas i flera källor.
  const seen = new Set();
  const deduped = [];
  for (const ev of all) {
    const key = ev.title.toLowerCase().replace(/[^a-zà-ÿ0-9]+/g, " ").trim().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(ev);
  }

  // Prioritera akuta signaler så de aldrig trängs undan av rutinnyheter:
  // svensk + akut överst, sedan aktivt utnyttjade/kritiska, sedan svensk, sedan färskhet.
  const prio = (ev) =>
    (ev.flags.swedenRelevant && (ev.flags.activelyExploited || ev.flags.critical) ? 10 : 0) +
    (ev.flags.activelyExploited ? 4 : 0) +
    (ev.flags.critical ? 3 : 0) +
    (ev.flags.swedenRelevant ? 2 : 0) +
    (AUTHORITY_SOURCES.has(ev.source) ? 1 : 0);
  deduped.sort((a, b) => (prio(b) - prio(a)) || ((Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)));

  return { events: deduped.slice(0, CONFIG.maxEvents), health };
}

/* ------------------------------------------------------- indikatorer */

function computeIndicators(events) {
  const ind = {
    total_signals: events.length,
    sweden_relevant: 0,
    sweden_acute: 0, // Sverige-relevant OCH aktivt utnyttjad/kritisk – den viktigaste tidiga signalen
    actively_exploited: 0,
    critical: 0,
    authority_alerts: 0,
    kev_recent: 0,
  };
  for (const ev of events) {
    const acute = ev.flags.activelyExploited || ev.flags.critical;
    if (ev.flags.swedenRelevant) ind.sweden_relevant++;
    if (ev.flags.swedenRelevant && acute) ind.sweden_acute++;
    if (ev.flags.activelyExploited) ind.actively_exploited++;
    if (ev.flags.critical) ind.critical++;
    if (AUTHORITY_SOURCES.has(ev.source)) ind.authority_alerts++;
    if (ev.source === "CISA KEV") ind.kev_recent++;
  }
  return ind;
}

// Transparent 0–100-poäng som tripwire och för historik/trend. Vikten ligger på
// AKUTA signaler (aktivt utnyttjade/kritiska sårbarheter, särskilt med svensk
// koppling) – inte på volymen rutinnyheter från myndigheter.
function riskScore(ind) {
  // Svensk akut exponering är den dominerande drivkraften; internationell
  // exploit-volym (rutinmässig varje patch-vecka) bidrar mer måttfullt.
  const s =
    ind.sweden_acute * 22 +
    ind.actively_exploited * 3 +
    ind.critical * 3 +
    ind.kev_recent * 2 +
    Math.min(ind.authority_alerts, 4) * 1;
  return Math.max(0, Math.min(100, Math.round(s)));
}

// Deterministisk fallback-nivå när AI inte är tillgänglig. Konservativ – larmar
// bara vid en akut signal med svensk koppling, och går aldrig till röd (det
// kräver mänsklig/AI-bedömning). AI:n gör den egentliga nyanserade bedömningen.
function heuristicLevel(ind) {
  if (ind.sweden_acute > 0) return "gul";
  return "grön";
}

// Avvikelsedetektering: fångar en ovanlig ökning av aktivitet innan nivån
// formellt höjs. Jämför aktuellt riskindex mot baslinjen (medel) av den
// föregående historiken. Kräver tillräckligt underlag för att undvika brus.
function detectAnomaly(priorScores, current) {
  const scores = (priorScores || []).filter((n) => typeof n === "number");
  if (scores.length < 8) return { active: false, baseline: null, delta: 0 };
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
  const threshold = Math.max(mean + 2 * sd, mean + 18);
  return {
    active: current >= threshold && current >= mean + 15,
    baseline: Math.round(mean),
    delta: Math.round(current - mean),
  };
}

// Hur länge nuvarande nivå har hållit i sig (tidsstämpel för när den senast
// ändrades), härlett ur historiken.
function computeLevelSince(history, level) {
  const target = normalizeLevel(level);
  let since = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (normalizeLevel(history[i].level) === target) since = history[i].t;
    else break;
  }
  return since;
}

/* --------------------------------------------------------------- MiniMax */

function buildPrompt(events, ind) {
  const list = events.slice(0, CONFIG.maxPromptEvents)
    .map((e, i) => {
      const when = e.date ? new Date(e.date).toISOString().slice(0, 16).replace("T", " ") : "okänt datum";
      const tags = [
        e.flags.swedenRelevant ? "SVERIGE" : null,
        e.flags.activelyExploited ? "AKTIVT-UTNYTTJAD" : null,
        e.flags.critical ? "KRITISK" : null,
      ].filter(Boolean).join(",");
      return `${i + 1}. [${e.source} · ${e.region} · vikt:${e.weight}${tags ? " · " + tags : ""}] (${when})\n   ${e.title}\n   ${e.summary || ""}`;
    })
    .join("\n\n");

  const indText = `Deterministiska indikatorer (automatiskt beräknade ur signalerna):
- Totalt antal signaler: ${ind.total_signals}
- Sverige-relaterade: ${ind.sweden_relevant}
- Aktivt utnyttjade sårbarheter: ${ind.actively_exploited}
- Kritiska sårbarheter: ${ind.critical}
- Myndighetsvarningar: ${ind.authority_alerts}
- Nya CISA KEV (aktivt utnyttjade): ${ind.kev_recent}`;

  return `Här är de senaste öppna hotsignalerna (svenska myndigheter, CISA KEV, internationella CERT:er och säkerhetsnyheter):

${list || "(inga signaler kunde hämtas)"}

${indText}

Uppgift: Gör en preliminär, ansvarsfull lägesbedömning av risken för en storskalig, samhällspåverkande cyberattack mot Sverige just nu. Väg särskilt signaler taggade SVERIGE och AKTIVT-UTNYTTJAD tyngst.`;
}

const SYSTEM_PROMPT = `Du är en säkerhetsanalytiker för "Stormvarning", ett tidigt varningssystem för storskaliga cyberattacker mot Sverige. Du får en lista av öppna hotsignaler samt deterministiska indikatorer.

Bedöm hotnivån enligt en trestegsskala:
- "grön": normalläge, inga tecken på förhöjt hot mot Sverige.
- "gul": förhöjt läge – konkreta indikatorer, pågående kampanjer i regionen eller sårbarheter som aktivt utnyttjas och kan påverka svenska mål.
- "röd": allvarligt läge – tecken på pågående eller nära förestående storskalig attack som påverkar svensk kritisk infrastruktur eller samhällsviktig verksamhet.

Var måttfull och undvik att larma i onödan. Officiella myndighetskällor (CERT-SE, MCF, CISA, NCSC) väger tyngst. Enskilda internationella nyheter utan tydlig svensk koppling motiverar sällan mer än grön nivå. Sårbarheter som aktivt utnyttjas och samtidigt berör svenska mål motiverar minst gul.

Svara ENDAST med giltig JSON, inga kodblock eller extra text, på formen:
{
  "level": "grön" | "gul" | "röd",
  "summary": "En kort mening (max ~200 tecken) på svenska som sammanfattar läget.",
  "reasoning": "2–4 meningar på svenska som motiverar nivån och hänvisar till de viktigaste signalerna."
}`;

function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function analyzeWithMiniMax(events, ind) {
  if (!CONFIG.apiKey) {
    log("Ingen MINIMAX_API_KEY satt – använder heuristik.");
    return null;
  }

  let url = `${CONFIG.baseUrl}/v1/text/chatcompletion_v2`;
  if (CONFIG.groupId) url += `?GroupId=${encodeURIComponent(CONFIG.groupId)}`;

  const body = {
    model: CONFIG.model,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompt(events, ind) },
    ],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CONFIG.apiKey}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${truncate(text, 200)}`);

    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error("Kunde inte tolka MiniMax-svar som JSON"); }
    if (payload.base_resp && payload.base_resp.status_code) {
      throw new Error(`MiniMax base_resp ${payload.base_resp.status_code}: ${payload.base_resp.status_msg || ""}`);
    }
    const content = payload.choices?.[0]?.message?.content;
    const parsed = extractJson(typeof content === "string" ? content : "");
    if (!parsed || !parsed.level) throw new Error("MiniMax-svaret innehöll ingen giltig bedömnings-JSON");

    const level = normalizeLevel(parsed.level);
    log(`MiniMax-bedömning: ${level}`);
    return { level, summary: truncate(parsed.summary || "", 400), reasoning: truncate(parsed.reasoning || "", 1000) };
  } catch (err) {
    log(`VARNING: MiniMax-analys misslyckades: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
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
function levelRank(level) {
  const r = LEVEL_RANK[normalizeLevel(level)];
  return typeof r === "number" ? r : 0;
}

/* ---------------------------------------------------------- e-postnotiser */

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
      headers: { "Authorization": `Token ${CONFIG.buttondownKey}`, "Content-Type": "application/json" },
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

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function main() {
  const now = new Date();
  const next = new Date(now.getTime() + CONFIG.intervalMinutes * 60 * 1000);

  const { events, health } = await collectSignals();
  const indicators = computeIndicators(events);
  const score = riskScore(indicators);
  log(`${events.length} signaler · indikatorer: ${JSON.stringify(indicators)} · score ${score}`);

  const analysis = await analyzeWithMiniMax(events, indicators);
  const prev = await readJson(OUT, null);

  let level, summary, reasoning, model;
  if (analysis) {
    ({ level, summary, reasoning } = analysis);
    model = CONFIG.model;
  } else if (events.length) {
    // Deterministisk heuristik som backstop – systemet är aldrig tyst.
    level = heuristicLevel(indicators);
    model = "heuristik (utan AI)";
    summary = level === "gul"
      ? "Förhöjda indikatorer: aktivt utnyttjade sårbarheter med möjlig svensk koppling. Automatisk heuristik (ingen AI-bedömning)."
      : "Inga tydliga tecken på förhöjt hot mot Sverige i signalerna. Automatisk heuristik (ingen AI-bedömning).";
    reasoning = `Bedömningen är gjord med en deterministisk heuristik eftersom AI-analysen inte var tillgänglig. Underlag: ${indicators.actively_exploited} aktivt utnyttjade sårbarheter, ${indicators.sweden_relevant} Sverige-relaterade signaler, ${indicators.authority_alerts} myndighetsvarningar. Följ CERT-SE och MCF för bekräftad information.`;
  } else {
    level = "okänd";
    model = null;
    summary = "Inga hotsignaler kunde hämtas och ingen bedömning kunde göras denna körning.";
    reasoning = "Samtliga källor svarade inte. Kontrollera källhälsan nedan och följ officiella källor (CERT-SE, MCF).";
  }

  // Notiser: bara vid AI-bedömd höjning till gul/röd (heuristik larmar inte, för
  // att undvika falsklarm). `notified_level` minns senast larmade nivå.
  const baseline = prev && prev.notified_level ? normalizeLevel(prev.notified_level) : "grön";
  let notifiedLevel = baseline;
  let shouldNotify = false;
  if (analysis && level !== "okänd") {
    notifiedLevel = level;
    if (levelRank(level) > levelRank(baseline) && levelRank(level) >= LEVEL_RANK["gul"]) shouldNotify = true;
  }

  // Historik / trend. Beräkna avvikelse mot baslinjen INNAN vi lägger till
  // den aktuella punkten.
  const history = await readJson(HISTORY, []);
  const historyArr = Array.isArray(history) ? history : [];
  const priorScores = historyArr.slice(-48).map((h) => h.score);
  const anomaly = detectAnomaly(priorScores, score);
  if (anomaly.active) log(`AVVIKELSE: index ${score} mot baslinje ${anomaly.baseline} (+${anomaly.delta}).`);
  if (level !== "okänd") {
    historyArr.push({ t: now.toISOString(), level, score });
  }
  const trimmedHistory = historyArr.slice(-CONFIG.historyLength);
  const levelSince = computeLevelSince(trimmedHistory, level);

  const data = {
    updated: now.toISOString(),
    next_update: next.toISOString(),
    level,
    level_label: LEVEL_LABELS[level] || LEVEL_LABELS["okänd"],
    summary,
    reasoning,
    score,
    indicators,
    anomaly,
    level_since: levelSince,
    events: events.map(({ weight, ...rest }) => rest),
    sources_health: health,
    sources: SOURCES.map((s) => s.name),
    model,
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
  await writeFile(HISTORY, JSON.stringify(trimmedHistory) + "\n", "utf8");
  log(`Skrev data.json (nivå: ${level}, score: ${score}, signaler: ${data.events.length}, historik: ${trimmedHistory.length}).`);
}

// Kör bara main() när scriptet startas direkt (inte vid import från tester).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("[stormvarning] FATAL:", err);
    process.exit(1);
  });
}

export { normalizeLevel, levelRank, riskScore, heuristicLevel, computeIndicators, annotate, detectAnomaly, computeLevelSince };

