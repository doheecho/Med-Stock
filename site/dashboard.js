/* 메-Stock 대시보드
 * - data/*.json (GitHub Actions 배치 산출물) 로드 → 차트/표 렌더
 * - 현재가/평가손익만 Cloudflare Worker 프록시로 페이지 로드 시 재조회
 *
 * 배포 후 할 일: 아래 PROXY_BASE 에 워커 URL 을 넣는다.
 *   비워두면 실시간 조회를 건너뛰고 종가(last_close)로 표시한다.
 */
const PROXY_BASE = ""; // 예: "https://med-stock-proxy.your-subdomain.workers.dev"

const FX_FALLBACK = 1350; // frankfurter 조회 실패 시 USD→KRW 대체 환율

const state = {
  dataBase: "./data",
  holdings: [],
  scenarios: {},
  snapshot: null,
  prices: {},       // ticker -> prices json
  live: {},         // ticker -> {price, prevClose, currency,...}
  active: null,
  charts: {},       // canvasId -> Chart
  viewMode: "byTicker",              // "byTicker" | "byAccount"
  fx: null,                          // { USDKRW, date }
  sort: { key: null, dir: "desc" },  // 표 정렬 상태
};

/* USD→KRW 환율 (오늘 기준). 실패 시 대체값. */
function fxRate() {
  return (state.fx && state.fx.USDKRW) || FX_FALLBACK;
}
/* 외화(미국) 금액을 원화로 환산. KRW 는 그대로. */
function toKRW(v, market) {
  if (v == null) return null;
  return market === "US" ? v * fxRate() : v;
}

const fmt = {
  // 금액: 원화, 통화기호 없이 #,###
  won: (v) => (v == null ? "—" : Math.round(v).toLocaleString("ko-KR")),
  wonSigned: (v) => (v == null ? "—" : (v < 0 ? "-" : "+") + Math.round(Math.abs(v)).toLocaleString("ko-KR")),
  // 단가/현재가: 환종 유지 — 미국 종목만 $, 나머지는 기호 없이 원화값
  price: (v, market) =>
    v == null
      ? "—"
      : market === "US"
      ? "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 })
      : Math.round(v).toLocaleString("ko-KR"),
  pct: (v) => (v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(2) + "%"),
  num: (v, d = 2) => (v == null ? "—" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d })),
  man: (v) => (v == null ? "—" : Math.round(v / 10000).toLocaleString("ko-KR") + "만"),
};

const cls = (v) => (v == null ? "" : v >= 0 ? "pos" : "neg");

/* ------------------------------------------------------------------ 부트스트랩 */
document.addEventListener("DOMContentLoaded", init);

async function init() {
  if (window.Chart && window.ChartDataLabels) {
    Chart.register(window.ChartDataLabels);
    Chart.defaults.plugins.datalabels = { display: false }; // 도넛에서만 켠다
  }
  document.getElementById("refreshBtn").addEventListener("click", refreshLive);
  document.querySelectorAll("#viewToggle button").forEach((b) => {
    b.addEventListener("click", () => setViewMode(b.dataset.mode));
  });
  document.querySelectorAll("#posTable thead th").forEach((th) => {
    if (th.dataset.key) th.addEventListener("click", () => onSort(th.dataset.key));
  });
  try {
    state.dataBase = await resolveDataBase();
    const [holdings, scenarios, snapshot, fx] = await Promise.all([
      getJSON(`${state.dataBase}/holdings.json`).catch(() => null),
      getJSON(`${state.dataBase}/scenarios.json`).catch(() => ({ scenarios: {} })),
      getJSON(`${state.dataBase}/snapshot.json`).catch(() => null),
      getJSON("https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW")
        .catch(() => getJSON("https://api.frankfurter.app/latest?from=USD&to=KRW"))
        .catch(() => null),
    ]);

    if (fx && fx.rates && fx.rates.KRW) state.fx = { USDKRW: fx.rates.KRW, date: fx.date };

    state.snapshot = snapshot;
    state.scenarios = (scenarios && scenarios.scenarios) || {};
    state.holdings =
      (holdings && holdings.holdings) ||
      (snapshot && snapshot.positions) ||
      [];

    if (!state.holdings.length) {
      return fail("보유종목이 비어 있습니다. GitHub 리포지토리의 holdings.yaml 을 수정하면 'Rebuild holdings' 워크플로가 data/holdings.json 을 재생성합니다.");
    }

    // 가격 시계열 로드
    await Promise.all(
      state.holdings.map(async (h) => {
        state.prices[h.ticker] = await getJSON(`${state.dataBase}/prices/${h.ticker}.json`).catch(() => null);
      })
    );

    document.getElementById("asOf").textContent =
      "배치 기준일 " + ((snapshot && snapshot.as_of) || "—") +
      "  ·  $1 = ₩" + Math.round(fxRate()).toLocaleString("ko-KR") +
      (state.fx ? ` (${state.fx.date})` : " (대체값)");

    buildTabs();
    renderSummary();
    selectTicker(state.holdings[0].ticker);

    await refreshLive(); // 실시간 현재가
  } catch (e) {
    console.error(e);
    fail("초기화 실패: " + e.message);
  }
}

