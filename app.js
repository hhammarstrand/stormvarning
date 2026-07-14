/* Stormvarning – frontend (operatörskonsol)
 * Läser data.json (genereras av GitHub Actions) och renderar lägesbilden.
 * Ingen backend: helt statiskt, uppdaterar sig själv med jämna mellanrum.
 */
(function () {
  "use strict";

  var REFRESH_MS = 3 * 60 * 1000; // hämta om data.json var 3:e minut
  var LEVELS = {
    "grön": "gron", "gron": "gron", "green": "gron",
    "gul": "gul", "yellow": "gul",
    "röd": "rod", "rod": "rod", "red": "rod"
  };
  var LEVEL_WORD = { gron: "GRÖN", gul: "GUL", rod: "RÖD", okand: "OKÄND" };
  var LEVEL_DESC = {
    gron: "Låg hotnivå",
    gul: "Förhöjd hotnivå",
    rod: "Allvarlig hotnivå",
    okand: "Ingen aktuell analys"
  };

  var lastUpdated = null;

  function $(id) { return document.getElementById(id); }

  function normLevel(raw) {
    if (!raw) return "okand";
    var key = String(raw).trim().toLowerCase();
    return LEVELS[key] || "okand";
  }

  function setConnection(state, text) {
    var el = $("connection");
    el.className = "live" + (state ? " " + state : "");
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
    } catch (e) {
      return d.toLocaleString("sv-SE");
    }
  }

  function fmtRelative(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var diff = Math.round((Date.now() - d.getTime()) / 60000); // minuter
    if (diff < 1) return "just nu";
    if (diff < 60) return "för " + diff + " min sedan";
    var h = Math.round(diff / 60);
    if (h < 24) return "för " + h + " tim sedan";
    var dd = Math.round(h / 24);
    return "för " + dd + " dygn sedan";
  }

  // Kompakt loggtid: HH:MM om samma dygn (Stockholm), annars DD/MM.
  function fmtLogTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return "—";
    try {
      var tz = "Europe/Stockholm";
      var today = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      var same = today.format(d) === today.format(new Date());
      if (same) {
        return new Intl.DateTimeFormat("sv-SE", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
      }
      var p = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, day: "2-digit", month: "2-digit" }).formatToParts(d);
      var day = p.find(function (x) { return x.type === "day"; }).value;
      var mon = p.find(function (x) { return x.type === "month"; }).value;
      return day + "/" + mon;
    } catch (e) {
      return d.toISOString().slice(11, 16);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderEvents(events) {
    var tb = $("events");
    if (!Array.isArray(events) || events.length === 0) {
      tb.innerHTML = '<tr class="log-empty"><td colspan="3">Inga signaler att visa just nu.</td></tr>';
      $("event-count").textContent = "";
      return;
    }
    $("event-count").textContent = "[" + events.length + "]";
    tb.innerHTML = events.map(function (ev) {
      var time = '<td class="c-time">' + escapeHtml(fmtLogTime(ev.date)) + "</td>";
      var src = '<td class="c-src"><span class="src">' + escapeHtml(ev.source || "—") + "</span></td>";
      var title = escapeHtml(ev.title || "Namnlös signal");
      var titleHtml = ev.link
        ? '<a href="' + escapeHtml(ev.link) + '" target="_blank" rel="noopener">' + title + "</a>"
        : "<span>" + title + "</span>";
      var sum = ev.summary ? '<span class="ev-sum">' + escapeHtml(ev.summary) + "</span>" : "";
      return "<tr>" + time + src + '<td class="c-title">' + titleHtml + sum + "</td></tr>";
    }).join("");
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
    $("next-update").textContent = data.next_update ? fmtDateTime(data.next_update) : "—";
    $("model").textContent = data.model || "ingen (fallback)";
    $("sources").textContent = Array.isArray(data.sources) && data.sources.length
      ? data.sources.join(" · ")
      : "—";

    renderEvents(data.events);

    // Blinka nivåmodulen om lägesbilden är ny
    if (lastUpdated && data.updated && data.updated !== lastUpdated) {
      var card = $("alert-card");
      card.classList.remove("flash");
      void card.offsetWidth; // reflow för att kunna spela om
      card.classList.add("flash");
    }
    lastUpdated = data.updated || lastUpdated;

    document.title = "Stormvarning – " + (LEVEL_WORD[level] || "OKÄND") + " hotnivå";
  }

  function load() {
    return fetch("data.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        render(data);
        setConnection("ok", "ONLINE");
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
  }

  // Live-klocka (Europe/Stockholm)
  function tick() {
    var el = $("clock");
    if (!el) return;
    try {
      el.textContent = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", second: "2-digit"
      }).format(new Date());
    } catch (e) {
      el.textContent = new Date().toTimeString().slice(0, 8);
    }
  }
  tick();
  setInterval(tick, 1000);

  // Initial laddning + periodisk uppdatering
  load();
  setInterval(load, REFRESH_MS);

  // Hämta direkt igen när fliken blir aktiv
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") load();
  });
})();
