/**
 * frontend/app.js
 * CMT Metrics Hub — dashboard JavaScript.
 * Communicates with the Express API on port 3001.
 * Uses Chart.js for visualisations.
 */

'use strict';

const API = '';          // same-origin (served by Express)
const PAGE_SIZE = 50;

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  currentPage:  'dashboard',
  period:       '',      // raw value from #filter-period: '', 'YYYY-MM', or 'YYYY-Q#'
  members:      new Set(), // selected team member names (multi-select)
  wvOffset:     0,
  miOffset:     0,
  npsOffset:    0,
  charts:       {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  try {
    const r = await fetch(API + path, opts);
    if (!r.ok) { const t = await r.text(); throw new Error(t || r.statusText); }
    return r.json();
  } catch (e) {
    console.error('[api]', path, e.message);
    throw e;
  }
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  if (typeof n === 'number') return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'2-digit' }); }
  catch { return iso.slice(0, 10); }
}

function el(id) { return document.getElementById(id); }

function setText(id, val) {
  const e = el(id);
  if (e) e.textContent = val;
}

function npsClass(score) {
  if (score === null || score === undefined) return '';
  return score >= 50 ? 'nps-positive' : score >= 0 ? 'nps-neutral' : 'nps-negative';
}

function definitionBadge(def) {
  const map = { Promoters: 'promoter', Detractors: 'detractor', Passive: 'passive' };
  const cls = map[def] ?? 'neutral';
  return `<span class="badge badge--${cls}">${def ?? '—'}</span>`;
}