async function resolveDataBase() {
  for (const base of ["./data", "../data", "/data"]) {
    try {
      const r = await fetch(`${base}/snapshot.json`, { method: "HEAD" });
      if (r.ok) return base;
    } catch (_) {}
  }
  return "./data";
}

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function fail(msg) {
  document.getElementById("detail").innerHTML = `<div class="error">${msg}</div>`;
}

/* ------------------------------------------------------------------ 실시간 현재가 */
async function refreshLive() {
  if (!PROXY_BASE) {
    // 프록시 미설정 → 종가로 대체
    for (const h of state.holdings) {
      const p = state.prices[h.ticker];
      if (p && p.last_close != null) {
        state.live[h.ticker] = { price: p.last_close, prevClose: null, currency: h.market === "US" ? "USD" : "KRW", source: "close" };
      }
    }
    renderSummary();
    if (state.active) renderDetail(state.active);
    return;
  }

  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  btn.textContent = "조회 중…";
  await Promise.all(
    state.holdings.map(async (h) => {
      try {
        const q = await getJSON(`${PROXY_BASE}/?ticker=${encodeURIComponent(h.ticker)}`);
        if (q && q.price != null) state.live[h.ticker] = q;
      } catch (e) {
        console.warn("live fail", h.ticker, e);
      }
    })
  );
  btn.disabled = false;
  btn.textContent = "↻ 현재가 갱신";

  renderSummary();
  if (state.active) renderDetail(state.active);
}

/* live 우선, 없으면 종가 */
function priceOf(ticker) {
  const l = state.live[ticker];
  if (l && l.price != null) return l.price;
  const p = state.prices[ticker];
  return p ? p.last_close : null;
}

/* ------------------------------------------------------------------ 요약 */
function setViewMode(mode) {
  state.viewMode = mode === "byAccount" ? "byAccount" : "byTicker";
  document.querySelectorAll("#viewToggle button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === state.viewMode);
  });
  renderSummary();
  if (state.active) renderDetail(state.active);
}

/* holdings.json 에 lots 가 없던(구버전) 경우 단일 계좌로 취급 */
function lotsOf(h) {
  if (Array.isArray(h.lots) && h.lots.length) return h.lots;
  return [{ account: "기본", buy_price: h.buy_price, quantity: h.quantity }];
}

function compute(buy_price, quantity, ticker) {
  const cur = priceOf(ticker);
  const cost = buy_price * quantity;
  const value = cur == null ? null : cur * quantity;
  const pl = value == null ? null : value - cost;
  const plPct = pl == null || !cost ? null : (pl / cost) * 100;
  return { cur, cost, value, pl, plPct };
}

function computePosition(h) {
  return compute(h.buy_price, h.quantity, h.ticker);
}

/* 표 정렬용 키 → 행에서 뽑는 값 (금액류는 원화 환산값으로 비교) */
function sortValue(r, key) {
  const m = r.h.market;
  switch (key) {
    case "name": return (r.h.name || r.h.ticker);
    case "quantity": return r.h.quantity;
    case "buy_price": return toKRW(r.h.buy_price, m);
    case "cur": return toKRW(r.cur, m);
    case "cost": return toKRW(r.cost, m);
    case "value": return toKRW(r.value, m) ?? toKRW(r.cost, m);
    case "pl": return toKRW(r.pl, m);
    case "plPct": return r.plPct;
    case "weight": return toKRW(r.value, m) ?? toKRW(r.cost, m);
    default: return 0;
  }
}

