/* Stormvarning – frontend
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
  var LEVEL_LABELS = {
    gron: "Grön – låg hotnivå",
    gul: "Gul – förhöjd hotnivå",
    rod: "Röd – allvarlig hotnivå",
    okand: "Okänd – ingen aktuell analys"
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
    el.className = "status-dot" + (state ? " " + state : "");
    $("connection-text").textContent = text;
  }

  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    try {
      return new Intl.DateTimeFormat("sv-SE", {
        dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Stockholm"
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

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function renderEvents(events) {
    var ul = $("events");
    if (!Array.isArray(events) || events.length === 0) {
      ul.innerHTML = '<li class="empty">Inga hotsignaler att visa just nu.</li>';
      $("event-count").textContent = "";
      return;
    }
    $("event-count").textContent = events.length;
    ul.innerHTML = events.map(function (ev) {
      var title = escapeHtml(ev.title || "Namnlös händelse");
      var titleHtml = ev.link
        ? '<a href="' + escapeHtml(ev.link) + '" target="_blank" rel="noopener">' + title + "</a>"
        : "<span>" + title + "</span>";
      var src = ev.source ? '<span class="src">' + escapeHtml(ev.source) + "</span>" : "";
      var when = ev.date ? "<span>" + escapeHtml(fmtDateTime(ev.date)) + "</span>" : "";
      var summary = ev.summary ? '<p class="event-summary">' + escapeHtml(ev.summary) + "</p>" : "";
      return '<li class="event">' + titleHtml +
        '<div class="event-meta">' + src + when + "</div>" + summary + "</li>";
    }).join("");
  }

  function render(data) {
    var level = normLevel(data.level);
    document.body.setAttribute("data-level", level);

    $("level-label").textContent = data.level_label || LEVEL_LABELS[level];
    $("summary").textContent = data.summary || "Ingen lägesbild tillgänglig.";
    $("reasoning").textContent = data.reasoning || "—";
    $("updated").textContent = fmtDateTime(data.updated) +
      (fmtRelative(data.updated) ? " (" + fmtRelative(data.updated) + ")" : "");
    $("next-update").textContent = data.next_update ? fmtDateTime(data.next_update) : "—";
    $("model").textContent = data.model || "—";

    var sources = Array.isArray(data.sources) && data.sources.length
      ? "Källor: " + data.sources.join(" · ")
      : "";
    $("sources").textContent = sources;

    renderEvents(data.events);

    // Blinka larmkortet om lägesbilden är ny
    if (lastUpdated && data.updated && data.updated !== lastUpdated) {
      var card = $("alert-card");
      card.classList.remove("flash");
      void card.offsetWidth; // reflow för att kunna spela om
      card.classList.add("flash");
    }
    lastUpdated = data.updated || lastUpdated;

    document.title = "Stormvarning – " + (LEVEL_LABELS[level] || "hotnivå");
  }

  function load() {
    // cache-buster så vi alltid får senaste committade data.json
    return fetch("data.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        render(data);
        setConnection("ok", "Uppdaterad " + (fmtRelative(data.updated) || "nyss"));
      })
      .catch(function (err) {
        console.error("Kunde inte läsa data.json:", err);
        setConnection("err", "Kunde inte hämta data");
        if (!lastUpdated) {
          $("level-label").textContent = "Data saknas";
          $("summary").textContent =
            "Ingen lägesbild kunde läsas in. Den genereras av ett schemalagt jobb var 30:e minut.";
        }
      });
  }

  // Initial laddning + periodisk uppdatering
  load();
  setInterval(load, REFRESH_MS);

  // Hämta direkt igen när fliken blir aktiv (om det gått en stund)
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") load();
  });
})();