function statusBadge(s) {
  if (!s) return '—';
  const cls = s === 'success' ? 'success' : s === 'failed' ? 'error' : 'neutral';
  return `<span class="badge badge--${cls}">${s}</span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart helpers — Carbon dark palette
// ─────────────────────────────────────────────────────────────────────────────
const COLORS = {
  blue:   '#4589ff',
  blueLight: '#78a9ff',
  green:  '#42be65',
  red:    '#ff8389',
  yellow: '#f1c21b',
  purple: '#be95ff',
  teal:   '#08bdba',
};

const CHART_DEFAULTS = {
  animation: { duration: 400 },
  plugins: {
    legend: { labels: { color: '#8b93a7', font: { family: 'IBM Plex Sans', size: 12 } } },
    tooltip: {
      backgroundColor: '#1a2233',
      titleColor: '#e8eaf0',
      bodyColor:  '#8b93a7',
      borderColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      padding: 10,
      cornerRadius: 8,
    },
  },
  scales: {
    x: {
      grid: { color: 'rgba(255,255,255,0.05)' },
      ticks: { color: '#8b93a7', font: { family: 'IBM Plex Sans', size: 11 } },
    },
    y: {
      grid: { color: 'rgba(255,255,255,0.05)' },
      ticks: { color: '#8b93a7', font: { family: 'IBM Plex Sans', size: 11 } },
    },
  },
};

function makeOrUpdateChart(id, type, data, opts = {}) {
  const canvas = el(id);
  if (!canvas) return;
  if (state.charts[id]) { state.charts[id].destroy(); }
  const merged = deepMerge(JSON.parse(JSON.stringify(CHART_DEFAULTS)), opts);
  state.charts[id] = new Chart(canvas, { type, data, options: merged });
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      target[key] = deepMerge(target[key] ?? {}, source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────
function setPage(page) {
  state.currentPage = page;

  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach((a) => a.classList.remove('active'));

  const pg = el(`page-${page}`);
  const nl = document.querySelector(`[data-page="${page}"]`);
  if (pg) pg.classList.add('active');
  if (nl) nl.classList.add('active');

  // Load page data
  const loaders = {
    dashboard:    loadDashboard,
    volume:       () => loadWeightedVolume(0),
    mi:           () => loadMiData(0),
    nps:          loadNpsPage,
    team:         loadByMember,
    ingest:       loadIngestionHistory,
    admin:        loadAdmin,
    uncategorized: () => loadUncategorized(0),
  };
  (loaders[page] ?? (() => {}))();
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter helpers
// ─────────────────────────────────────────────────────────────────────────────
function buildFilterQuery() {
  const params = new URLSearchParams();
  if (state.period) {
    if (/Q[1-4]$/i.test(state.period)) {
      params.set('quarter', state.period);          // e.g. 2026-Q2
    } else if (/^\d{4}-YTD$/i.test(state.period)) {
      params.set('year', state.period.slice(0, 4)); // e.g. 2026
    } else {
      params.set('yearMonth', state.period);        // e.g. 2026-05
    }
  }
  for (const m of state.members) params.append('member', m);
  return params.toString() ? '?' + params : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Server health / status
// ─────────────────────────────────────────────────────────────────────────────
async function pollHealth() {
  const dot   = el('server-status-dot');
  const label = el('server-status-label');
  try {
    const d = await apiFetch('/api/status');
    dot.className   = 'status-dot ok';
    label.textContent = `${(d.requests ?? 0).toLocaleString()} requests`;
  } catch {
    dot.className   = 'status-dot error';
    label.textContent = 'Offline';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard Page
// ─────────────────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const q = buildFilterQuery();

  // KPI tiles
  try {
    const kpi = await apiFetch(`/api/metrics/kpi${q}`);
    setText('kpi-volume',       fmt(kpi.total_volume));
    setText('kpi-weighted',     fmt(kpi.total_weighted));
    setText('kpi-nps',          kpi.nps_score !== null ? `${kpi.nps_score}` : '—');
    setText('kpi-nps-total',    fmt(kpi.nps_total));
    setText('kpi-participation', kpi.participation_rate !== null ? `${fmt(kpi.participation_rate)}%` : '—');
    setText('kpi-members',      fmt(kpi.active_members));
    setText('kpi-promoters-sub', `${fmt(kpi.promoters)} promoters`);

    const npsEl = el('kpi-nps');
    if (npsEl && kpi.nps_score !== null) {
      npsEl.className = 'kpi-tile__value ' + npsClass(kpi.nps_score);
    }

    const periodLabel = state.period
      ? el('filter-period')?.selectedOptions[0]?.textContent ?? state.period
      : 'All periods';
    const memberLabel = state.members.size > 0
      ? `${state.members.size} member${state.members.size > 1 ? 's' : ''} selected`
      : `${fmt(kpi.active_members)} members active`;
    setText('kpi-period-label', `${periodLabel} • ${memberLabel}`);
  } catch (e) {
    console.error('[dashboard] KPI error:', e.message);
  }

  // Monthly trend charts
  try {
    const months = await apiFetch(`/api/metrics/by-month${q}`);
    const labels = months.map((m) => m.month);
    const vols   = months.map((m) => m.volume);
    const wtVols = months.map((m) => m.weighted_volume);
    const npsScores = months.map((m) => m.nps_score);

    makeOrUpdateChart('chart-monthly-vol', 'bar', {
      labels,
      datasets: [
        { label: 'Volume', data: vols, backgroundColor: COLORS.blue, borderRadius: 2 },
        { label: 'Weighted', data: wtVols, backgroundColor: COLORS.blueLight, borderRadius: 2 },
      ],
    });

    makeOrUpdateChart('chart-nps-trend', 'line', {
      labels,
      datasets: [{
        label: 'NPS Score',
        data:  npsScores,
        borderColor: COLORS.green,
        backgroundColor: 'rgba(66,190,101,.15)',
        tension: .3,
        fill: true,
        pointBackgroundColor: COLORS.green,
      }],
    }, {
      scales: { y: { suggestedMin: -100, suggestedMax: 100, grid: { color: '#393939' }, ticks: { color: '#c6c6c6' } } },
    });
  } catch (e) { console.error('[dashboard] Monthly chart error:', e.message); }

  // Member charts
  try {
    const members = await apiFetch(`/api/metrics/by-member${q}`);
    const names   = members.map((m) => m.team_member ?? 'Unassigned').slice(0, 12);
    const vols    = members.map((m) => m.volume).slice(0, 12);
    const npsArr  = members.map((m) => m.nps_score ?? 0).slice(0, 12);
    const feedbackArr     = members.map((m) => m.nps_total ?? 0).slice(0, 12);
    const participationArr = members.map((m) => m.participation_rate ?? 0).slice(0, 12);

    makeOrUpdateChart('chart-member-vol', 'bar', {
      labels: names,
      datasets: [{ label: 'Volume', data: vols, backgroundColor: COLORS.blue, borderRadius: 2 }],
    }, { indexAxis: 'y' });

    // Mixed chart: bars for NPS feedback count + NPS score; line for participation rate
    // All three use the same 0–100 y-axis. NPS score is already 0–100.
    // Feedback count uses a secondary right y-axis so it doesn't crowd the scale.
    makeOrUpdateChart('chart-member-nps', 'bar', {
      labels: names,
      datasets: [
        {
          type: 'bar',
          label: 'NPS Feedback (#)',
          data: feedbackArr,
          backgroundColor: 'rgba(69,137,255,0.7)',
          borderRadius: 3,
          yAxisID: 'yRight',
          order: 3,
        },
        {
          type: 'bar',
          label: 'NPS Score',
          data: npsArr,
          backgroundColor: npsArr.map((v) => v >= 50 ? COLORS.green : v >= 0 ? COLORS.yellow : COLORS.red),
          borderRadius: 3,
          yAxisID: 'yLeft',
          order: 2,
        },
        {
          type: 'line',
          label: 'Participation %',
          data: participationArr,
          borderColor: COLORS.yellow,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointBackgroundColor: COLORS.yellow,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.3,
          yAxisID: 'yLeft',
          order: 1,
        },
      ],
    }, {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (ctx.dataset.label === 'NPS Score') return ` NPS Score: ${ctx.parsed.y}`;
              if (ctx.dataset.label === 'Participation %') return ` Participation: ${ctx.parsed.y.toFixed(1)}%`;
              if (ctx.dataset.label === 'NPS Feedback (#)') return ` Feedback: ${ctx.parsed.y}`;
              return ctx.dataset.label + ': ' + ctx.parsed.y;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#8b93a7', font: { family: 'IBM Plex Sans', size: 10 }, maxRotation: 30, minRotation: 0 },
        },
        y: { display: false },   // hide the default y-axis; we use yLeft + yRight instead
        yLeft: {
          position: 'left',
          min: 0,
          max: 100,
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: '#8b93a7',
            font: { family: 'IBM Plex Sans', size: 10 },
            callback: (v) => v + '%',
          },
          title: { display: true, text: 'Score / Rate (%)', color: '#57606a', font: { size: 10 } },
        },
        yRight: {
          position: 'right',
          min: 0,
          grid: { drawOnChartArea: false },
          ticks: {
            color: '#8b93a7',
            font: { family: 'IBM Plex Sans', size: 10 },
          },
          title: { display: true, text: 'Feedback count', color: '#57606a', font: { size: 10 } },
        },
      },
    });
  } catch (e) { console.error('[dashboard] Member chart error:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Weighted Volume Page
// ─────────────────────────────────────────────────────────────────────────────
async function loadWeightedVolume(offset = 0) {
  state.wvOffset = offset;
  const q = buildFilterQuery().replace('?', '&');
  try {
    const { rows, total } = await apiFetch(`/api/metrics/weighted-volume?limit=${PAGE_SIZE}&offset=${offset}${q}`);
    setText('wv-count', `${total.toLocaleString()} rows`);

    const tbody = el('wv-tbody');
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td class="mono">${r.request_number ?? '—'}</td>
        <td>${r.team_member ?? '<span style="color:var(--text-disabled)">—</span>'}</td>
        <td>${r.month ?? '—'}</td>
        <td>${fmtDate(r.close_date)}</td>
        <td>${r.sub_process ?? '—'}</td>
        <td>${r.process ?? '—'}</td>
        <td>${r.complexity ?? '—'}</td>
        <td><strong>${r.weight !== null ? r.weight : '—'}</strong></td>
        <td>${r.status ?? '—'}</td>
        <td title="${r.customer_name ?? ''}">${(r.customer_name ?? '—').slice(0,30)}</td>
        <td>${r.market ?? '—'}</td>
      </tr>
    `).join('');

    renderPagination('wv-pagination', total, offset, PAGE_SIZE, (o) => loadWeightedVolume(o));
  } catch (e) { console.error('[wv]', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// M&I Page
// ─────────────────────────────────────────────────────────────────────────────
const miSearch = { request: '', member: '' };
const miSort   = { col: 'close_date', dir: 'desc' };

async function loadMiData(offset = 0) {
  state.miOffset = offset;
  const q = buildFilterQuery().replace('?', '&');
  const extra = [
    miSearch.request ? `&request=${encodeURIComponent(miSearch.request)}` : '',
    miSearch.member  ? `&member=${encodeURIComponent(miSearch.member)}`   : '',
    `&sortBy=${miSort.col}&sortDir=${miSort.dir}`,
  ].join('');
  try {
    const { rows, total } = await apiFetch(`/api/metrics/mi?limit=${PAGE_SIZE}&offset=${offset}${q}${extra}`);
    setText('mi-count', `${total.toLocaleString()} rows`);

    const tbody = el('mi-tbody');
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td class="mono">${r.request_number ?? '—'}</td>
        <td>${r.squad_member ?? '—'}</td>
        <td>${r.month ?? '—'}</td>
        <td>${fmtDate(r.close_date)}</td>
        <td>${r.ct_days !== null ? r.ct_days : '—'}</td>
        <td>${r.ct_in_days ?? '—'}</td>
        <td>${r.ct_hours !== null ? Math.round(r.ct_hours) : '—'}</td>
        <td>${r.funnel_hours !== null ? Math.round(r.funnel_hours) : '—'}</td>
        <td>${r.squad_hours !== null ? Math.round(r.squad_hours) : '—'}</td>
        <td><span class="badge badge--${r.is_backdated === 'Y' ? 'warn' : 'neutral'}">${r.is_backdated ?? '—'}</span></td>
        <td>${r.ym_close ?? '—'}</td>
        <td>${r.status ?? '—'}</td>
      </tr>
    `).join('');

    // ── Update sortable header arrows ─────────────────────────────────────
    document.querySelectorAll('#mi-thead-row th[data-col]').forEach((th) => {
      const col = th.dataset.col;
      const arrow = col === miSort.col ? (miSort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅';
      th.textContent = th.textContent.replace(/\s[▲▼⇅]$/, '') + arrow;
      th.classList.toggle('th--sorted', col === miSort.col);
    });

    renderPagination('mi-pagination', total, offset, PAGE_SIZE, (o) => loadMiData(o));
  } catch (e) { console.error('[mi]', e.message); }
}

function initMiSortHeaders() {
  document.querySelectorAll('#mi-thead-row th[data-col]').forEach((th) => {
    th.classList.add('th--sortable');
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (miSort.col === col) {
        miSort.dir = miSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        miSort.col = col;
        miSort.dir = 'asc';
      }
      loadMiData(0);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NPS Page
// ─────────────────────────────────────────────────────────────────────────────
async function loadNpsPage() {
  const q = buildFilterQuery();

  // Mini KPIs
  try {
    const kpi = await apiFetch(`/api/metrics/kpi${q}`);
    setText('nps-promoters',  fmt(kpi.promoters));
    setText('nps-detractors', fmt(kpi.detractors));
    setText('nps-passives',   kpi.nps_total - kpi.promoters - kpi.detractors);
    const scoreEl = el('nps-score-sm');
    if (scoreEl) {
      scoreEl.textContent = kpi.nps_score !== null ? `${kpi.nps_score}` : '—';
      scoreEl.className   = 'kpi-tile__value ' + npsClass(kpi.nps_score);
    }

    // NPS donut
    makeOrUpdateChart('chart-nps-donut', 'doughnut', {
      labels: ['Promoters', 'Passives', 'Detractors'],
      datasets: [{
        data: [kpi.promoters, kpi.nps_total - kpi.promoters - kpi.detractors, kpi.detractors],
        backgroundColor: [COLORS.green, COLORS.yellow, COLORS.red],
        borderWidth: 0,
      }],
    }, { scales: {}, cutout: '65%' });
  } catch (e) { console.error('[nps kpi]', e.message); }

  // NPS score trend
  try {
    const months = await apiFetch('/api/metrics/by-month');
    makeOrUpdateChart('chart-nps-score-trend', 'line', {
      labels: months.map((m) => m.month),
      datasets: [{
        label: 'NPS Score',
        data:  months.map((m) => m.nps_score),
        borderColor: COLORS.green,
        backgroundColor: 'rgba(66,190,101,.15)',
        fill: true,
        tension: .3,
        pointBackgroundColor: COLORS.green,
      }],
    }, { scales: { y: { suggestedMin: -100, suggestedMax: 100, grid: { color: '#393939' }, ticks: { color: '#c6c6c6' } } } });
  } catch (e) { console.error('[nps trend]', e.message); }

  // NPS table
  await loadNpsTable(0);
}

async function loadNpsTable(offset = 0) {
  state.npsOffset = offset;
  // Build query with period filter only — member filter is intentionally excluded here.
  // The NPS table always shows ALL detractors and unassigned rows regardless of which
  // members are selected in the global filter (filtering by member would hide detractors).
  const params = new URLSearchParams();
  if (state.period) {
    if (/Q[1-4]$/i.test(state.period))         params.set('quarter',   state.period);
    else if (/^\d{4}-YTD$/i.test(state.period)) params.set('year',      state.period.slice(0, 4));
    else                                         params.set('yearMonth', state.period);
  }
  const q = params.toString() ? '&' + params : '';
  try {
    const { rows, total } = await apiFetch(`/api/metrics/nps?limit=${PAGE_SIZE}&offset=${offset}${q}`);
    setText('nps-count', `${total.toLocaleString()} rows`);

    // ── Alert banner ──────────────────────────────────────────────────────
    const detractorCount  = rows.filter((r) => r.detractor === 1).length;
    const unassignedCount = rows.filter((r) => !r.team_member).length;
    const alertBar = el('nps-alert-bar');
    if (alertBar) {
      const parts = [];
      if (detractorCount > 0)
        parts.push(`<span class="nps-alert nps-alert--detractor">⚠ ${detractorCount} detractor${detractorCount > 1 ? 's' : ''} on this page — highlighted in red below</span>`);
      if (unassignedCount > 0)
        parts.push(`<span class="nps-alert nps-alert--unassigned">○ ${unassignedCount} unassigned row${unassignedCount > 1 ? 's' : ''} — assign a team member inline below</span>`);
      alertBar.innerHTML = parts.length ? `<div class="nps-alert-bar">${parts.join('')}</div>` : '';
    }

    // ── Squad member options (cached on state) ────────────────────────────
    if (!state._npsMembers) {
      try {
        const sm = await apiFetch('/api/admin/squad-members');
        state._npsMembers = sm.map((m) => m.name).sort();
      } catch { state._npsMembers = []; }
    }
    const memberOpts = (state._npsMembers ?? [])
      .map((n) => `<option value="${n}">${n}</option>`)
      .join('');

    // ── Table rows ────────────────────────────────────────────────────────
    const tbody = el('nps-tbody');
    tbody.innerHTML = rows.map((r) => {
      const isDetractor  = r.detractor === 1;
      const isUnassigned = !r.team_member;
      const rowCls = isDetractor ? 'row--detractor' : isUnassigned ? 'row--unassigned' : '';

      const memberCell = isUnassigned
        ? `<span class="nps-assign-wrap">
             <select class="nps-assign-sel" data-id="${r.id}" style="font-size:11px;background:var(--bg-02);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:var(--radius);padding:3px 6px;">
               <option value="">— assign —</option>
               ${memberOpts}
             </select>
             <button class="nps-assign-btn btn btn--primary" data-id="${r.id}" style="padding:3px 8px;font-size:11px;line-height:1.4">Save</button>
           </span>`
        : r.team_member;

      return `<tr class="${rowCls}" data-nps-id="${r.id}">
        <td>${r.month ?? '—'}</td>
        <td>${fmtDate(r.rated_date)}</td>
        <td><strong>${r.rating ?? '—'}</strong></td>
        <td>${definitionBadge(r.definition)}</td>
        <td class="mono">${r.request_number ?? '—'}</td>
        <td>${memberCell}</td>
        <td title="${(r.original_comment ?? '').replace(/"/g, '&quot;')}">${(r.original_comment ?? '—').slice(0, 60)}${(r.original_comment ?? '').length > 60 ? '…' : ''}</td>
      </tr>`;
    }).join('');

    // ── Assign button handler ─────────────────────────────────────────────
    tbody.querySelectorAll('.nps-assign-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const id  = parseInt(e.currentTarget.dataset.id, 10);
        const sel = tbody.querySelector(`.nps-assign-sel[data-id="${id}"]`);
        const name = sel?.value;
        if (!name) { sel?.focus(); return; }

        btn.disabled = true;
        btn.textContent = '…';
        try {
          await apiFetch('/api/metrics/nps/assign', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ id, team_member: name }),
          });
          // Replace the assign control with the saved name in the cell
          const row = tbody.querySelector(`tr[data-nps-id="${id}"]`);
          if (row) {
            row.querySelector('td:nth-child(6)').textContent = name;
            row.classList.remove('row--unassigned');
          }
          // Refresh alert banner count
          const remaining = tbody.querySelectorAll('.nps-assign-sel').length - 1;
          const alertBar2 = el('nps-alert-bar');
          if (alertBar2 && remaining === 0) {
            const detAlert = alertBar2.querySelector('.nps-alert--detractor');
            alertBar2.innerHTML = detAlert ? `<div class="nps-alert-bar">${detAlert.outerHTML}</div>` : '';
          } else if (alertBar2) {
            const unEl = alertBar2.querySelector('.nps-alert--unassigned');
            if (unEl) unEl.textContent = `○ ${remaining} unassigned row${remaining > 1 ? 's' : ''} — assign a team member inline below`;
          }
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Save';
          alert(`Assign failed: ${err.message}`);
        }
      });
    });

    renderPagination('nps-pagination', total, offset, PAGE_SIZE, (o) => loadNpsTable(o));
  } catch (e) { console.error('[nps table]', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// By Member Page
// ─────────────────────────────────────────────────────────────────────────────
const teamSort = { col: 'volume', dir: 'desc' };
let teamRows = [];   // cached full dataset for client-side re-sort

function renderTeamTable() {
  const tbody = el('team-tbody');
  if (!tbody) return;

  // Sort a copy — never mutate the cached array
  const sorted = [...teamRows].sort((a, b) => {
    const av = a[teamSort.col] ?? (teamSort.col === 'team_member' ? '' : -Infinity);
    const bv = b[teamSort.col] ?? (teamSort.col === 'team_member' ? '' : -Infinity);
    if (typeof av === 'string') {
      const cmp = av.localeCompare(bv);
      return teamSort.dir === 'asc' ? cmp : -cmp;
    }
    return teamSort.dir === 'asc' ? av - bv : bv - av;
  });

  tbody.innerHTML = sorted.map((r) => {
    const npsClass_ = r.nps_score !== null ? npsClass(r.nps_score) : '';
    const ct = r.avg_ct_days !== null ? r.avg_ct_days : null;
    // Colour-code CT: ≤1 day = green, ≤3 = yellow, >3 = red
    const ctStyle = ct === null ? '' :
      ct <= 1 ? 'color:var(--green-40)' :
      ct <= 3 ? 'color:var(--yellow-40,#f1c21b)' :
      'color:var(--red-40)';
    return `
      <tr>
        <td><strong>${r.team_member ?? '—'}</strong></td>
        <td>${fmt(r.volume)}</td>
        <td>${fmt(r.weighted_volume)}</td>
        <td style="${ctStyle}">${ct !== null ? ct + 'd' : '—'}</td>
        <td>${fmt(r.nps_total)}</td>
        <td style="color:var(--green-40)">${fmt(r.promoters)}</td>
        <td style="color:var(--red-40)">${fmt(r.detractors)}</td>
        <td class="${npsClass_}"><strong>${r.nps_score !== null ? r.nps_score : '—'}</strong></td>
        <td>${r.participation_rate !== null ? r.participation_rate + '%' : '—'}</td>
      </tr>
    `;
  }).join('');

  // Update header arrows
  document.querySelectorAll('#team-thead-row th[data-col]').forEach((th) => {
    const col = th.dataset.col;
    const arrow = col === teamSort.col ? (teamSort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅';
    th.textContent = th.textContent.replace(/\s[▲▼⇅]$/, '') + arrow;
    th.classList.toggle('th--sorted', col === teamSort.col);
  });
}

async function loadByMember() {
  const q = buildFilterQuery();
  try {
    teamRows = await apiFetch(`/api/metrics/by-member${q}`);
    renderTeamTable();
  } catch (e) { console.error('[by-member]', e.message); }
}

function initTeamSortHeaders() {
  document.querySelectorAll('#team-thead-row th[data-col]').forEach((th) => {
    th.classList.add('th--sortable');
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (teamSort.col === col) {
        teamSort.dir = teamSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        teamSort.col = col;
        teamSort.dir = th.dataset.type === 'str' ? 'asc' : 'desc';
      }
      renderTeamTable();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest / History Page
// ─────────────────────────────────────────────────────────────────────────────
async function loadIngestionHistory() {
  try {
    const rows = await apiFetch('/api/ingestion/history');
    const tbody = el('history-tbody');
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.source ?? '—'}</td>
        <td class="mono" title="${r.file_path ?? ''}">${r.filename ?? '—'}</td>
        <td>${fmt(r.row_count)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${fmtDate(r.ingested_at)}</td>
        <td style="color:var(--red-40);font-size:11px">${r.error ? r.error.slice(0, 60) : ''}</td>
      </tr>
    `).join('');
  } catch (e) { console.error('[history]', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Page
// ─────────────────────────────────────────────────────────────────────────────
async function loadAdmin() {
  // Squad members
  try {
    const members = await apiFetch('/api/admin/squad-members');
    el('sm-tbody').innerHTML = members.map((m) => `
      <tr>
        <td>${m.name}</td>
        <td class="mono">${m.email}</td>
        <td style="color:var(--text-secondary)">${m.email_raw ?? '—'}</td>
        <td>${m.sap_id ?? '—'}</td>
      </tr>
    `).join('');

    // Also seed the member multi-select (if not already loaded)
    memberSelectSeed(members.map((m) => m.name));
  } catch (e) { console.error('[admin squad]', e.message); }

  // Reason codes
  try {
    const codes = await apiFetch('/api/admin/reason-codes');
    el('rc-tbody').innerHTML = codes.map((c) => `
      <tr>
        <td><strong style="color:var(--ibm-blue-40)">${c.reason_code}</strong></td>
        <td>${c.sub_process}</td>
        <td>${c.process}</td>
        <td>${c.complexity}</td>
        <td><strong>${c.weight}</strong></td>
      </tr>
    `).join('');
  } catch (e) { console.error('[admin codes]', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Clear Data — modal logic
// ─────────────────────────────────────────────────────────────────────────────

/** Label map for each table cleared */
const TABLE_LABELS = {
  weighted_volume: 'Weighted Volume',
  mi_data:         'M&I Data',
  nps_data:        'NPS Data',
  raw_requests:    'Raw Requests',
  requests:        'Canonical Requests',
  raw_nps:         'Raw NPS',
  ingestion_log:   'Ingestion Log',
};

/** Fetch current row counts and populate the counts preview panel */
async function refreshCountsPreview() {
  try {
    const status = await apiFetch('/api/status');
    const scope  = document.querySelector('input[name="clear-scope"]:checked')?.value ?? 'derived';

    const tablesByScope = {
      derived: ['weighted_volume', 'mi_data', 'nps_data'],
      metrics: ['weighted_volume', 'mi_data', 'nps_data', 'raw_requests', 'requests', 'raw_nps'],
      all:     ['weighted_volume', 'mi_data', 'nps_data', 'raw_requests', 'requests', 'raw_nps', 'ingestion_log'],
    };

    // Map API field names to table names
    const apiMap = {
      weighted_volume: status.weighted_volume,
      mi_data:         status.mi_data,
      nps_data:        status.nps_data,
      raw_requests:    status.requests,   // approximate — same as canonical
      requests:        status.requests,
      raw_nps:         status.nps_data,
      ingestion_log:   null,              // not in status endpoint
    };

    const tables = tablesByScope[scope] ?? tablesByScope['derived'];
    const preview = el('clear-counts-preview');
    if (!preview) return;

    preview.innerHTML = tables.map((t) => {
      const count = apiMap[t];
      const hasData = count > 0;
      return `<span class="count-item ${hasData ? 'has-data' : 'no-data'}">` +
             `${TABLE_LABELS[t] ?? t}: ${count !== null && count !== undefined ? count.toLocaleString() + ' rows' : '—'}` +
             `</span>`;
    }).join('');
  } catch { /* ignore */ }
}

function openClearModal() {
  const modal = el('clear-modal');
  if (!modal) return;
  // Reset state
  el('clear-confirm-check').checked = false;
  el('clear-modal-confirm').disabled = true;
  document.querySelector('input[name="clear-scope"][value="derived"]').checked = true;
  // Hide any previous error
  const errEl = el('clear-modal-error');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  refreshCountsPreview();
  modal.classList.add('open');
  // Trap focus on close button
  el('clear-modal-close').focus();
}

function closeClearModal() {
  el('clear-modal')?.classList.remove('open');
}

async function executeDataClear() {
  const scope = document.querySelector('input[name="clear-scope"]:checked')?.value ?? 'derived';
  const btn   = el('clear-modal-confirm');
  const resultEl = el('clear-admin-result');

  btn.disabled = true;
  btn.textContent = 'Clearing…';

  try {
    const data = await apiFetch('/api/data/clear', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mode: scope }),
    });

    closeClearModal();

    // Show confirmation on Admin page result area
    if (resultEl) {
      const totalRemoved = Object.values(data.cleared ?? {}).reduce((s, v) => s + v, 0);
      const rebuildMsg = data.rebuilt
        ? ` · Rebuilt: WV=${(data.rebuilt.weighted_volume??0).toLocaleString()}, MI=${(data.rebuilt.mi_data??0).toLocaleString()}, NPS=${(data.rebuilt.nps_data??0).toLocaleString()}`
        : '';
      resultEl.className = 'ingest-result ok';
      resultEl.textContent = `✅ Cleared (${scope}): ${totalRemoved.toLocaleString()} rows removed${rebuildMsg}`;
    }

    // Refresh health + reload current page
    await pollHealth();
    setPage(state.currentPage);

    // Log it
    appendLog('warn', `[clear] Data cleared (mode=${scope}): ${JSON.stringify(data.cleared)}`);

  } catch (e) {
    // Show error in the modal so it's always visible regardless of current page
    const modalErrEl = el('clear-modal-error');
    if (modalErrEl) {
      modalErrEl.textContent = `❌ Clear failed: ${e.message}`;
      modalErrEl.style.display = 'block';
    }
    if (resultEl) {
      resultEl.className = 'ingest-result error';
      resultEl.textContent = `❌ Clear failed: ${e.message}`;
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" style="margin-right:5px"><path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>Clear Data`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination helper
// ─────────────────────────────────────────────────────────────────────────────
function renderPagination(containerId, total, offset, pageSize, onPage) {
  const container  = el(containerId);
  if (!container) return;
  const totalPages = Math.ceil(total / pageSize);
  const current    = Math.floor(offset / pageSize);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let html = `<button ${current === 0 ? 'disabled' : ''} data-offset="${(current - 1) * pageSize}">‹ Prev</button>`;

  const start = Math.max(0, current - 3);
  const end   = Math.min(totalPages - 1, current + 3);

  if (start > 0) html += `<button data-offset="0">1</button><span style="color:var(--text-secondary)">…</span>`;
  for (let i = start; i <= end; i++) {
    html += `<button class="${i === current ? 'active' : ''}" data-offset="${i * pageSize}">${i + 1}</button>`;
  }
  if (end < totalPages - 1) html += `<span style="color:var(--text-secondary)">…</span><button data-offset="${(totalPages - 1) * pageSize}">${totalPages}</button>`;

  html += `<button ${current === totalPages - 1 ? 'disabled' : ''} data-offset="${(current + 1) * pageSize}">Next ›</button>`;
  html += `<span style="color:var(--text-secondary);font-size:12px;margin-left:8px">${total.toLocaleString()} rows</span>`;

  container.innerHTML = html;
  container.querySelectorAll('button[data-offset]').forEach((btn) => {
    btn.addEventListener('click', () => onPage(parseInt(btn.dataset.offset, 10)));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE — real-time log streaming
// ─────────────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/events');

  es.addEventListener('log', (e) => {
    const data = JSON.parse(e.data);
    appendLog(data.level, data.msg);
  });

  es.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    console.log('[sse status]', data);
    if (data.type === 'ingest_complete') {
      pollHealth();
      if (state.currentPage === 'dashboard') loadDashboard();
      if (state.currentPage === 'ingest')    loadIngestionHistory();

      // If this ingest was triggered by an RV extraction job, show the final result
      // and re-enable both buttons; hide progress bar.
      const res = el('rv-extract-result');
      if (res && data.jobId && res.dataset.jobId === data.jobId) {
        res.className = 'ingest-result ok';
        res.textContent = `✅ Ingested ${(data.rowCount ?? 0).toLocaleString()} rows`;
        res.dataset.jobId = '';
        rvResetButtons();
        rvProgressHide();
      }
    }
    if (data.type === 'rv_extract_start') {
      const res = el('rv-extract-result');
      if (res && res.dataset.jobId === data.jobId) {
        res.textContent = `🤖 Extraction running… (job ${data.jobId})`;
        rvProgressShow('Connecting to EngageSupport…', 0, null);
      }
    }
    if (data.type === 'rv_progress') {
      const res = el('rv-extract-result');
      if (res && res.dataset.jobId === data.jobId) {
        const pct = (data.rowsFetched && data.totalRows)
          ? Math.round((data.rowsFetched / data.totalRows) * 100) : null;
        rvProgressShow(data.message, pct, data.totalRows);
      }
    }
    if (data.type === 'rv_extract_complete') {
      const res = el('rv-extract-result');
      if (res && res.dataset.jobId === data.jobId) {
        if (data.success) {
          const chunks = data.chunks > 1 ? ` (${data.chunks} chunks merged)` : '';
          res.className = 'ingest-result';
          res.textContent = `✅ Extracted: ${data.filename ?? ''}${chunks} — ingesting…`;
          rvProgressShow('Saving & ingesting…', 100, data.rowCount);
        } else {
          res.className = 'ingest-result error';
          res.textContent = `❌ Extraction failed: ${data.error ?? 'Unknown error'}`;
          res.dataset.jobId = '';
          rvResetButtons();
          rvProgressHide();
        }
      }
    }
    if (data.type === 'nps_resolve_start') {
      const res = el('nps-resolve-result');
      if (res && res.dataset.jobId === data.jobId) {
        res.className = 'ingest-result';
        res.textContent = '🔍 Resolving unassigned NPS owners via ES API…';
      }
    }
    if (data.type === 'nps_resolve_complete') {
      const res = el('nps-resolve-result');
      if (res && res.dataset.jobId === data.jobId) {
        res.dataset.jobId = '';
        const btn = el('nps-resolve-btn');
        if (btn) { btn.disabled = false; el('nps-resolve-label').textContent = 'Resolve Owners'; }
        if (data.error) {
          res.className = 'ingest-result error';
          res.textContent = `❌ ${data.error}`;
        } else {
          res.className = data.resolved > 0 ? 'ingest-result ok' : 'ingest-result';
          res.textContent = `✅ Resolved: ${data.resolved} · Skipped: ${data.skipped} · Failed: ${data.failed} (${data.durationMs}ms)`;
          if (data.resolved > 0 && state.currentPage === 'nps') loadNpsTable(0);
        }
      }
    }
    if (data.type === 'data_cleared') {
      pollHealth();
      // Refresh whichever page is open
      setPage(state.currentPage);
    }
  });

  es.onerror = () => {
    el('server-status-dot').className = 'status-dot error';
    el('server-status-label').textContent = 'Disconnected';
    setTimeout(connectSSE, 5000);
    es.close();
  };
}

function appendLog(level, msg) {
  const panel = el('log-panel');
  if (!panel) return;
  const span = document.createElement('span');
  span.className = `log-entry ${level}`;
  span.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  panel.appendChild(span);
  panel.appendChild(document.createElement('br'));
  // Auto-scroll
  panel.scrollTop = panel.scrollHeight;
  // Cap at 200 entries
  while (panel.children.length > 400) panel.removeChild(panel.firstChild);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest actions
// ─────────────────────────────────────────────────────────────────────────────
async function uploadAndIngest(sourceType, fileInput, resultId) {
  const resultEl = el(resultId);
  const file = fileInput.files?.[0];
  if (!file) { resultEl.className = 'ingest-result error'; resultEl.textContent = '❌ No file selected.'; return; }

  resultEl.className = 'ingest-result';
  resultEl.textContent = `Uploading ${file.name}…`;

  const endpoint = sourceType === 'request_view' ? '/api/upload/request-view' : '/api/upload/nps';
  const form = new FormData();
  form.append('file', file);

  try {
    const r = await fetch(API + endpoint, { method: 'POST', body: form });
    if (!r.ok) { const t = await r.text(); throw new Error(t || r.statusText); }
    const data = await r.json();
    resultEl.className = `ingest-result ${data.status === 'success' ? 'ok' : 'error'}`;
    resultEl.textContent = data.status === 'success'
      ? `✅ ${file.name} — ${(data.rowCount ?? 0).toLocaleString()} rows in ${data.durationMs}ms`
      : `❌ ${data.error ?? 'Unknown error'}`;
    if (data.status === 'success') { pollHealth(); loadIngestionHistory(); }
  } catch (e) {
    resultEl.className = 'ingest-result error';
    resultEl.textContent = `❌ ${e.message}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Uncategorized Items Page
// ─────────────────────────────────────────────────────────────────────────────

const uncatState = {
  offset:      0,
  pageSize:    50,
  total:       0,
  search:      '',
  rcOptions:   [],   // [{ sub_process, process, complexity, weight, reason_code }]
  rows:        [],   // current page rows
  rowEdits:    {},   // request_number → { sub_process, process, complexity, weight }
  selected:    new Set(),  // selected request_numbers
};

/** Build the <select> HTML for sub-process, scoped to this row (or bulk) */
function buildSubProcessSelect(id, currentVal = '', compact = false) {
  const groups = {};
  for (const opt of uncatState.rcOptions) {
    if (!groups[opt.process]) groups[opt.process] = [];
    if (!groups[opt.process].includes(opt.sub_process)) {
      groups[opt.process].push(opt.sub_process);
    }
  }
  const sz = compact ? ' style="font-size:11px"' : '';
  let html = `<select id="${id}"${sz}><option value="">— choose —</option>`;
  for (const [proc, subs] of Object.entries(groups).sort()) {
    html += `<optgroup label="${proc}">`;
    for (const sub of subs.sort()) {
      const sel = sub === currentVal ? ' selected' : '';
      html += `<option value="${sub}"${sel}>${sub}</option>`;
    }
    html += `</optgroup>`;
  }
  html += `</select>`;
  return html;
}

/** Look up process/complexity/weight from rcOptions by sub_process */
function rcLookup(subProcess) {
  return uncatState.rcOptions.find((r) => r.sub_process === subProcess) ?? null;
}

/** Update the nav badge with the uncategorized count */
function updateUncatBadge(count) {
  const badge = el('nav-uncat-count');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 999 ? '999+' : String(count);
  } else {
    badge.textContent = '';
  }
}

async function loadUncategorized(offset = 0) {
  uncatState.offset = offset;
  const params = new URLSearchParams({
    limit:  String(uncatState.pageSize),
    offset: String(offset),
  });
  if (uncatState.search) params.set('search', uncatState.search);

  const tbody        = el('uncat-tbody');
  const showingEl    = el('uncat-showing');
  const totalEl      = el('uncat-total');
  const pagination   = el('uncat-pagination');
  const saveResult   = el('uncat-save-result');

  if (tbody) tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-secondary);padding:24px">Loading…</td></tr>';
  if (saveResult) { saveResult.textContent = ''; saveResult.className = 'ingest-result'; }

  try {
    const data = await apiFetch(`/api/metrics/uncategorized?${params}`);
    uncatState.total     = data.total;
    uncatState.rows      = data.rows;
    uncatState.rcOptions = data.reason_code_options ?? [];

    updateUncatBadge(data.total);
    if (showingEl) showingEl.textContent = data.rows.length.toLocaleString();
    if (totalEl)   totalEl.textContent   = data.total.toLocaleString();

    // Populate bulk sub-process dropdown
    const bulkSp = el('bulk-sub-process');
    if (bulkSp) {
      const groups = {};
      for (const opt of uncatState.rcOptions) {
        if (!groups[opt.process]) groups[opt.process] = [];
        if (!groups[opt.process].includes(opt.sub_process)) {
          groups[opt.process].push(opt.sub_process);
        }
      }
      bulkSp.innerHTML = '<option value="">— choose —</option>';
      for (const [proc, subs] of Object.entries(groups).sort()) {
        const og = document.createElement('optgroup');
        og.label = proc;
        for (const sub of subs.sort()) {
          const o = document.createElement('option');
          o.value = sub;
          o.textContent = sub;
          og.appendChild(o);
        }
        bulkSp.appendChild(og);
      }
    }

    // Render table
    if (tbody) {
      if (data.rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:32px;color:var(--green-40)">
          ✅ No uncategorized items — all requests are classified!
        </td></tr>`;
      } else {
        tbody.innerHTML = data.rows.map((row) => {
          const edit   = uncatState.rowEdits[row.request_number] ?? {};
          const isSel  = uncatState.selected.has(row.request_number);
          const rowCls = isSel ? 'row--selected' : (edit.sub_process ? 'row--pending-save' : '');
          const spVal  = edit.sub_process ?? '';
          const prVal  = edit.process     ?? '';
          const cxVal  = edit.complexity  ?? '';
          const wVal   = edit.weight      !== undefined ? edit.weight : '';
          const idPfx  = `uncat-row-${row.request_number}`;

          // Build sub-process <select> for this row (inline)
          const groups = {};
          for (const opt of uncatState.rcOptions) {
            if (!groups[opt.process]) groups[opt.process] = [];
            if (!groups[opt.process].includes(opt.sub_process)) groups[opt.process].push(opt.sub_process);
          }
          let spHtml = `<select class="row-sp" data-rn="${row.request_number}" id="${idPfx}-sp" style="font-size:11px"><option value="">— choose —</option>`;
          for (const [proc, subs] of Object.entries(groups).sort()) {
            spHtml += `<optgroup label="${proc}">`;
            for (const sub of subs.sort()) {
              const sel = sub === spVal ? ' selected' : '';
              spHtml += `<option value="${sub}"${sel}>${sub}</option>`;
            }
            spHtml += '</optgroup>';
          }
          spHtml += '</select>';

          return `<tr class="${rowCls}" data-rn="${row.request_number}">
            <td class="col-check"><input type="checkbox" class="row-check" data-rn="${row.request_number}" ${isSel ? 'checked' : ''} /></td>
            <td><code style="font-size:11px">${row.request_number}</code></td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" title="${row.request_type ?? ''}">${row.request_type ?? '—'}</td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px" title="${row.customer_name ?? ''}">${row.customer_name ?? '—'}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-family:var(--font-mono)" title="${row.last_comment ?? ''}">${row.last_comment ?? '—'}</td>
            <td style="font-size:11px">${fmtDate(row.close_date)}</td>
            <td style="font-size:11px">${row.team_member ?? '—'}</td>
            <td>${spHtml}</td>
            <td><input type="text" class="row-proc" data-rn="${row.request_number}" value="${prVal}" placeholder="auto" style="font-size:11px;width:120px;background:var(--bg-02);border:1px solid var(--border-strong);color:var(--text-primary);padding:4px 6px;border-radius:var(--radius)" readonly /></td>
            <td><input type="text" class="row-cx" data-rn="${row.request_number}" value="${cxVal}" placeholder="auto" style="font-size:11px;width:110px;background:var(--bg-02);border:1px solid var(--border-strong);color:var(--text-primary);padding:4px 6px;border-radius:var(--radius)" readonly /></td>
            <td class="col-weight"><input type="number" class="row-w" data-rn="${row.request_number}" value="${wVal}" placeholder="auto" step="0.25" min="0" max="5" style="font-size:11px;width:72px;background:var(--bg-02);border:1px solid var(--border-strong);color:var(--text-primary);padding:4px 6px;border-radius:var(--radius)" /></td>
          </tr>`;
        }).join('');
      }
    }

    // Row-level sub-process change listener — auto-fill process/complexity/weight
    el('uncat-tbody')?.querySelectorAll('select.row-sp').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const rn = e.target.dataset.rn;
        const subProc = e.target.value;
        const match = rcLookup(subProc);
        if (!uncatState.rowEdits[rn]) uncatState.rowEdits[rn] = {};
        uncatState.rowEdits[rn].sub_process = subProc;
        if (match) {
          uncatState.rowEdits[rn].process    = match.process;
          uncatState.rowEdits[rn].complexity = match.complexity;
          uncatState.rowEdits[rn].weight     = match.weight;
        }
        // Update the readonly proc/cx fields and weight input in the same row
        const tr = e.target.closest('tr');
        if (tr) {
          const procInp = tr.querySelector('.row-proc');
          const cxInp   = tr.querySelector('.row-cx');
          const wInp    = tr.querySelector('.row-w');
          if (procInp) procInp.value = match?.process    ?? '';
          if (cxInp)   cxInp.value   = match?.complexity ?? '';
          if (wInp)    wInp.value    = match?.weight     !== undefined ? match.weight : '';
        }
        // Mark row as pending
        const rowEl = el('uncat-tbody')?.querySelector(`tr[data-rn="${rn}"]`);
        if (rowEl) rowEl.className = 'row--pending-save';
      });
    });

    // Row weight override listener
    el('uncat-tbody')?.querySelectorAll('input.row-w').forEach((inp) => {
      inp.addEventListener('change', (e) => {
        const rn = e.target.dataset.rn;
        if (!uncatState.rowEdits[rn]) uncatState.rowEdits[rn] = {};
        uncatState.rowEdits[rn].weight = parseFloat(e.target.value);
        const rowEl = el('uncat-tbody')?.querySelector(`tr[data-rn="${rn}"]`);
        if (rowEl) rowEl.className = 'row--pending-save';
      });
    });

    // Row checkbox listener
    el('uncat-tbody')?.querySelectorAll('input.row-check').forEach((chk) => {
      chk.addEventListener('change', (e) => {
        const rn = e.target.dataset.rn;
        if (e.target.checked) {
          uncatState.selected.add(rn);
          e.target.closest('tr')?.classList.add('row--selected');
        } else {
          uncatState.selected.delete(rn);
          e.target.closest('tr')?.classList.remove('row--selected');
        }
        refreshUncatSelectionUI();
      });
    });

    // Render pagination
    if (pagination) {
      const totalPages = Math.ceil(data.total / uncatState.pageSize);
      const currentPage = Math.floor(offset / uncatState.pageSize) + 1;
      pagination.innerHTML = `
        <button id="uncat-prev-btn" ${offset === 0 ? 'disabled' : ''}>← Prev</button>
        <span class="page-indicator">Page ${currentPage} of ${totalPages || 1}</span>
        <button id="uncat-next-btn" ${offset + uncatState.pageSize >= data.total ? 'disabled' : ''}>Next →</button>
        <span style="color:var(--text-secondary);font-size:11px;margin-left:8px">${data.total.toLocaleString()} total uncategorized</span>
      `;
      el('uncat-prev-btn')?.addEventListener('click', () => loadUncategorized(offset - uncatState.pageSize));
      el('uncat-next-btn')?.addEventListener('click', () => loadUncategorized(offset + uncatState.pageSize));
    }

    refreshUncatSelectionUI();
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="11" style="color:var(--red-40);padding:16px">Error: ${e.message}</td></tr>`;
  }
}

function refreshUncatSelectionUI() {
  const count = uncatState.selected.size;
  const saveBtn = el('uncat-bulk-assign-btn');
  const countEl = el('uncat-selected-count');
  const bulkPanel = el('uncat-bulk-panel');
  if (saveBtn) saveBtn.disabled = count === 0;
  if (countEl) countEl.textContent = count;
  if (bulkPanel) bulkPanel.style.display = count > 0 ? 'block' : 'none';
}

async function saveUncatClassifications() {
  const saveBtn    = el('uncat-bulk-assign-btn');
  const saveResult = el('uncat-save-result');

  // Collect items to save — only selected rows that have a sub_process set
  const items = [];
  for (const rn of uncatState.selected) {
    const edit = uncatState.rowEdits[rn];
    if (!edit || !edit.sub_process) {
      saveResult.className = 'ingest-result error';
      saveResult.textContent = `❌ Request ${rn} has no Sub-Process selected. Please assign one before saving.`;
      return;
    }
    items.push({
      request_number: rn,
      sub_process:    edit.sub_process,
      process:        edit.process    ?? '',
      complexity:     edit.complexity ?? 'Average',
      weight:         edit.weight     ?? 1.0,
    });
  }

  if (items.length === 0) {
    saveResult.className = 'ingest-result error';
    saveResult.textContent = '❌ No items to save. Select rows and assign Sub-Process first.';
    return;
  }

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  saveResult.className = 'ingest-result';
  saveResult.textContent = `⏳ Saving ${items.length} override(s) and re-transforming…`;

  try {
    const data = await apiFetch('/api/metrics/classify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ items }),
    });

    saveResult.className = 'ingest-result ok';
    saveResult.textContent = `✅ Saved ${data.saved} override(s). Weighted Volume: ${(data.wv_rows ?? 0).toLocaleString()} rows re-computed.`;

    // Clear selection and edits for saved items
    for (const item of items) {
      uncatState.selected.delete(item.request_number);
      delete uncatState.rowEdits[item.request_number];
    }

    // Reload page (saved items should no longer appear if they now have sub_process)
    setTimeout(() => loadUncategorized(uncatState.offset), 800);
    pollHealth();
  } catch (e) {
    saveResult.className = 'ingest-result error';
    saveResult.textContent = `❌ ${e.message}`;
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" style="margin-right:4px"><path d="M2 8l4 4 8-8" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        Save Selected (<span id="uncat-selected-count">${uncatState.selected.size}</span>)`;
    }
    refreshUncatSelectionUI();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Listeners
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Navigation
  document.querySelectorAll('.nav-link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      setPage(a.dataset.page);
    });
  });

  // Filter apply
  el('apply-filters')?.addEventListener('click', () => {
    state.period = el('filter-period').value;
    // state.members is kept live via the multi-select checkboxes — no extra read needed
    setPage(state.currentPage);
  });

  // Filter reset
  el('reset-filters')?.addEventListener('click', () => {
    state.period = '';
    state.members = new Set();
    el('filter-period').value = '';
    memberSelectReset();
    setPage(state.currentPage);
  });

  // Export
  el('export-btn')?.addEventListener('click', () => {
    const q = buildFilterQuery();
    window.open(`/api/export${q}`, '_blank');
  });

  // ── Clear Data modal wiring ──────────────────────────────────────────────
  // Open modal — from filter bar button
  el('clear-data-btn')?.addEventListener('click', openClearModal);
  // Open modal — from Admin page Danger Zone button
  el('clear-data-btn-admin')?.addEventListener('click', openClearModal);

  // Close modal — X button and Cancel
  el('clear-modal-close')?.addEventListener('click', closeClearModal);
  el('clear-modal-cancel')?.addEventListener('click', closeClearModal);

  // Close on overlay click (click outside modal box)
  el('clear-modal')?.addEventListener('click', (e) => {
    if (e.target === el('clear-modal')) closeClearModal();
  });

  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el('clear-modal')?.classList.contains('open')) closeClearModal();
  });

  // Enable/disable confirm button based on checkbox
  el('clear-confirm-check')?.addEventListener('change', (e) => {
    el('clear-modal-confirm').disabled = !e.target.checked;
  });

  // Refresh counts preview when scope radio changes
  document.querySelectorAll('input[name="clear-scope"]').forEach((radio) => {
    radio.addEventListener('change', refreshCountsPreview);
  });

  // Execute the clear
  el('clear-modal-confirm')?.addEventListener('click', executeDataClear);

  // Request View file picker — update label with filename
  el('rv-file-input')?.addEventListener('change', () => {
    const f = el('rv-file-input').files?.[0];
    el('rv-file-label').textContent = f ? f.name : 'Choose file…';
  });

  // NPS file picker — update label with filename
  el('nps-file-input')?.addEventListener('change', () => {
    const f = el('nps-file-input').files?.[0];
    el('nps-file-label').textContent = f ? f.name : 'Choose file…';
  });

  // Request View upload & ingest
  el('rv-ingest-btn')?.addEventListener('click', () => {
    uploadAndIngest('request_view', el('rv-file-input'), 'rv-result');
  });

  // NPS upload & ingest
  el('nps-ingest-btn')?.addEventListener('click', () => {
    uploadAndIngest('nps_export', el('nps-file-input'), 'nps-result');
  });

  // NPS automated extraction
  el('nps-extract-btn')?.addEventListener('click', async () => {
    const btn   = el('nps-extract-btn');
    const label = el('nps-extract-label');
    const res   = el('nps-extract-result');
    const period = el('nps-period').value.trim();

    btn.disabled = true;
    label.textContent = 'Extracting…';
    res.className = 'ingest-result';
    res.textContent = '🤖 Launching Playwright browser automation…';

    try {
      const data = await apiFetch('/api/nps/extract', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reportPeriod: period || undefined }),
      });
      if (data.extract?.success) {
        res.className = 'ingest-result ok';
        res.textContent = `✅ Extracted: ${data.extract.filename ?? ''} | Ingested: ${(data.ingest?.rowCount ?? 0).toLocaleString()} rows`;
        pollHealth();
        loadIngestionHistory();
      } else {
        res.className = 'ingest-result error';
        res.textContent = `❌ ${data.extract?.error ?? data.error ?? 'Extraction failed'}`;
      }
    } catch (e) {
      res.className = 'ingest-result error';
      res.textContent = `❌ ${e.message}`;
    } finally {
      btn.disabled = false;
      label.textContent = 'Extract & Ingest NPS';
    }
  });

  // NPS owner resolution
  el('nps-resolve-btn')?.addEventListener('click', async () => {
    const btn   = el('nps-resolve-btn');
    const label = el('nps-resolve-label');
    const res   = el('nps-resolve-result');

    btn.disabled = true;
    label.textContent = 'Resolving…';
    res.className = 'ingest-result';
    res.dataset.jobId = '';
    res.textContent = '🔍 Starting owner resolution…';

    try {
      const data = await apiFetch('/api/nps/resolve-owners', { method: 'POST' });
      if (data.jobId) {
        res.dataset.jobId = data.jobId;
        res.textContent = '🔍 Resolving — progress visible in Live Log below…';
        // Button re-enabled by nps_resolve_complete SSE event
      } else {
        res.className = 'ingest-result error';
        res.textContent = `❌ ${data.error ?? 'Failed to start'}`;
        btn.disabled = false;
        label.textContent = 'Resolve Owners';
      }
    } catch (e) {
      res.className = 'ingest-result error';
      res.textContent = `❌ ${e.message}`;
      btn.disabled = false;
      label.textContent = 'Resolve Owners';
    }
  });

  // ── Request View progress bar helpers ────────────────────────────────────
  function rvProgressShow(msg, pct, total) {
    const wrap = el('rv-progress-wrap');
    const msgEl = el('rv-progress-msg');
    const pctEl = el('rv-progress-pct');
    const bar   = el('rv-progress-bar');
    if (!wrap) return;
    wrap.style.display = 'block';
    if (msgEl) msgEl.textContent = msg ?? '';
    if (bar && pct !== null) bar.style.width = `${Math.min(pct, 100)}%`;
    if (pctEl) pctEl.textContent = (pct !== null ? `${pct}%` : '') + (total ? ` · ${total.toLocaleString()} rows` : '');
  }

  function rvProgressHide() {
    const wrap = el('rv-progress-wrap');
    const bar  = el('rv-progress-bar');
    if (wrap) wrap.style.display = 'none';
    if (bar)  bar.style.width = '0%';
  }

  function rvResetButtons() {
    const btn      = el('rv-extract-btn');
    const syncBtn  = el('rv-sync-btn');
    const label    = el('rv-extract-label');
    const syncLbl  = el('rv-sync-label');
    if (btn)     btn.disabled     = false;
    if (syncBtn) syncBtn.disabled = false;
    if (label)   label.textContent = 'Extract & Ingest';
    if (syncLbl) syncLbl.textContent = '⚡ Sync New';
  }

  async function triggerRvExtraction(period, incremental) {
    const btn      = el('rv-extract-btn');
    const syncBtn  = el('rv-sync-btn');
    const label    = el('rv-extract-label');
    const syncLbl  = el('rv-sync-label');
    const res      = el('rv-extract-result');

    // Disable both buttons for the duration
    if (btn)     btn.disabled     = true;
    if (syncBtn) syncBtn.disabled = true;
    if (label)   label.textContent  = incremental ? 'Extract & Ingest' : 'Extracting…';
    if (syncLbl) syncLbl.textContent = incremental ? 'Syncing…' : '⚡ Sync New';

    res.className   = 'ingest-result';
    res.dataset.jobId = '';
    res.textContent = incremental ? '⚡ Starting incremental sync…' : '🤖 Starting extraction job…';
    rvProgressShow('Connecting to EngageSupport…', 0, null);

    try {
      const data = await apiFetch('/api/request-view/extract', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ period, incremental: !!incremental }),
      });
      if (data.status === 'up_to_date') {
        res.className = 'ingest-result ok';
        res.textContent = `✅ ${data.message ?? 'Already up to date'}`;
        rvResetButtons();
        rvProgressHide();
      } else if (data.jobId) {
        res.dataset.jobId = data.jobId;
        res.textContent = incremental
          ? `⚡ Incremental sync started (${data.period}) — progress below`
          : `🤖 Job ${data.jobId} started (${data.period}) — progress below`;
        // Buttons stay disabled; SSE ingest_complete re-enables them
      } else {
        res.className = 'ingest-result error';
        res.textContent = `❌ ${data.error ?? 'Failed to start extraction job'}`;
        rvResetButtons();
        rvProgressHide();
      }
    } catch (e) {
      res.className = 'ingest-result error';
      res.textContent = `❌ ${e.message}`;
      rvResetButtons();
      rvProgressHide();
    }
  }

  // Request View — full extraction
  el('rv-extract-btn')?.addEventListener('click', () => {
    const period = el('rv-period').value.trim();
    triggerRvExtraction(period, false);
  });

  // Request View — incremental sync
  el('rv-sync-btn')?.addEventListener('click', () => {
    triggerRvExtraction(undefined, true);
  });

  // Add squad member
  el('sm-add-btn')?.addEventListener('click', async () => {
    const email    = el('sm-email').value.trim();
    const emailRaw = el('sm-email-raw').value.trim();
    const name     = el('sm-name').value.trim();
    const sapId    = el('sm-sap').value.trim();
    if (!email || !name) { alert('Email and Name are required.'); return; }
    try {
      await apiFetch('/api/admin/squad-members', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, email_raw: emailRaw || undefined, name, sap_id: sapId || undefined }),
      });
      el('sm-result').className = 'ingest-result ok';
      el('sm-result').textContent = `✅ Added: ${name} (${email})`;
      el('sm-email').value = el('sm-email-raw').value = el('sm-name').value = el('sm-sap').value = '';
      loadAdmin();
    } catch (e) {
      el('sm-result').className = 'ingest-result error';
      el('sm-result').textContent = `❌ ${e.message}`;
    }
  });

  // ── M&I search controls ──────────────────────────────────────────────────
  const miDoSearch = () => {
    miSearch.request = el('mi-search-request')?.value.trim() ?? '';
    miSearch.member  = el('mi-search-member')?.value.trim()  ?? '';
    loadMiData(0);
  };
  el('mi-search-btn')?.addEventListener('click', miDoSearch);
  el('mi-clear-btn')?.addEventListener('click', () => {
    miSearch.request = miSearch.member = '';
    if (el('mi-search-request')) el('mi-search-request').value = '';
    if (el('mi-search-member'))  el('mi-search-member').value  = '';
    loadMiData(0);
  });
  el('mi-search-request')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') miDoSearch(); });
  el('mi-search-member')?.addEventListener('keydown',  (e) => { if (e.key === 'Enter') miDoSearch(); });

  // ── Uncategorized page controls ─────────────────────────────────────────
  // Search
  el('uncat-search-btn')?.addEventListener('click', () => {
    uncatState.search   = el('uncat-search').value.trim();
    uncatState.selected.clear();
    uncatState.rowEdits = {};
    loadUncategorized(0);
  });
  el('uncat-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('uncat-search-btn')?.click();
  });

  // Select-all toggle button
  el('uncat-select-all-btn')?.addEventListener('click', () => {
    const allChecks = [...(el('uncat-tbody')?.querySelectorAll('input.row-check') ?? [])];
    const allRns = allChecks.map((c) => c.dataset.rn);
    const allSelected = allRns.length > 0 && allRns.every((rn) => uncatState.selected.has(rn));
    if (allSelected) {
      for (const rn of allRns) uncatState.selected.delete(rn);
      allChecks.forEach((c) => { c.checked = false; c.closest('tr')?.classList.remove('row--selected'); });
      el('uncat-select-all-btn').textContent = '☐ Select All';
    } else {
      for (const rn of allRns) uncatState.selected.add(rn);
      allChecks.forEach((c) => { c.checked = true; c.closest('tr')?.classList.add('row--selected'); });
      el('uncat-select-all-btn').textContent = '☑ Deselect All';
    }
    refreshUncatSelectionUI();
  });

  // Bulk Sub-Process → auto-fill the bulk panel Process/Complexity/Weight
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'bulk-sub-process') {
      const subProc = e.target.value;
      const match = uncatState.rcOptions.find((r) => r.sub_process === subProc);
      if (match) {
        const procSel = el('bulk-process');
        const cxSel   = el('bulk-complexity');
        const wInp    = el('bulk-weight');
        if (procSel) { procSel.innerHTML = `<option value="${match.process}" selected>${match.process}</option>`; }
        if (cxSel)   cxSel.value = match.complexity;
        if (wInp)    wInp.value  = match.weight;
      }
    }
  });

  // Apply bulk values to all selected rows
  el('uncat-apply-bulk-vals')?.addEventListener('click', () => {
    const subProc = el('bulk-sub-process')?.value;
    const proc    = el('bulk-process')?.value;
    const cx      = el('bulk-complexity')?.value;
    const wRaw    = el('bulk-weight')?.value;
    const w       = wRaw ? parseFloat(wRaw) : undefined;

    if (!subProc) { alert('Select a Sub-Process first.'); return; }

    for (const rn of uncatState.selected) {
      if (!uncatState.rowEdits[rn]) uncatState.rowEdits[rn] = {};
      uncatState.rowEdits[rn].sub_process = subProc;
      if (proc) uncatState.rowEdits[rn].process    = proc;
      if (cx)   uncatState.rowEdits[rn].complexity = cx;
      if (w !== undefined) uncatState.rowEdits[rn].weight = w;

      // Update the DOM row
      const tr = el('uncat-tbody')?.querySelector(`tr[data-rn="${rn}"]`);
      if (tr) {
        const spSel   = tr.querySelector('.row-sp');
        const prInpEl = tr.querySelector('.row-proc');
        const cxInpEl = tr.querySelector('.row-cx');
        const wInpEl  = tr.querySelector('.row-w');
        if (spSel)   spSel.value   = subProc;
        if (prInpEl) prInpEl.value = proc ?? '';
        if (cxInpEl) cxInpEl.value = cx   ?? '';
        if (wInpEl && w !== undefined) wInpEl.value = w;
        tr.className = 'row--pending-save row--selected';
      }
    }
  });

  // Save selected classifications button
  el('uncat-bulk-assign-btn')?.addEventListener('click', saveUncatClassifications);

  // ── Init ────────────────────────────────────────────────────────────────
  connectSSE();
  pollHealth();
  setInterval(pollHealth, 30_000);

  // Load initial logs
  apiFetch('/api/logs').then((logs) => {
    const panel = el('log-panel');
    if (panel) {
      for (const line of (logs ?? []).slice(-50)) {
        const m = line.match(/\] (INFO|WARN|ERROR): (.+)/);
        if (m) appendLog(m[1].toLowerCase(), m[2]);
      }
    }
  }).catch(() => {});

  // Init M&I sort headers (once — click handlers are persistent)
  initMiSortHeaders();
  initTeamSortHeaders();

  // Initial page load
  setPage('dashboard');

  // Pre-fill uncategorized badge after a brief delay
  setTimeout(() => {
    apiFetch('/api/metrics/uncategorized?limit=1&offset=0')
      .then((d) => updateUncatBadge(d.total ?? 0))
      .catch(() => {});
  }, 1500);

  // ── Populate Period dropdown ──────────────────────────────────────────────
  // Extracted into a named function so it can be retried (e.g. on dropdown
  // focus) if the first call fires before the server has data.
  function populatePeriodDropdown() {
    const sel = el('filter-period');
    if (!sel) return;

    apiFetch('/api/metrics/periods').then((yearMonths) => {
      if (!Array.isArray(yearMonths) || !yearMonths.length) return;

      // Clear all children except the first "All periods" option, then re-populate
      sel.querySelectorAll('optgroup').forEach((g) => g.remove());
      while (sel.options.length > 1) sel.remove(1);

      const MON_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const monthLabel = (ym) => {
        const [y, m] = ym.split('-');
        return `${MON_NAMES[parseInt(m, 10) - 1]} ${y}`;
      };
      const years = [...new Set(yearMonths.map((ym) => ym.slice(0, 4)))].sort();
      const quartersForYear = (year) => {
        const present = yearMonths.filter((ym) => ym.startsWith(year));
        return [1, 2, 3, 4].filter((q) => {
          const start = (q - 1) * 3 + 1;
          return [start, start + 1, start + 2].some(
            (mo) => present.includes(`${year}-${String(mo).padStart(2, '0')}`)
          );
        });
      };
      const makeOpt = (value, text) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        return o;
      };

      for (const year of years) {
        const yg = document.createElement('optgroup');
        yg.label = year;

        yg.appendChild(makeOpt(`${year}-YTD`, `${year} — Full Year`));

        for (const q of quartersForYear(year)) {
          yg.appendChild(makeOpt(`${year}-Q${q}`, `Q${q} ${year}`));
        }

        for (const ym of yearMonths.filter((v) => v.startsWith(year))) {
          yg.appendChild(makeOpt(ym, monthLabel(ym)));
        }

        sel.appendChild(yg);
      }
    }).catch((e) => console.warn('[filter-period] fetch failed:', e.message));
  }

  // Try immediately, then retry once after 2 s in case the server is still
  // starting up, and again when the user first clicks the dropdown.
  populatePeriodDropdown();
  setTimeout(populatePeriodDropdown, 2000);
  el('filter-period')?.addEventListener('focus', populatePeriodDropdown);

  // ── Multi-select member dropdown ─────────────────────────────────────────
  // allMemberNames: full list loaded once from /api/admin/squad-members
  let allMemberNames = [];

  function memberSelectSeed(names) {
    allMemberNames = [...new Set([...allMemberNames, ...names])].sort();
    memberSelectRender(allMemberNames, '');
  }

  function memberSelectRender(names, search) {
    const list = el('member-options-list');
    if (!list) return;
    const q = search.toLowerCase();
    const filtered = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
    list.innerHTML = filtered.map((name) => {
      const checked = state.members.has(name) ? ' checked' : '';
      const esc = name.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
      return `<label class="multi-select-option">
        <input type="checkbox" value="${esc}"${checked} />
        ${esc}
      </label>`;
    }).join('');

    list.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
      chk.addEventListener('change', () => {
        if (chk.checked) state.members.add(chk.value);
        else             state.members.delete(chk.value);
        memberSelectUpdateLabel();
      });
    });
  }

  function memberSelectUpdateLabel() {
    const labelEl = el('member-select-label');
    if (!labelEl) return;
    if (state.members.size === 0) {
      labelEl.textContent = 'All Members';
      return;
    }
    if (state.members.size === 1) {
      labelEl.textContent = [...state.members][0];
      return;
    }
    labelEl.textContent = `${state.members.size} members`;
  }

  function memberSelectReset() {
    state.members = new Set();
    memberSelectUpdateLabel();
    memberSelectRender(allMemberNames, '');
    el('member-search-input').value = '';
  }

  // Toggle open/close
  el('member-select-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = el('member-select-dropdown');
    const trigger = el('member-select-trigger');
    const isOpen = dd.style.display !== 'none';
    dd.style.display = isOpen ? 'none' : 'block';
    trigger.classList.toggle('open', !isOpen);
    if (!isOpen) {
      el('member-search-input')?.focus();
    }
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    const wrap = el('member-select-wrap');
    if (wrap && !wrap.contains(e.target)) {
      el('member-select-dropdown').style.display = 'none';
      el('member-select-trigger').classList.remove('open');
    }
  });

  // Search filtering
  el('member-search-input')?.addEventListener('input', (e) => {
    memberSelectRender(allMemberNames, e.target.value);
  });

  // Select All / None buttons
  el('member-select-all')?.addEventListener('click', () => {
    for (const n of allMemberNames) state.members.add(n);
    memberSelectRender(allMemberNames, el('member-search-input').value);
    memberSelectUpdateLabel();
  });
  el('member-select-none')?.addEventListener('click', () => {
    state.members = new Set();
    memberSelectRender(allMemberNames, el('member-search-input').value);
    memberSelectUpdateLabel();
  });

  // Load members from API
  setTimeout(() => {
    apiFetch('/api/admin/squad-members')
      .then((members) => memberSelectSeed(members.map((m) => m.name)))
      .catch(() => {});
  }, 1000);
});