function applySort(rows) {
  const { key, dir } = state.sort;
  if (!key) return rows;
  const s = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key);
    if (typeof va === "string") return va.localeCompare(vb, "ko") * s;
    return ((va ?? -Infinity) - (vb ?? -Infinity)) * s;
  });
}

function onSort(key) {
  if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
  else state.sort = { key, dir: "desc" };
  markSortHeader();
  renderSummary();
}

function markSortHeader() {
  document.querySelectorAll("#posTable thead th").forEach((th) => {
    const base = th.dataset.label || th.textContent.replace(/[▲▼]\s*$/, "").trim();
    th.dataset.label = base;
    th.textContent = base + (th.dataset.key === state.sort.key ? (state.sort.dir === "asc" ? " ▲" : " ▼") : "");
  });
}

function renderSummary() {
  const rows = state.holdings.map((h) => ({ h, ...computePosition(h) }));

  // 총합은 전부 원화 환산 (미국 종목은 오늘 환율로). 종목별/회사별 동일.
  let cost = 0, value = 0, haveAll = true;
  for (const r of rows) {
    cost += toKRW(r.cost, r.h.market);
    if (r.value == null) haveAll = false;
    else value += toKRW(r.value, r.h.market);
  }
  const pl = haveAll ? value - cost : null;
  const plPct = pl != null && cost ? (pl / cost) * 100 : null;

  setText("sumCost", fmt.won(cost));
  setText("sumValue", haveAll ? fmt.won(value) : "—");
  const plEl = setText("sumPl", pl == null ? "—" : fmt.wonSigned(pl));
  plEl.className = "value " + (pl == null ? "" : pl < 0 ? "neg" : "pos");
  const pctEl = setText("sumPlPct", fmt.pct(plPct));
  pctEl.className = "value " + (plPct == null ? "" : plPct < 0 ? "neg" : "pos");

  markSortHeader();
  if (state.viewMode === "byAccount") renderByAccount(applySort(rows));
  else renderByTicker(applySort(rows));
}

/* 한 포지션 행 <td> 묶음. 단가/현재가는 환종 유지, 금액류는 원화 환산. */
function posCells({ h, cur, cost, value, pl, plPct }, weightPct) {
  const m = h.market;
  return `
    <td>${fmt.num(h.quantity, 4)}</td>
    <td>${fmt.price(h.buy_price, m)}</td>
    <td>${fmt.price(cur, m)}</td>
    <td>${fmt.won(toKRW(cost, m))}</td>
    <td>${value == null ? "—" : fmt.won(toKRW(value, m))}</td>
    <td class="${cls(pl)}">${pl == null ? "—" : fmt.wonSigned(toKRW(pl, m))}</td>
    <td class="${cls(plPct)}">${fmt.pct(plPct)}</td>
    <td>${weightPct == null ? "—" : weightPct.toFixed(1) + "%"}</td>`;
}

/* ---- 종목별 조회: 계좌 무관, 통합 평단가 한 줄 ---- */
function renderByTicker(rows) {
  const items = rows.map((r) => ({
    label: r.h.name || r.h.ticker,
    value: toKRW(r.value, r.h.market) ?? toKRW(r.cost, r.h.market),
  }));
  drawPie("weightChart", items);
  const sumW = items.reduce((a, b) => a + b.value, 0) || 1;

  document.querySelector("#posTable tbody").innerHTML = rows
    .map((r, i) => `<tr class="lvl-ticker">
        <td>${r.h.name || r.h.ticker} <span class="src">${r.h.ticker}</span></td>
        ${posCells(r, (items[i].value / sumW) * 100)}
      </tr>`)
    .join("");
}

