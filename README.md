# ⚡ Stormvarning

**Tidigt varningssystem för storskaliga cyberattacker mot Sverige.**

Stormvarning är en helt statisk webbapp (ren HTML/CSS/JS, ingen backend) som
sammanställer **öppna** hotsignaler från svenska myndigheter, CISA:s katalog över
aktivt utnyttjade sårbarheter (KEV), internationella CERT:er och säkerhetsnyheter,
beräknar deterministiska indikatorer och låter en språkmodell göra en preliminär
lägesbedömning på en trestegsskala:

| Nivå | Betydelse |
| --- | --- |
| 🟢 **Grön** | Normalläge – inga tecken på förhöjt hot. |
| 🟡 **Gul** | Förhöjt läge – konkreta indikatorer som kan påverka svenska mål. |
| 🔴 **Röd** | Allvarligt läge – pågående eller nära förestående storskalig attack. |

> ⚠️ **Ansvarsfriskrivning:** Stormvarning är ett automatiserat stödverktyg och
> **ingen officiell källa**. Bedömningen görs av en språkmodell utifrån öppna
> RSS-flöden och kan ha fel. Vid en pågående incident – följ alltid
> [CERT-SE](https://www.cert.se) och [MSB](https://www.msb.se).

## Så fungerar det

```
┌─────────────────────────┐     ┌──────────────┐     ┌───────────────┐
│ GitHub Actions (var 30m)│ --> │  MiniMax API │ --> │  data.json    │
│  hämtar RSS-hotsignaler  │     │  bedömer läge│     │  (committas)  │
└─────────────────────────┘     └──────────────┘     └───────┬───────┘
                                                             │
                                              ┌──────────────▼──────────────┐
                                              │  GitHub Pages (index.html)   │
                                              │  läser data.json, auto-refresh│
                                              └──────────────────────────────┘
```

1. Ett schemalagt GitHub Actions-jobb (`.github/workflows/update-threat-level.yml`)
   kör var 30:e minut.
2. `scripts/analyze.mjs` hämtar och normaliserar öppna signaler från flera källor
   (se nedan), flaggar dem deterministiskt (Sverige-relevans, aktivt utnyttjade,
   kritiska) och beräknar **indikatorer** + ett **riskindex (0–100)**. Underlaget
   skickas till **MiniMax** för bedömning.
3. Resultatet (nivå, lägesbild, indikatorer, riskindex, signaler, källhälsa) skrivs
   till `data.json`, och en historikpunkt läggs till `history.json` – båda committas.
4. Frontenden (`index.html` + `app.js`) läser filerna och uppdaterar sig själv var
   3:e minut. Den visar hotnivå, riskindex, tripwires, en trendtidslinje, signallogg
   och källhälsa. Sidan är även en installbar PWA (offline-skal via `sw.js`).

Om MiniMax inte är tillgänglig används en **konservativ deterministisk heuristik** som
fallback (larmar bara vid en akut signal med svensk koppling) – systemet är aldrig tyst.

### Källor

| Källa | Region | Typ |
| --- | --- | --- |
| CERT-SE | 🇸🇪 | RSS |
| MCF (Myndigheten för civilt försvar) | 🇸🇪 | RSS (cyberfiltrerad) |
| Krisinformation.se | 🇸🇪 | JSON (cyberfiltrerad) |
| CISA KEV (aktivt utnyttjade sårbarheter) | 🌐 | JSON |
| CISA advisories | 🌐 | RSS |
| NCSC-UK | 🌐 | RSS |
| The Hacker News, BleepingComputer | 🌐 | RSS |

**MiniMax-nyckeln ligger i GitHub Secrets och exponeras aldrig i klientkoden.**

## Kom igång

### 1. Lägg till API-nyckeln som secret

I repot: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Krävs | Beskrivning |
| --- | --- | --- |
| `MINIMAX_API_KEY` | Ja | Din MiniMax API-nyckel. |
| `MINIMAX_MODEL` | Nej | Modellnamn (default `MiniMax-Text-01`). |
| `MINIMAX_BASE_URL` | Nej | Bas-URL (default `https://api.minimaxi.chat`). |
| `MINIMAX_GROUP_ID` | Nej | GroupId om ditt MiniMax-konto kräver det. |

Utan `MINIMAX_API_KEY` körs jobbet ändå och använder den deterministiska heuristiken
som fallback (indikatorer, riskindex och signallogg fylls i som vanligt).

### 2. Aktivera GitHub Pages

Två alternativ:

- **Via Actions (rekommenderas)** – `.github/workflows/pages.yml` deployar automatiskt
  vid varje push till `main`. Gå till **Settings → Pages** och välj *Source: GitHub Actions*.
- **Via branch** – enklare men kräver ingen Actions-deploy: **Settings → Pages →
  Deploy from a branch → `main` / `(root)`**. Committade `data.json`-uppdateringar
  publiceras då automatiskt.

### 3. Kör första analysen

Gå till **Actions → Uppdatera hotnivå → Run workflow** för att generera den första
riktiga lägesbilden direkt (annars sker det vid nästa schemalagda körning).

## E-postprenumeration (valfritt)

Besökare kan prenumerera och få ett mejl **endast när hotnivån höjs** till gul eller röd
– aldrig vid normalläge eller var 30:e minut. Eftersom sidan saknar backend sköts
adresser och utskick av [Buttondown](https://buttondown.com) (gratisnivå finns), som även
hanterar bekräftelse (dubbel opt-in) och avregistrering – GDPR-vänligt.

Så här aktiverar du det:

1. Skapa ett konto på Buttondown och notera ditt **användarnamn**.
2. I `index.html`, ersätt platshållaren `DITT-ANVANDARNAMN` (förekommer i
   `<form action=...>` och `onsubmit=...`) med ditt användarnamn.
3. Skapa en API-nyckel i Buttondown (**Settings → Programming → API**) och lägg den som
   secret `BUTTONDOWN_API_KEY` i repot (**Settings → Secrets and variables → Actions**).
4. Valfritt: sätt secret `SITE_URL` till sajtens publika adress så länken i mejlet blir rätt
   (default `https://<användare>.github.io/stormvarning/`).

Anmälningsformuläret postar direkt till Buttondown – **ingen API-nyckel finns i
klientkoden**. Utskicket sker från GitHub Actions-jobbet: när `scripts/analyze.mjs`
upptäcker en höjning (t.ex. grön→gul eller gul→röd) anropas Buttondowns API
(`POST /v1/emails` med `status: about_to_send`). Nivån vi senast larmade om sparas i
`data.json` (`notified_level`) så samma höjning inte mejlas ut flera gånger.

## Lokal körning

```bash
# Generera data.json (använder MINIMAX_API_KEY om satt, annars fallback)
MINIMAX_API_KEY=din-nyckel node scripts/analyze.mjs

# Servera statiskt och öppna i webbläsaren
python3 -m http.server 8000
# → http://localhost:8000
```

Kräver **Node 20+** (för inbyggda `fetch`). Inga npm-beroenden.

## Anpassa källor

Redigera listan `SOURCES` överst i [`scripts/analyze.mjs`](scripts/analyze.mjs).
Varje post har `name`, `url`, `region` (`SE`/`INT`), `weight` (`hög`/`medel`) och
`type` (`rss`, `kev` eller `krisinfo`). Sätt `cyberFilter: true` för källor med
blandat innehåll (bara cyberrelevanta poster behålls). Vikt och taggar skickas med
till modellen så att myndighetskällor och akuta signaler väger tyngst.

## Filöversikt

| Fil | Roll |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | Statisk frontend (operatörskonsol). |
| `manifest.webmanifest`, `sw.js`, `icon.svg` | PWA – installbar/offline. |
| `data.json` | Genererad lägesbild (committas av jobbet). |
| `history.json` | Trendhistorik (nivå + riskindex per körning). |
| `scripts/analyze.mjs` | Hämtar signaler, beräknar indikatorer, kör MiniMax, skriver filerna. |
| `.github/workflows/update-threat-level.yml` | Cron var 30:e min. |
| `.github/workflows/pages.yml` | Deploy till GitHub Pages (även efter varje analys). |
