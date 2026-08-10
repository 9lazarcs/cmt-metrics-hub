# CMT Metrics Hub

**Phase 2 — Automated Metrics Dashboard for IBM EngageSupport (NAUS-CFCT-SW-2)**

> Companion app to the **EngageSupport Extractor** (Phase 1, port 3000).  
> Ingests raw XLSX exports, transforms them into team performance metrics, and serves a professional IBM Carbon dark-theme dashboard.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: engagesupport-extractor (port 3000)                   │
│  → Downloads request_view_*.xlsx from EngageSupport             │
│  → Saves to OUTPUT_DIR                                          │
└────────────────────────┬────────────────────────────────────────┘
                         │  (XLSX files)
┌────────────────────────▼────────────────────────────────────────┐
│  Phase 2: cmt-metrics-hub (port 3001)         ← YOU ARE HERE   │
│                                                                  │
│  XLSX → Parser → Raw Tables → Transform → Derived Tables       │
│                                  ↓                              │
│  SQLite DB (data/cmt_metrics.db)                                │
│                                  ↓                              │
│  Express REST API → Carbon Dark Frontend Dashboard              │
└─────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 20.0.0 |
| npm | ≥ 10.x |
| Phase 1 extractor | Running and authenticated (for NPS automation) |

---

## Quick Start

```bash
# 1. Navigate to this directory
cd cmt-metrics-hub

# 2. Install dependencies
npm install

# 3. Copy and configure environment
cp .env.example .env
# Edit .env — set OUTPUT_DIR to your Metrics folder

# 4. Start the development server
npm run dev

# 5. Open the dashboard
open http://localhost:3001
```

---

## Environment Variables (`.env`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Express server port |
| `DB_PATH` | `./data/cmt_metrics.db` | SQLite database path |
| `INPUT_DIR` | `OUTPUT_DIR` value | Directory to auto-scan for new XLSX files on startup |
| `OUTPUT_DIR` | OneDrive Metrics folder | Where Phase 1 saves extracted files |
| `SESSION_PATH` | `./session/state.json` | Phase 1 Playwright session (for NPS automation reuse) |
| `IBM_EMAIL` | — | IBM w3id email (only needed for NPS automation fallback auth) |
| `IBM_PASSWORD` | — | IBM w3id password (only needed for NPS automation fallback auth) |
| `HEADLESS` | `false` | Browser visibility for NPS automation |
| `MFA_TIMEOUT_SECONDS` | `120` | Seconds to wait for IBM Verify push approval |
| `SQUAD_GROUP` | `NAUS-CFCT-SW-2` | EngageSupport squad filter for NPS extraction |
| `CRON_SCHEDULE` | `0 8 * * *` | Cron expression for scheduled auto-ingest (daily 8am) |
| `LOG_LEVEL` | `info` | Winston log level: `debug` / `info` / `warn` / `error` |

---

## Data Pipeline

### Step 1 — Extract (Phase 1)
Run the Phase 1 extractor to download `request_view_*.xlsx` from EngageSupport:
```
http://localhost:3000 → "Extract Latest Data"
```
Files are saved to your configured `OUTPUT_DIR` (e.g. `/Users/jojielazarte/Library/CloudStorage/OneDrive-IBM/Metrics/`).

### Step 2 — Ingest
**Option A — Auto-ingest (on startup):**  
The hub scans `INPUT_DIR` on every startup and ingests any new XLSX files automatically.

**Option B — Manual ingest via UI:**
1. Open `http://localhost:3001` → **Ingest Data** page
2. Enter the full path to the XLSX file
3. Click **Ingest**

**Option C — API:**
```bash
curl -X POST http://localhost:3001/api/ingest/request-view \
  -H "Content-Type: application/json" \
  -d '{"filePath":"/path/to/request_view_2026-08-06T00_56_22.036Z.xlsx"}'
```

### Step 3 — NPS Data
**Option A — Automated extraction (recommended):**
1. Ensure Phase 1 session is active (run Phase 1 extractor first to authenticate)
2. In CMT Metrics Hub → **Ingest Data** → **Automated NPS Extraction**
3. Optionally enter a Report Period (e.g. `2026-Q2`)
4. Click **Extract & Ingest NPS**

