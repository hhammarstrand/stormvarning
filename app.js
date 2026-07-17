/* Stormvarning – frontend (operatörskonsol)
 * Läser data.json + history.json (genereras av GitHub Actions) och renderar
 * lägesbilden. Ingen backend: helt statiskt, uppdaterar sig själv.
 */
(function () {
  "use strict";

  var REFRESH_MS = 3 * 60 * 1000;
  var LEVELS = {
    "grön": "gron", "gron": "gron", "green": "gron",
    "gul": "gul", "yellow": "gul",
    "röd": "rod", "rod": "rod", "red": "rod"
  };
  var LEVEL_WORD = { gron: "GRÖN", gul: "GUL", rod: "RÖD", okand: "OKÄND" };
  var LEVEL_DESC = {
    gron: "Låg hotnivå", gul: "Förhöjd hotnivå",
    rod: "Allvarlig hotnivå", okand: "Ingen aktuell analys"
  };

  var lastUpdated = null;

  function $(id) { return document.getElementById(id); }

  function normLevel(raw) {
    if (!raw) return "okand";
    return LEVELS[String(raw).trim().toLowerCase()] || "okand";
  }

  function setConnection(state, text) {
    $("connection").className = "live" + (state ? " " + state : "");
    $("connection-text").textContent = text;
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    try {
      return new Intl.DateTimeFormat("sv-SE", {
        dateStyle: "short", timeStyle: "short", timeZone: "Europe/Stockholm"
      }).format(d);
    } catch (e) { return d.toLocaleString("sv-SE"); }
  }

  function fmtRelative(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var diff = Math.round((Date.now() - d.getTime()) / 60000);
    if (diff < 1) return "just nu";
    if (diff < 60) return "för " + diff + " min sedan";
    var h = Math.round(diff / 60);
    if (h < 24) return "för " + h + " tim sedan";
    return "för " + Math.round(h / 24) + " dygn sedan";
  }

  function fmtLogTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    try {
      var tz = "Europe/Stockholm";
      var day = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      if (day.format(d) === day.format(new Date())) {
        return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
      }
      var p = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, day: "2-digit", month: "2-digit" }).formatToParts(d);
      return p.find(function (x) { return x.type === "day"; }).value + "/" + p.find(function (x) { return x.type === "month"; }).value;
    } catch (e) { return d.toISOString().slice(11, 16); }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function num(n) { return typeof n === "number" ? n : 0; }

  function fmtDuration(iso) {
    if (!iso) return "";
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (isNaN(mins) || mins < 1) return "nyss";
    if (mins < 60) return mins + " min";
    var h = Math.floor(mins / 60);
    if (h < 48) return h + " tim";
    return Math.floor(h / 24) + " dygn";
  }

  function renderAnomaly(data) {
    var el = $("anomaly");
    if (!el) return;
    var a = data.anomaly;
    if (a && a.active) {
      $("anomaly-text").textContent =
        "Ovanligt hög aktivitet — riskindex " + num(data.score) +
        " mot baslinje " + num(a.baseline) + " (+" + num(a.delta) + "). Läget kan vara på väg att förändras.";
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  function renderIndicators(ind) {
    ind = ind || {};
    var keys = ["sweden_acute", "actively_exploited", "critical", "kev_recent", "sweden_relevant", "authority_alerts"];
    keys.forEach(function (k) {
      var el = $("tw-" + k);
      if (el) el.textContent = num(ind[k]);
      var tile = document.querySelector('.tw[data-key="' + k + '"]');
      if (!tile) return;
      tile.classList.remove("hot", "warm");
      var v = num(ind[k]);
      if (k === "sweden_acute" && v > 0) tile.classList.add("hot");
      else if ((k === "actively_exploited" || k === "critical" || k === "kev_recent") && v > 0) tile.classList.add("warm");
    });
  }

  function renderScore(score) {
    var s = Math.max(0, Math.min(100, num(score)));
    $("score-num").textContent = s;
    $("score-fill").style.width = s + "%";
    $("score-kv").textContent = s + " / 100";
  }

  function renderHealth(health) {
    var ul = $("health");
    if (!Array.isArray(health) || !health.length) {
      ul.innerHTML = '<li class="health-empty">Ingen källinformation.</li>';
      $("health-count").textContent = "";
      return;
    }
    var up = health.filter(function (h) { return h.ok; }).length;
    $("health-count").textContent = up + "/" + health.length + " uppe";
    ul.innerHTML = health.map(function (h) {
      return '<li class="' + (h.ok ? "ok" : "down") + '"><span class="h-dot"></span>' +
        '<span>' + escapeHtml(h.name) + "</span>" +
        '<span class="h-count">' + (h.ok ? num(h.count) : " nere") + "</span></li>";
    }).join("");
  }

  var allEvents = [];
  var activeFilter = null; // tripwire-nyckel eller null = visa allt

  // Källor som räknas som myndigheter (samma lista som analysmotorn).
  var AUTHORITY = { "CERT-SE": 1, "MCF": 1, "Krisinformation": 1, "CISA": 1, "CISA KEV": 1, "NCSC-UK": 1 };

  var FILTERS = {
    sweden_acute: {
      label: "SVENSK AKUT",
      test: function (e) { var f = e.flags || {}; return f.swedenRelevant && (f.activelyExploited || f.critical || f.incident); }
    },
    actively_exploited: { label: "AKTIVT UTNYTTJADE", test: function (e) { return (e.flags || {}).activelyExploited; } },
    critical: { label: "KRITISKA", test: function (e) { return (e.flags || {}).critical; } },
    kev_recent: { label: "NYA CISA KEV", test: function (e) { return e.source === "CISA KEV"; } },
    sweden_relevant: { label: "SVERIGE-RELATERADE", test: function (e) { return (e.flags || {}).swedenRelevant; } },
    authority_alerts: { label: "MYNDIGHETSSIGNALER", test: function (e) { return AUTHORITY[e.source] === 1; } }
  };

  function renderEvents(events) {
    if (Array.isArray(events)) allEvents = events;
    var tb = $("events");
    var f = activeFilter && FILTERS[activeFilter];
    var list = f ? allEvents.filter(f.test) : allEvents;

    // Filter-chip i loggrubriken + markerad tripwire
    var chip = $("filter-chip");
    if (chip) {
      if (f) { chip.textContent = "FILTER: " + f.label + " ✕"; chip.hidden = false; }
      else chip.hidden = true;
    }
    document.querySelectorAll(".tw").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-key") === activeFilter);
    });

    if (!Array.isArray(list) || list.length === 0) {
      tb.innerHTML = '<tr class="log-empty"><td colspan="3">' +
        (f ? "Inga signaler matchar filtret." : "Inga signaler att visa just nu.") + "</td></tr>";
      $("event-count").textContent = f ? "[0/" + allEvents.length + "]" : "";
      return;
    }
    $("event-count").textContent = "[" + list.length + (f ? "/" + allEvents.length : "") + "]";
    tb.innerHTML = list.map(function (ev) {
      var f = ev.flags || {};
      var badges = "";
      if (f.swedenRelevant) badges += '<span class="badge se">SE</span>';
      if (f.activelyExploited) badges += '<span class="badge exploit">EXPLOIT</span>';
      if (f.critical) badges += '<span class="badge crit">KRIT</span>';
      var title = escapeHtml(ev.title || "Namnlös signal");
      var titleHtml = ev.link
        ? '<a href="' + escapeHtml(ev.link) + '" target="_blank" rel="noopener">' + title + "</a>"
        : "<span>" + title + "</span>";
      var sum = ev.summary ? '<span class="ev-sum">' + escapeHtml(ev.summary) + "</span>" : "";
      return "<tr>" +
        '<td class="c-time">' + escapeHtml(fmtLogTime(ev.date)) + "</td>" +
        '<td class="c-src"><span class="src" title="' + escapeHtml(ev.source || "") + '">' + escapeHtml(ev.source || "—") + "</span></td>" +
        '<td class="c-title">' + badges + titleHtml + sum + "</td></tr>";
    }).join("");
  }

  function renderTrend(history) {
    var box = $("trend");
    if (!Array.isArray(history) || history.length === 0) {
      box.innerHTML = '<div class="trend-empty">Ingen historik ännu – byggs upp var 30:e minut.</div>';
      $("trend-span").textContent = "";
      return;
    }
    var pts = history.slice(-96); // senaste ~48 tim
    box.innerHTML = pts.map(function (p) {
      var lvl = normLevel(p.level);
      var h = Math.max(6, Math.min(100, num(p.score)));
      var when = fmtDateTime(p.t);
      return '<div class="trend-bar" data-lvl="' + lvl + '" style="height:' + h + '%" ' +
        'title="' + escapeHtml(when + " · " + (LEVEL_WORD[lvl] || "?") + " · index " + num(p.score)) + '"></div>';
    }).join("");
    var first = pts[0], last = pts[pts.length - 1];
    var hours = first && last ? Math.round((new Date(last.t) - new Date(first.t)) / 3600000) : 0;
    $("trend-span").textContent = "[" + pts.length + " pkt" + (hours ? " · " + hours + " tim" : "") + "]";
  }

  function render(data) {
    var level = normLevel(data.level);
    document.body.setAttribute("data-level", level);

    $("level-word").textContent = LEVEL_WORD[level] || "OKÄND";
    $("level-desc").textContent = LEVEL_DESC[level] || LEVEL_DESC.okand;
    $("summary").textContent = data.summary || "Ingen lägesbild tillgänglig.";
    $("reasoning").textContent = data.reasoning || "—";
    $("updated").textContent = fmtDateTime(data.updated) +
      (fmtRelative(data.updated) ? "  (" + fmtRelative(data.updated) + ")" : "");
    // "Nästa" är en förhoppning – GitHubs schemaläggare kan skjuta upp körningar.
    // Har tiden passerats markerar vi det ärligt i stället för att se trasiga ut.
    var overdueMin = data.next_update
      ? Math.round((Date.now() - new Date(data.next_update).getTime()) / 60000)
      : 0;
    $("next-update").textContent = data.next_update
      ? fmtDateTime(data.next_update) + (overdueMin > 10 ? "  (försenad " + (overdueMin < 120 ? overdueMin + " min" : Math.round(overdueMin / 60) + " tim") + ")" : "")
      : "—";
    $("model").textContent = data.model || "ingen (fallback)";
    $("level-since").textContent = data.level_since
      ? fmtDateTime(data.level_since) + " (" + fmtDuration(data.level_since) + ")"
      : "—";

    // Pågående nedtrappning (hysteres): visas bara när en sänkning inväntar bekräftelse.
    var deescRow = $("deesc-row");
    if (deescRow) {
      var de = data.de_escalation;
      if (de && de.to) {
        $("deesc").textContent = "mot " + String(de.to).toUpperCase() + " (" + num(de.confirmations) + "/" + num(de.required) + " bekräftade)";
        deescRow.hidden = false;
      } else {
        deescRow.hidden = true;
      }
    }

    renderScore(data.score);
    renderIndicators(data.indicators);
    renderAnomaly(data);
    renderHealth(data.sources_health);
    renderEvents(data.events);

    if (lastUpdated && data.updated && data.updated !== lastUpdated) {
      var card = $("alert-card");
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
    }
    lastUpdated = data.updated || lastUpdated;
    document.title = "Stormvarning – " + (LEVEL_WORD[level] || "OKÄND") + " hotnivå";
  }

  function load() {
    var p1 = fetch("data.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        render(data);
        // Gammal data (>90 min) => visa FÖRDRÖJD i stället för ONLINE, så att
        // en hängande schemaläggare aldrig ser ut som ett friskt system.
        var ageMin = data.updated ? Math.round((Date.now() - new Date(data.updated).getTime()) / 60000) : null;
        if (ageMin !== null && ageMin > 90) {
          setConnection("warn", "FÖRDRÖJD " + (ageMin < 120 ? ageMin + " min" : Math.round(ageMin / 60) + " tim"));
        } else {
          setConnection("ok", "ONLINE");
        }
      })
      .catch(function (err) {
        console.error("Kunde inte läsa data.json:", err);
        setConnection("err", "OFFLINE");
        if (!lastUpdated) {
          $("level-word").textContent = "OKÄND";
          $("level-desc").textContent = "data saknas";
          $("summary").textContent =
            "Ingen lägesbild kunde läsas in. Den genereras av ett schemalagt jobb var 30:e minut.";
        }
      });

    var p2 = fetch("history.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (h) { renderTrend(h); })
      .catch(function () { renderTrend([]); });

    return Promise.all([p1, p2]);
  }

  function tick() {
    var el = $("clock");
    if (!el) return;
    try {
      el.textContent = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", second: "2-digit"
      }).format(new Date());
    } catch (e) { el.textContent = new Date().toTimeString().slice(0, 8); }
  }
  tick();
  setInterval(tick, 1000);

  load();
  setInterval(load, REFRESH_MS);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") load();
  });

  // Klickbara tripwires: filtrera signalloggen (klicka igen för att rensa)
  document.querySelectorAll(".tw").forEach(function (tile) {
    tile.addEventListener("click", function () {
      var key = tile.getAttribute("data-key");
      activeFilter = activeFilter === key ? null : key;
      renderEvents();
      if (activeFilter) {
        var block = $("events-block");
        if (block && block.scrollIntoView) block.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });
  var chipEl = $("filter-chip");
  if (chipEl) chipEl.addEventListener("click", function () { activeFilter = null; renderEvents(); });

  // PWA: registrera service worker (offline/installbar). Tyst om det inte stöds.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
})();