/* ---- 회사별 조회: 종목별로 나오되 계좌 버블 + 계좌별 매수금액/수량/평가액 ---- */
function renderByAccount(rows) {
  const pieItems = [];
  for (const r of rows) {
    for (const lot of lotsOf(r.h)) {
      const c = compute(lot.buy_price, lot.quantity, r.h.ticker);
      pieItems.push({
        label: `${r.h.name || r.h.ticker} · ${lot.account}`,
        value: toKRW(c.value, r.h.market) ?? toKRW(c.cost, r.h.market),
      });
    }
  }
  drawPie("weightChart", pieItems);
  const sumW = pieItems.reduce((a, b) => a + b.value, 0) || 1;

  const html = [];
  for (const r of rows) {
    const lots = lotsOf(r.h);
    const tW = (toKRW(r.value, r.h.market) ?? toKRW(r.cost, r.h.market)) / sumW * 100;
    html.push(`<tr class="lvl-ticker">
      <td>${r.h.name || r.h.ticker} <span class="src">${r.h.ticker}</span> <span class="src">${lots.length}개 계좌</span></td>
      ${posCells(r, tW)}
    </tr>`);
    for (const lot of lots) {
      const c = { h: r.h, ...compute(lot.buy_price, lot.quantity, r.h.ticker) };
      const w = (toKRW(c.value, r.h.market) ?? toKRW(c.cost, r.h.market)) / sumW * 100;
      html.push(`<tr class="lvl-account">
        <td><span class="bubble">${escapeHtml(lot.account)}</span></td>
        ${posCells({ ...c, h: { ...r.h, quantity: lot.quantity, buy_price: lot.buy_price } }, w)}
      </tr>`);
    }
  }
  document.querySelector("#posTable tbody").innerHTML = html.join("");
}

function setText(id, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  return el;
}

/* ------------------------------------------------------------------ 탭 */
function buildTabs() {
  const nav = document.getElementById("tabs");
  nav.innerHTML = "";
  for (const h of state.holdings) {
    const b = document.createElement("button");
    b.textContent = h.name || h.ticker;
    b.dataset.ticker = h.ticker;
    b.addEventListener("click", () => selectTicker(h.ticker));
    nav.appendChild(b);
  }
}

function selectTicker(ticker) {
  state.active = ticker;
  document.querySelectorAll("#tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.ticker === ticker);
  });
  renderDetail(ticker);
}

/* ------------------------------------------------------------------ 종목 상세 */
async function renderDetail(ticker) {
  const h = state.holdings.find((x) => x.ticker === ticker);
  const main = document.getElementById("detail");
  main.innerHTML = `
    ${state.viewMode === "byAccount" ? acctStripHtml(h) : ""}
    <div class="panel-grid">
      <div>
        <div class="block"><h3>가격 · 이동평균 · 시나리오 점선</h3><canvas id="priceChart" height="150"></canvas></div>
        <div class="block"><h3>RSI (14)</h3><canvas id="rsiChart" height="70"></canvas></div>
        <div class="block"><h3>수급 (외국인/기관 순매수 · 억원)</h3><canvas id="flowChart" height="90"></canvas></div>
      </div>
      <div>
        <div class="block"><h3>기본 지표</h3><div id="fundBox">로딩…</div></div>
        <div class="block"><h3>목표주가 갭</h3><div id="targetBox">로딩…</div></div>
        <div class="block"><h3>최근 뉴스</h3><ul class="news" id="newsBox"><li>로딩…</li></ul></div>
      </div>
    </div>`;

  drawRsiChart(state.prices[h.ticker]);

  const [fund, flow, target, news] = await Promise.all([
    getJSON(`${state.dataBase}/fundamentals/${ticker}.json`).catch(() => null),
    getJSON(`${state.dataBase}/flows/${ticker}.json`).catch(() => null),
    getJSON(`${state.dataBase}/targets/${ticker}.json`).catch(() => null),
    getJSON(`${state.dataBase}/news/${ticker}.json`).catch(() => null),
  ]);

  renderFundamentals(h, fund);
  drawFlowChart(flow);
  renderTarget(h, target);      // state._targets 캐시 → 시나리오 앵커에 사용
  renderNews(news);
  drawPriceChart(h);            // 목표주가 로드 후 그려야 컨센서스 점선이 표시됨
}