**Option B — Manual:**
1. Manually download the NPS XLSX from:
   `engage-support.ibm.com` → Monitoring & Insights → OpDashboard → Sales Engagement Feedback → By Geo → Export
2. Save to your Metrics directory
3. Ingest via UI or API:
```bash
curl -X POST http://localhost:3001/api/ingest/nps \
  -H "Content-Type: application/json" \
  -d '{"filePath":"/path/to/Export_Details_SalesFB.xlsx"}'
```

---

## Dashboard Features

| Page | Contents |
|---|---|
| **Dashboard** | KPI tiles (Volume, Weighted, NPS Score, Participation Rate) + Monthly trend charts + Member breakdown |
| **Volume** | Full weighted volume table with pagination (Sub-Process, Complexity, Weight per request) |
| **M&I** | Monitoring & Insights table (CT Days/Hours, Funnel/Squad Hours, Is Backdated) |
| **NPS** | NPS donut chart + score trend + individual response table |
| **By Member** | Per-member summary: Volume, Weighted Volume, NPS Score, Participation % |
| **Ingest Data** | Manual ingest panel + NPS automation trigger + ingestion history + live log |
| **Admin** | Manage squad member email→name mapping + view reason codes |

---

## REST API Reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server + DB health check |
| GET | `/api/status` | Row counts per table |
| GET | `/api/ingestion/history` | Ingestion log |
| POST | `/api/ingest/request-view` | Ingest Request View XLSX (`{filePath}`) |
| POST | `/api/ingest/nps` | Ingest NPS Export XLSX (`{filePath}`) |
| POST | `/api/nps/extract` | Trigger Playwright NPS automation (`{reportPeriod?}`) |
| GET | `/api/metrics/kpi` | Dashboard KPI totals |
| GET | `/api/metrics/weighted-volume` | WV rows (`?month=Jan&member=...&limit=50`) |
| GET | `/api/metrics/mi` | M&I rows |
| GET | `/api/metrics/nps` | NPS rows |
| GET | `/api/metrics/by-member` | Per-member summary |
| GET | `/api/metrics/by-month` | Per-month summary |
| GET | `/api/admin/squad-members` | List squad members |
| POST | `/api/admin/squad-members` | Add squad member |
| GET | `/api/admin/reason-codes` | List reason codes |
| GET | `/api/export` | Generate + download XLSX export |
| GET | `/api/logs` | In-memory log tail |
| GET | `/events` | Server-Sent Events stream |

---

## Transformation Rules

### Weighted Volume (`weighted_volume` table)
| Computed Column | Source |
|---|---|
| `sub_process`, `process`, `complexity`, `weight` | First token of `Last Comment` → lookup in `reason_codes` table |
| `team_member` | `assign_to` email → lookup in `squad_members` table |
| `month` | Derived from `close_date` (e.g. `"Jul"`) |

### M&I Data (`mi_data` table)
| Computed Column | Formula |
|---|---|
| `ct_hours` | Hours from `submission_date` to `close_date` |
| `ct_days` | `ct_hours / 24` |
| `ct_in_days` | Bucketed: `<=1`, `>1,<=3`, `>3,<=5`, `>5,<=10`, `>10` |
| `funnel_hours` | Hours from submission to `latest_update` |
| `squad_hours` | Hours from `latest_update` to close |
| `is_backdated` | `'Y'` if `submission_date >= close_date` |
| `ym_open/close`, `yq_open/close` | `YYYY-MM` / `YYYY-Qn` formatted dates |
| `week_close` | ISO week `YYYY-Www` |

### NPS Data (`nps_data` table)
| Computed Column | Source |
|---|---|
| `definition` | `Promoters` (rating ≥ 9), `Passive` (7–8), `Detractors` (≤ 6) |
| `team_member` | `request_number` → `requests.assign_to` → `squad_members.name` |
| `month` | Derived from `rated_date` |

---

## Golden Number Validation

```bash
npm run test
```

Validates computed metrics against master file reference values:
- Grand Total Volume = **7,075**
- Grand Total Weighted = **8,080**
- NPS Promoters = **509** of **513** total

> **Note:** The sample file (`request_view_2026-08-06T00_56_22.036Z.xlsx`) contains only 1,000 rows. Full golden number match requires ingesting the complete dataset (all historical monthly exports).

---

## Project Structure

