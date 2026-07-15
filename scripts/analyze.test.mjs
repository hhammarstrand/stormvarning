/**
 * Tester för den deterministiska kärnan i analyze.mjs.
 * Kör med:  node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLevel, levelRank, riskScore, heuristicLevel,
  computeIndicators, annotate, detectAnomaly, computeLevelSince,
  applyLevelPolicy, applyHysteresis,
} from "./analyze.mjs";

test("normalizeLevel mappar varianter", () => {
  assert.equal(normalizeLevel("grön"), "grön");
  assert.equal(normalizeLevel("GRON"), "grön");
  assert.equal(normalizeLevel("red"), "röd");
  assert.equal(normalizeLevel("yellow"), "gul");
  assert.equal(normalizeLevel("nonsens"), "okänd");
  assert.equal(normalizeLevel(""), "okänd");
});

test("levelRank ordnar nivåerna", () => {
  assert.ok(levelRank("röd") > levelRank("gul"));
  assert.ok(levelRank("gul") > levelRank("grön"));
  assert.equal(levelRank("okänd"), 0); // behandlas som grön
});

test("annotate flaggar exploit, kritisk, sverige och cve", () => {
  const ev = annotate({
    title: "CVE-2026-1234: Critical vulnerability actively exploited in Sweden",
    summary: "remote code execution", region: "INT", flags: {},
  });
  assert.equal(ev.flags.activelyExploited, true);
  assert.equal(ev.flags.critical, true);
  assert.equal(ev.flags.swedenRelevant, true);
  assert.match(ev.flags.cve, /CVE-2026-1234/);
});

test("region SE ger swedenRelevant även utan nyckelord", () => {
  const ev = annotate({ title: "Rutinnyhet", summary: "", region: "SE", flags: {} });
  assert.equal(ev.flags.swedenRelevant, true);
});

test("computeIndicators räknar korrekt", () => {
  const events = [
    annotate({ title: "CVE actively exploited", summary: "critical", region: "SE", source: "CERT-SE", flags: {} }),
    annotate({ title: "vanlig nyhet", summary: "", region: "INT", source: "The Hacker News", flags: {} }),
    { title: "KEV", source: "CISA KEV", region: "INT", flags: { activelyExploited: true, swedenRelevant: false, critical: false } },
  ];
  const ind = computeIndicators(events);
  assert.equal(ind.total_signals, 3);
  assert.equal(ind.actively_exploited, 2);
  assert.equal(ind.sweden_acute, 1);
  assert.equal(ind.kev_recent, 1);
});

test("riskScore drivs av svensk akut exponering", () => {
  const low = riskScore({ sweden_acute: 0, actively_exploited: 2, critical: 0, kev_recent: 2, authority_alerts: 2 });
  const high = riskScore({ sweden_acute: 2, actively_exploited: 2, critical: 0, kev_recent: 2, authority_alerts: 2 });
  assert.ok(high > low);
  assert.ok(riskScore({ sweden_acute: 9, actively_exploited: 9, critical: 9, kev_recent: 9, authority_alerts: 9 }) <= 100);
});

test("heuristicLevel är konservativ", () => {
  assert.equal(heuristicLevel({ sweden_acute: 1 }), "gul");
  assert.equal(heuristicLevel({ sweden_acute: 0, actively_exploited: 20 }), "grön");
});

test("detectAnomaly kräver underlag och fångar spikar", () => {
  assert.equal(detectAnomaly([10, 12], 90).active, false); // för lite underlag
  const stable = [10, 12, 11, 9, 10, 13, 11, 10, 12, 11];
  assert.equal(detectAnomaly(stable, 12).active, false); // normalt
  assert.equal(detectAnomaly(stable, 80).active, true);  // spik
});

test("applyLevelPolicy: gul kräver svensk-akut, röd kräver flera", () => {
  // Utan svensk-akut: allt klampas till grön
  assert.equal(applyLevelPolicy("gul", { sweden_acute: 0 }).level, "grön");
  assert.equal(applyLevelPolicy("röd", { sweden_acute: 0 }).level, "grön");
  assert.ok(applyLevelPolicy("gul", { sweden_acute: 0 }).note);
  // En svensk-akut: gul ok, röd klampas till gul
  assert.equal(applyLevelPolicy("gul", { sweden_acute: 1 }).level, "gul");
  assert.equal(applyLevelPolicy("röd", { sweden_acute: 1 }).level, "gul");
  // Flera svensk-akuta: röd ok
  assert.equal(applyLevelPolicy("röd", { sweden_acute: 2 }).level, "röd");
  // Grön passerar alltid utan not
  const g = applyLevelPolicy("grön", { sweden_acute: 5 });
  assert.equal(g.level, "grön");
  assert.equal(g.note, null);
});

test("applyHysteresis: snabbt upp, långsamt ner", () => {
  // Höjning slår igenom direkt
  assert.equal(applyHysteresis("röd", "grön", 0).level, "röd");
  // Oförändrat: ingen pending, streak nollställs
  const same = applyHysteresis("gul", "gul", 2);
  assert.equal(same.level, "gul");
  assert.equal(same.streak, 0);
  // Sänkning: hålls kvar tills 3 bekräftelser
  const d1 = applyHysteresis("grön", "gul", 0);
  assert.equal(d1.level, "gul");
  assert.equal(d1.streak, 1);
  assert.deepEqual(d1.pending, { to: "grön", confirmations: 1, required: 3 });
  const d2 = applyHysteresis("grön", "gul", d1.streak);
  assert.equal(d2.level, "gul");
  const d3 = applyHysteresis("grön", "gul", d2.streak);
  assert.equal(d3.level, "grön"); // tredje körningen: sänkningen slår igenom
  assert.equal(d3.streak, 0);
  assert.equal(d3.pending, null);
  // Okänd hanteras utan hysteres
  assert.equal(applyHysteresis("okänd", "gul", 0).level, "okänd");
});

test("annotate flaggar incident (bekräftat angrepp)", () => {
  const ev = annotate({ title: "Skadliga npm-paket", summary: "Ett koordinerat leveranskedjeangrepp har drabbat separata repon.", region: "SE", flags: {} });
  assert.equal(ev.flags.incident, true);
  assert.equal(ev.flags.swedenRelevant, true);
  const ind = computeIndicators([{ ...ev, source: "CERT-SE" }]);
  assert.equal(ind.sweden_acute, 1); // incident räknas som akut
});

test("computeLevelSince hittar början på nuvarande nivåstreak", () => {
  const hist = [
    { t: "2026-07-15T00:00:00Z", level: "grön" },
    { t: "2026-07-15T01:00:00Z", level: "gul" },
    { t: "2026-07-15T02:00:00Z", level: "gul" },
  ];
  assert.equal(computeLevelSince(hist, "gul"), "2026-07-15T01:00:00Z");
});