/* 회사별 조회 시 종목 상세 상단에 계좌 버블 스트립 */
function acctStripHtml(h) {
  if (!h) return "";
  const m = h.market;
  const cards = lotsOf(h)
    .map((lot) => {
      const c = compute(lot.buy_price, lot.quantity, h.ticker);
      return `<div class="acct-card">
        <div class="bubble">${escapeHtml(lot.account)}</div>
        <dl class="kv">
          <dt>수량</dt><dd>${fmt.num(lot.quantity, 4)}</dd>
          <dt>매수단가</dt><dd>${fmt.price(lot.buy_price, m)}</dd>
          <dt>매수금액</dt><dd>${fmt.won(toKRW(c.cost, m))}</dd>
          <dt>평가액</dt><dd>${c.value == null ? "—" : fmt.won(toKRW(c.value, m))}</dd>
          <dt>평가손익</dt><dd class="${cls(c.pl)}">${c.pl == null ? "—" : fmt.wonSigned(toKRW(c.pl, m))} (${fmt.pct(c.plPct)})</dd>
        </dl>
      </div>`;
    })
    .join("");
  return `<div class="block acct-strip"><h3>계좌별 내역 — ${h.name || h.ticker}</h3><div class="acct-cards">${cards}</div></div>`;
}

/* ---- 가격 차트 (캔들 or 라인) + MA + 시나리오 점선 ---- */
function drawPriceChart(h) {
  const p = state.prices[h.ticker];
  const box = document.getElementById("priceChart");
  if (!p || !p.dates || !p.dates.length) {
    box.parentElement.innerHTML = "<h3>가격</h3><div class='error'>가격 데이터 없음</div>";
    return;
  }

  const hasFinancial = !!(window.Chart && Chart.registry.controllers.get("candlestick"));
  const datasets = [];

  if (hasFinancial && p.candles) {
    datasets.push({
      type: "candlestick",
      label: h.name || h.ticker,
      data: p.candles.map((c) => ({ x: new Date(c.t).valueOf(), o: c.o, h: c.h, l: c.l, c: c.c })),
      color: { up: "#ef4444", down: "#3b82f6", unchanged: "#8b95a1" },
      order: 10,
    });
  } else {
    datasets.push({
      type: "line",
      label: "종가",
      data: p.dates.map((d, i) => ({ x: new Date(d).valueOf(), y: p.close[i] })),
      borderColor: "#e6e9ee",
      borderWidth: 1.4,
      pointRadius: 0,
      order: 10,
    });
  }

  const maColors = { ma5: "#f59e0b", ma20: "#22d3ee", ma60: "#22c55e", ma120: "#a855f7" };
  for (const key of ["ma5", "ma20", "ma60", "ma120"]) {
    if (!p.ma || !p.ma[key]) continue;
    datasets.push({
      type: "line",
      label: key.toUpperCase(),
      data: p.dates.map((d, i) => ({ x: new Date(d).valueOf(), y: p.ma[key][i] })),
      borderColor: maColors[key],
      borderWidth: 1,
      pointRadius: 0,
      spanGaps: true,
      order: 5,
    });
  }

  // ---- 시나리오 점선 오버레이 ----
  const lastDate = new Date(p.dates[p.dates.length - 1]).valueOf();
  const cur = priceOf(h.ticker) ?? p.last_close;
  for (const sc of scenarioAnchors(h)) {
    const horizon = lastDate + sc.months * 30 * 864e5;
    datasets.push({
      type: "line",
      label: sc.label,
      data: [
        { x: lastDate, y: cur },
        { x: horizon, y: sc.target },
      ],
      borderColor: sc.color,
      borderDash: [5, 5],
      borderWidth: 1.5,
      pointRadius: 3,
      pointBackgroundColor: sc.color,
      order: 1,
    });
  }

  makeChart("priceChart", {
    data: { datasets },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "time", time: { unit: "month" }, grid: { color: "#2b333d40" }, ticks: { color: "#8b95a1" } },
        y: { position: "right", grid: { color: "#2b333d40" }, ticks: { color: "#8b95a1" } },
      },
      plugins: {
        legend: { labels: { color: "#8b95a1", boxWidth: 12, font: { size: 10 } } },
        tooltip: { callbacks: {} },
      },
    },
  });
}