```
cmt-metrics-hub/
├── src/
│   ├── db/
│   │   ├── schema.ts           SQLite schema (10 tables)
│   │   └── seeds.ts            Squad members + reason codes seed data
│   ├── pipeline/
│   │   ├── parseRequestView.ts 61-column Request View XLSX parser
│   │   ├── parseNpsExport.ts   38-column NPS Export XLSX parser
│   │   ├── transform.ts        Weighted Volume + M&I + NPS transformation engine
│   │   ├── ingest.ts           Ingestion pipeline (parse → insert → deduplicate → transform)
│   │   └── exportXlsx.ts       Master-file-compatible multi-sheet XLSX export
│   ├── automation/
│   │   └── npsExtractor.ts     Playwright automation for OpDashboard NPS export
│   ├── api/
│   │   └── server.ts           Express REST API (18 endpoints + SSE)
│   ├── utils/
│   │   └── logger.ts           Winston logger (daily rotating + SSE bridge)
│   ├── test/
│   │   └── validateMetrics.ts  Golden number validation
│   └── index.ts                Entry point
├── frontend/
│   ├── index.html              IBM Carbon dark-theme SPA
│   ├── styles.css              Carbon 10 dark CSS tokens
│   └── app.js                  Dashboard JS (Chart.js + REST API calls + SSE)
├── data/
│   ├── cmt_metrics.db          SQLite database (auto-created)
│   └── exports/                Generated XLSX exports
├── logs/                       Daily rotating log files
├── session/                    Phase 1 Playwright session state (reused for NPS)
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Sharing with a Windows Colleague

A single `.exe` is not possible because `better-sqlite3` is a native C++ addon
that must be compiled on the target OS, and `playwright` bundles a
platform-specific Chromium binary. Instead, use the automated installer:

### On your Mac — create the zip

```bash
./package-for-windows.sh
# → produces: cmt-metrics-hub-windows.zip
```

Send `cmt-metrics-hub-windows.zip` via OneDrive / email.

### On their Windows machine — 3 steps

| Step | Action |
|---|---|
| 1 | Install **Node.js 20 LTS** from https://nodejs.org (Windows installer, click Next) |
| 2 | Unzip to any folder, e.g. `C:\cmt-metrics-hub\` |
| 3 | Double-click **`windows\install.bat`** |

`install.bat` will:
- Verify Node.js version
- Run `npm install` (recompiles `better-sqlite3` for Windows)
- Offer to install Playwright/Chromium for automated extraction
- Create `.env` from template
- Offer to launch the app immediately

**Daily use after install:**

| Action | File |
|---|---|
| Start dashboard | Double-click `windows\start.bat` |
| Stop server | Double-click `windows\stop.bat` (or Ctrl+C) |
| Open dashboard | http://localhost:3001 |

### What works without IBM credentials

| Feature | Works? |
|---|---|
| View all dashboard data | ✅ (DB snapshot included) |
| Upload XLSX manually | ✅ |
| Automated ES extraction | ❌ Needs their own IBM w3id + Playwright |
| Automated NPS extraction | ❌ Needs their own IBM w3id |
| Resolve NPS owners | ❌ Needs their own IBM w3id |

To update their data: export a fresh `data/cmt_metrics.db` from your machine
and drop it in their `data/` folder, then restart.

---

## Scripts

```bash
npm run dev     # Start with ts-node-dev (hot reload)
npm run build   # Compile TypeScript → dist/
npm run start   # Run compiled dist/index.js
npm run test    # Golden number validation
```

**Mac packaging:**
```bash
./package-for-windows.sh   # Build zip for Windows distribution
```

---

## Security

- Credentials stored only in `.env` (excluded from git via `.gitignore`)
- No credentials logged or displayed in UI
- Session file (`session/state.json`) also excluded from git
- All IBM w3id auth logic in `src/automation/npsExtractor.ts` with inline comments

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `DB not found` | Ensure `data/` directory is writable. DB is auto-created. |
| `Session expired` | Run Phase 1 extractor (`localhost:3000`) and authenticate first |
| `No reason code matched` | Last Comment may not start with a known code token. Check Admin → Reason Codes |
| `Team member unresolved` | `assign_to` email not in squad_members. Add via Admin → Squad Members |
| NPS team member all `—` | Request numbers from NPS export don't match request view. Ensure both datasets cover same period |
| Port conflict | Change `PORT` in `.env` |
