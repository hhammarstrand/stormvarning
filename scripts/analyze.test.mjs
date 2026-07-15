/**
 * Tester för den deterministiska kärnan i analyze.mjs.
 * Kör med:  node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLevel, levelRank, riskScore, heuristicLevel,
  computeIndicators, annotate, detectAnomaly, computeLevelSince,
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

test("computeLevelSince hittar början på nuvarande nivåstreak", () => {
  const hist = [
    { t: "2026-07-15T00:00:00Z", level: "grön" },
    { t: "2026-07-15T01:00:00Z", level: "gul" },
    { t: "2026-07-15T02:00:00Z", level: "gul" },
  ];
  assert.equal(computeLevelSince(hist, "gul"), "2026-07-15T01:00:00Z");
});