/* 증권사 컨센서스 + 사용자 시나리오를 앵커로 변환 */
function scenarioAnchors(h) {
  const out = [];
  const t = state._targets && state._targets[h.ticker];
  // targets 는 renderTarget 에서 캐시됨. 없으면 스냅샷 값 사용
  const snapPos = (state.snapshot?.positions || []).find((x) => x.ticker === h.ticker) || h;
  const hi = (t && t.target_high) ?? snapPos.target_high;
  const avg = (t && t.target_avg) ?? snapPos.target_avg;
  const lo = (t && t.target_low) ?? snapPos.target_low;
  if (hi) out.push({ label: "낙관(최고 목표가)", target: hi, months: 12, color: "#22c55e" });
  if (avg) out.push({ label: "중립(평균 컨센서스)", target: avg, months: 12, color: "#f59e0b" });
  if (lo) out.push({ label: "비관(최저 목표가)", target: lo, months: 12, color: "#3b82f6" });

  for (const s of state.scenarios[h.ticker] || []) {
    out.push({
      label: s.label || "내 목표가",
      target: s.target_price,
      months: s.horizon_months || 6,
      color: "#e6e9ee",
    });
  }
  return out;
}

/* ---- RSI ---- */
function drawRsiChart(p) {
  const el = document.getElementById("rsiChart");
  if (!el) return;
  if (!p || !p.rsi || !p.dates) {
    el.parentElement.innerHTML = "<h3>RSI (14)</h3><div class='error'>RSI 데이터 없음</div>";
    return;
  }
  const start = Math.max(0, p.dates.length - 180);
  const xs = p.dates.slice(start).map((d) => new Date(d).valueOf());
  const ys = p.rsi.slice(start);
  makeChart("rsiChart", {
    data: {
      datasets: [
        { type: "line", label: "RSI", data: xs.map((x, i) => ({ x, y: ys[i] })), borderColor: "#22d3ee", borderWidth: 1.2, pointRadius: 0, spanGaps: true },
        { type: "line", label: "70", data: [{ x: xs[0], y: 70 }, { x: xs[xs.length - 1], y: 70 }], borderColor: "#ef444488", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
        { type: "line", label: "30", data: [{ x: xs[0], y: 30 }, { x: xs[xs.length - 1], y: 30 }], borderColor: "#3b82f688", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
      ],
    },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { type: "time", time: { unit: "month" }, ticks: { color: "#8b95a1", maxTicksLimit: 8 }, grid: { display: false } },
        y: { position: "right", min: 0, max: 100, ticks: { color: "#8b95a1", stepSize: 25 }, grid: { color: "#2b333d40" } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

/* ---- 지표 표 ---- */
function renderFundamentals(h, f) {
  const box = document.getElementById("fundBox");
  if (!f) {
    box.innerHTML = "<div class='error'>재무지표 없음</div>";
    return;
  }
  const rows = [];
  const add = (k, v, suffix = "") => {
    if (v != null) rows.push(`<dt>${k}</dt><dd>${fmt.num(v)}${suffix}</dd>`);
  };
  add("PER", f.per);
  add("선행 PER", f.forward_per);
  add("PBR", f.pbr);
  add("EPS", f.eps);
  add("BPS", f.bps);
  add("ROE", f.roe, "%");
  add("부채비율", f.debt_ratio ?? f.debt_to_equity, "%");
  add("배당수익률", f.div_yield, "%");
  add("영업이익률", f.profit_margin, "%");
  add("시가총액", f.market_cap ? Math.round(f.market_cap / 1e8) : null, f.market_cap ? "억" : "");
  add("베타", f.beta);
  box.innerHTML = `<dl class="kv">${rows.join("") || "<dt>—</dt><dd>—</dd>"}</dl>
    <div class="src" style="margin-top:8px">기준일 ${f.as_of || f.updated_at || "—"}</div>`;
}

/* ---- 수급 막대 ---- */
function drawFlowChart(flow) {
  const el = document.getElementById("flowChart");
  if (!flow || !flow.rows || !flow.rows.length) {
    el.parentElement.innerHTML = "<h3>수급</h3><div class='error'>수급 데이터 없음 (해외 종목은 미제공)</div>";
    return;
  }
  const rows = flow.rows.slice(-30);
  const toEok = (v) => (v == null ? null : Math.round(v / 1e8));
  makeChart("flowChart", {
    data: {
      labels: rows.map((r) => r.t.slice(5)),
      datasets: [
        { label: "외국인", data: rows.map((r) => toEok(r.foreign)), backgroundColor: "#22d3ee" },
        { label: "기관", data: rows.map((r) => toEok(r.institution)), backgroundColor: "#f59e0b" },
      ],
    },
    type: "bar",
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: false, ticks: { color: "#8b95a1", maxTicksLimit: 10 }, grid: { display: false } },
        y: { position: "right", ticks: { color: "#8b95a1" }, grid: { color: "#2b333d40" } },
      },
      plugins: { legend: { labels: { color: "#8b95a1", boxWidth: 12, font: { size: 10 } } } },
    },
  });
}

/* ---- 목표주가 갭 ---- */
function renderTarget(h, t) {
  state._targets = state._targets || {};
  if (t) state._targets[h.ticker] = t;
  const box = document.getElementById("targetBox");
  if (!t || !t.target_avg) {
    box.innerHTML = "<div class='error'>목표주가 컨센서스 없음</div>";
    return;
  }
  const cur = priceOf(h.ticker) ?? (state.prices[h.ticker] && state.prices[h.ticker].last_close);
  const m = h.market;
  const gap = cur ? ((t.target_avg - cur) / cur) * 100 : null;

  const lo = t.target_low ?? t.target_avg * 0.85;
  const hi = t.target_high ?? t.target_avg * 1.15;
  const span = hi - lo || 1;
  const posPct = cur ? Math.max(0, Math.min(100, ((cur - lo) / span) * 100)) : 50;
  const avgPct = Math.max(0, Math.min(100, ((t.target_avg - lo) / span) * 100));

  box.innerHTML = `
    <dl class="kv">
      <dt>현재가</dt><dd>${fmt.price(cur, m)}</dd>
      <dt>평균 목표가</dt><dd>${fmt.price(t.target_avg, m)}</dd>
      <dt>최고 / 최저</dt><dd>${fmt.price(hi, m)} / ${fmt.price(lo, m)}</dd>
      <dt>상승여력</dt><dd class="${cls(gap)}">${fmt.pct(gap)}</dd>
      <dt>투자의견</dt><dd>${t.opinion || "—"}${t.num_analysts ? ` (${t.num_analysts})` : ""}</dd>
    </dl>
    <div class="bar-track">
      <div class="bar-fill" style="width:${avgPct}%"></div>
      <div class="bar-mark" style="left:${posPct}%" title="현재가"></div>
    </div>
    <div class="src">막대=최저~평균 구간, 세로선=현재가 · 출처 ${t.source || "—"}</div>`;
}

/* ---- 뉴스 ---- */
function renderNews(news) {
  const box = document.getElementById("newsBox");
  if (!news || !news.items || !news.items.length) {
    box.innerHTML = "<li class='error'>뉴스 없음</li>";
    return;
  }
  box.innerHTML = news.items
    .slice(0, 12)
    .map(
      (n) => `<li><a href="${n.url}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
        <span class="src">${escapeHtml(n.source || "")} ${escapeHtml(shortDate(n.date))}</span></li>`
    )
    .join("");
}

function shortDate(d) {
  if (!d) return "";
  const t = Date.parse(d);
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return String(d).slice(0, 16);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------------ Chart helpers */
function makeChart(id, cfg) {
  const el = document.getElementById(id);
  if (!el) return;
  if (state.charts[id]) state.charts[id].destroy();
  cfg.options = cfg.options || {};
  state.charts[id] = new Chart(el.getContext("2d"), cfg);
}

/* items: [{label, value(원화)}] — 하단 범례 없이, 조각 위에 "#,###만(#%)",
   마우스오버 시 종목명 툴팁. 칸을 꽉 채운다. */
function drawPie(id, items) {
  const total = items.reduce((a, b) => a + (b.value || 0), 0) || 1;
  makeChart(id, {
    type: "doughnut",
    data: {
      labels: items.map((x) => x.label),
      datasets: [
        {
          data: items.map((x) => x.value || 0),
          backgroundColor: [
            "#22d3ee", "#f59e0b", "#22c55e", "#a855f7", "#ef4444", "#3b82f6",
            "#14b8a6", "#eab308", "#84cc16", "#ec4899", "#f97316", "#6366f1",
          ],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: 6 },
      cutout: "52%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed || 0;
              return `${ctx.label} — ${fmt.man(v)} (${Math.round((v / total) * 100)}%)`;
            },
          },
        },
        datalabels: {
          display: "auto",
          color: "#0f1216",
          font: { size: 11, weight: "600" },
          formatter: (v) => `${fmt.man(v)}(${Math.round((v / total) * 100)}%)`,
        },
      },
    },
  });
}
