/* 메-Stock 대시보드
 * - data/*.json (GitHub Actions 배치 산출물) 로드 → 차트/표 렌더
 * - 현재가/평가손익만 Cloudflare Worker 프록시로 페이지 로드 시 재조회
 *
 * 배포 후 할 일: 아래 PROXY_BASE 에 워커 URL 을 넣는다.
 *   비워두면 실시간 조회를 건너뛰고 종가(last_close)로 표시한다.
 */
const PROXY_BASE = "https://med-stock-proxy.dhcho.workers.dev"; // 비우면 실시간 조회 생략(종가 사용)

const FX_FALLBACK = 1350; // frankfurter 조회 실패 시 USD→KRW 대체 환율

const state = {
  dataBase: "./data",
  holdings: [],
  snapshot: null,
  prices: {},       // ticker -> prices json
  live: {},         // ticker -> {price, prevClose, currency,...}
  active: null,
  charts: {},       // canvasId -> Chart
  viewMode: "byTicker",              // "byTicker" | "byAccount"
  fx: null,                          // { USDKRW, date }
  sort: { key: null, dir: "desc" },  // 표 정렬 상태
  advisor: null,                     // data/advisor.json
  indices: null,                     // data/indices.json (새로고침 시 /indices 실시간으로 제자리 갱신)
  equity: null,                      // data/equity_curve.json
  eqRange: "1Y",                     // 자산 추이 기간: 1M 3M 6M 1Y 3Y ALL
  chartRange: "1Y",                  // 1W 1M 3M 6M 1Y 3Y 5Y
  ma: { ma5: true, ma20: true, ma60: true, ma120: true },
  overlay: { bbands: false, volume: true, buyprice: false, ichimoku: false },
  sub: { rsi: false, macd: false, stoch: false },
  rsiTf: "D", // RSI 봉 단위: D 일봉 | W 주봉 | M 월봉
  panel: null,                       // 현재 상세탭 캐시 {h, fund, flow, target, news}
  extras: [],                        // 보유목록 밖에서 + 로 추가한 종목 [{ticker,name,market,_adhoc:true}]
};

const EXTRAS_KEY = "medstock.extras";

const RANGE_DAYS = {
  "1W": 8, "1M": 31, "3M": 92, "6M": 184, "1Y": 366,
  "3Y": 1096, "5Y": 1827,
};

/* 가격 차트와 보조지표(MACD·RSI·스토캐스틱)의 세로축 폭을 고정해
   플롯 영역 좌우 끝을 일치시킨다 → 같은 날짜가 항상 같은 x 위치에 온다. */
const AXIS_Y_W = 64;

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
  try {
    if (window.Chart && window.ChartDataLabels) {
      Chart.register(window.ChartDataLabels);
      Chart.defaults.set("plugins.datalabels", { display: false }); // 도넛에서만 켠다
    }
    // 캔들: 한국 관습(상승 빨강 / 하락 파랑) — 데이터셋 옵션이 무시돼도 기본값으로 보장.
    // chartjs-chart-financial 은 borderColors/backgroundColors(복수형) 를 쓴다.
    if (window.Chart && Chart.defaults.elements) {
      const RED = "#ef4444", BLUE = "#3b82f6", GRAY = "#8b95a1";
      for (const el of ["candlestick", "ohlc"]) {
        const d = Chart.defaults.elements[el];
        if (!d) continue;
        d.borderColors = { up: RED, down: BLUE, unchanged: GRAY };
        d.backgroundColors = { up: RED, down: BLUE, unchanged: GRAY };
      }
    }
  } catch (_) {}
  document.getElementById("refreshBtn").addEventListener("click", refreshData);
  document.getElementById("advisorBtn").addEventListener("click", refreshAdvisor);
  document.getElementById("viewToggleBtn").addEventListener("click", () =>
    setViewMode(state.viewMode === "byAccount" ? "byTicker" : "byAccount")
  );
  const pieC = document.getElementById("pieCollapseBtn");
  if (pieC) pieC.addEventListener("click", togglePie);
  let _pc = "0";
  try { _pc = localStorage.getItem("medstock.pieCollapsed") || "0"; } catch (_) {}
  if (_pc === "1") setPieCollapsed(true, false);
  document.querySelectorAll("#posTable thead th").forEach((th) => {
    if (th.dataset.key) th.addEventListener("click", () => onSort(th.dataset.key));
  });
  try {
    state.dataBase = await resolveDataBase();
    const [holdings, snapshot, advisor, indices, fx, equity] = await Promise.all([
      getJSON(`${state.dataBase}/holdings.json`).catch(() => null),
      getJSON(`${state.dataBase}/snapshot.json`).catch(() => null),
      getJSON(`${state.dataBase}/advisor.json`).catch(() => null),
      getJSON(`${state.dataBase}/indices.json`).catch(() => null),
      getJSON("https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW")
        .catch(() => getJSON("https://api.frankfurter.app/latest?from=USD&to=KRW"))
        .catch(() => null),
      getJSON(`${state.dataBase}/equity_curve.json`).catch(() => null),
    ]);
    state.equity = equity;

    if (fx && fx.rates && fx.rates.KRW) state.fx = { USDKRW: fx.rates.KRW, date: fx.date };
    state.advisor = advisor;
    state.indices = indices;
    renderAdvisor();

    state.snapshot = snapshot;
    state.holdings =
      (holdings && holdings.holdings) ||
      (snapshot && snapshot.positions) ||
      [];

    if (!state.holdings.length) {
      return fail("보유종목이 비어 있습니다. GitHub 리포지토리의 holdings.yaml 을 수정하면 'Rebuild holdings' 워크플로가 data/holdings.json 을 재생성합니다.");
    }

    state.extras = loadExtras();

    // 가격 시계열 로드
    await Promise.all(
      state.holdings.map(async (h) => {
        state.prices[h.ticker] = await getJSON(`${state.dataBase}/prices/${h.ticker}.json`).catch(() => null);
      })
    );

    document.getElementById("asOf").textContent =
      "배치 기준일 " + ((snapshot && snapshot.as_of) || "—");
    setProvenance();

    buildTabs();
    syncViewToggleBtn();
    renderSummary();
    renderEquity();
    const eqRangeEl = document.getElementById("eqRange");
    if (eqRangeEl) {
      eqRangeEl.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-eqr]");
        if (!b || b.dataset.eqr === state.eqRange) return;
        state.eqRange = b.dataset.eqr;
        renderEquity();
      });
    }
    selectTicker(state.holdings[0].ticker);

    await refreshLive(); // 실시간 현재가
    connectLiveWS(); // 국내 보유종목 실시간 체결가 (NH PLUG WebSocket)
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

function renderAdvisor() {
  const el = document.getElementById("advisor");
  if (!el) return;
  const a = state.advisor;
  if (!a || !a.comment) {
    el.hidden = true;
  } else {
    el.hidden = false;
    el.innerHTML =
      `<span class="tag">AI Advisor :</span> ` +
      escapeHtml(a.comment) +
      (a.updated_at ? ` <span class="src">(${escapeHtml(shortDate(a.updated_at))})</span>` : "");
  }
  setProvenance();
}

/* 출처·갱신 스트립 (전문 통계 사이트처럼 데이터 출처를 항상 노출) */
function setProvenance() {
  const el = document.getElementById("provenance");
  if (!el) return;
  const asOf = (state.snapshot && state.snapshot.as_of) || "—";
  const adv =
    state.advisor && state.advisor.updated_at ? shortDate(state.advisor.updated_at) : "—";
  const S = '<span class="sep">·</span>';
  el.innerHTML =
    `시세 <b>실시간</b>(Cloudflare Worker 프록시)${S}` +
    `배치 데이터 <b>pykrx·FinanceDataReader</b>(KRX) / <b>yfinance</b>(해외)${S}` +
    `재무·수급·목표주가·뉴스 네이버 금융 / Google News` +
    `<br>AI Advisor <b>Google Gemini</b>${S}환율 frankfurter.dev` +
    `<br>최종 갱신 — 배치 <b>${escapeHtml(asOf)}</b>${S}Advisor <b>${escapeHtml(adv)}</b>`;
  el.hidden = false;
}

/* 일시적 완료 토스트 */
let _toastTimer = null;
function showToast(msg, ms = 2500) {
  const el = document.getElementById("toast");
  if (!el || !msg) return;
  el.textContent = msg;
  el.hidden = false;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => (el.hidden = true), 400);
  }, ms);
}

async function _withBusy(btn, fn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "…";
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ↻ 현재가 갱신: 프록시가 있으면 실시간 시세, 없으면 배치 JSON 재fetch */
async function refreshData() {
  await _withBusy(document.getElementById("refreshBtn"), async () => {
    const snap = await getJSON(`${state.dataBase}/snapshot.json?t=${Date.now()}`).catch(() => null);
    if (snap) state.snapshot = snap;
    await Promise.all(
      state.holdings.map(async (h) => {
        const p = await getJSON(`${state.dataBase}/prices/${h.ticker}.json?t=${Date.now()}`).catch(() => null);
        if (p) state.prices[h.ticker] = p;
      })
    );
    const eq = await getJSON(`${state.dataBase}/equity_curve.json?t=${Date.now()}`).catch(() => null);
    if (eq) state.equity = eq;
    for (const h of state.extras) delete state.prices[h.ticker]; // 추가종목은 다시 받도록
    if (snap && snap.as_of) document.getElementById("asOf").textContent = "배치 기준일 " + snap.as_of;
    renderSummary();
    renderEquity();
    await refreshLive();
    if (state.active) renderDetail(state.active);
    showToast(PROXY_BASE ? "현재가 갱신 완료" : "시세 데이터 갱신 완료");
  });
}

/* ↻ AI Advisor: 프록시가 있으면 GitHub 워크플로 트리거, 없으면 advisor.json 재fetch */
async function refreshAdvisor() {
  await _withBusy(document.getElementById("advisorBtn"), async () => {
    if (PROXY_BASE) {
      const r = await getJSON(`${PROXY_BASE}/dispatch?wf=advisor`).catch((e) => ({ error: String(e) }));
      if (r && r.ok) {
        showToast("AI Advisor + 대시보드 데이터 갱신 요청됨 · 2~5분 후 자동 반영", 4000);
        // 잠시 후부터 몇 차례 advisor.json 을 확인해 갱신되면 반영
        // (서술은 1~2분, 이어서 도는 전체 데이터 갱신은 3~5분 소요)
        const before = state.advisor && state.advisor.updated_at;
        for (let i = 0; i < 20; i++) {
          await new Promise((s) => setTimeout(s, 12000));
          const a = await getJSON(`${state.dataBase}/advisor.json?t=${Date.now()}`).catch(() => null);
          if (a && a.updated_at !== before) {
            state.advisor = a;
            renderAdvisor();
            showToast("AI Advisor 갱신 완료");
            return;
          }
        }
        return;
      }
      showToast("워크플로 트리거 실패 · 최신 코멘트만 불러옵니다");
    }
    const a = await getJSON(`${state.dataBase}/advisor.json?t=${Date.now()}`).catch(() => null);
    if (a) state.advisor = a;
    renderAdvisor();
    showToast(PROXY_BASE ? "" : "AI Advisor 불러오기 완료");
  });
}

/* ------------------------------------------------------------------ 실시간 현재가 */
async function refreshLive() {
  if (!PROXY_BASE) {
    // 프록시 미설정 → 종가로 대체
    for (const h of allHoldings()) {
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
  await Promise.all([
    ...allHoldings().map(async (h) => {
      try {
        const q = await getJSON(`${PROXY_BASE}/?ticker=${encodeURIComponent(h.ticker)}`);
        if (q && q.price != null) state.live[h.ticker] = q;
      } catch (e) {
        console.warn("live fail", h.ticker, e);
      }
    }),
    refreshIndicesLive(),
  ]);
  btn.disabled = false;
  btn.textContent = "↻ 현재가 갱신";

  renderSummary();
  renderIndices();
  if (state.active) renderDetail(state.active);
}

/* 지수/환율/원자재/암호화폐 실시간 갱신 — 배치 data/indices.json 의 items 를 제자리 갱신 */
async function refreshIndicesLive() {
  if (!PROXY_BASE) return;
  try {
    const live = await getJSON(`${PROXY_BASE}/indices`);
    if (!live || !live.items || !live.items.length) return;
    if (!state.indices) state.indices = { items: [] };
    const byKey = new Map(state.indices.items.map((x) => [x.key, x]));
    for (const it of live.items) {
      if (it.price == null) continue; // 실패한 항목은 배치값 유지
      byKey.set(it.key, { key: it.key, name: it.name, price: it.price, prev: it.prev, change: it.change, change_pct: it.change_pct, fmt: it.fmt });
    }
    state.indices = { items: [...byKey.values()], updated_at: live.updated_at, live: true };
  } catch (e) {
    console.warn("indices live fail", e);
  }
}

/* ------------------------------------------------------------------ 실시간 체결가 (WebSocket) */
// NH PLUG WebSocket 은 국내(KRX)만 지원(해외는 GIC 15자리 코드가 필요해 미지원).
// 연결이 끊기면 지수백오프(5s→60s)로 재연결. 틱은 300ms 묶어 한 번만 렌더.
let _ws = null;
let _wsBackoff = 5000;
let _wsRenderTimer = null;

function connectLiveWS() {
  if (!PROXY_BASE) return;
  const tickers = allHoldings()
    .map((h) => h.ticker)
    .filter((t) => /^\d[0-9A-Z]{5}$/.test(t));
  if (!tickers.length) return;

  let ws;
  try {
    const wsBase = PROXY_BASE.replace(/^http/, "ws");
    ws = new WebSocket(`${wsBase}/ws?tickers=${encodeURIComponent(tickers.join(","))}`);
  } catch (e) {
    console.warn("live ws open fail", e);
    scheduleWsReconnect();
    return;
  }
  _ws = ws;
  ws.addEventListener("open", () => { _wsBackoff = 5000; });
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type !== "tick" || !msg.ticker || msg.price == null) return;
    state.live[msg.ticker] = {
      ticker: msg.ticker,
      price: msg.price,
      prevClose: msg.prevClose,
      changePct: msg.changePct,
      currency: "KRW",
      source: "nhplug-ws",
      ts: msg.ts || Date.now(),
    };
    scheduleWsRender();
  });
  ws.addEventListener("close", scheduleWsReconnect);
  ws.addEventListener("error", () => { try { ws.close(); } catch (_) {} });
}

function scheduleWsReconnect() {
  _ws = null;
  setTimeout(connectLiveWS, _wsBackoff);
  _wsBackoff = Math.min(_wsBackoff * 2, 60000);
}

function scheduleWsRender() {
  if (_wsRenderTimer) return;
  _wsRenderTimer = setTimeout(() => {
    _wsRenderTimer = null;
    renderSummary();
    if (state.active) renderDetail(state.active);
  }, 300);
}

/* live 우선 → last_close → 종가 배열의 마지막 유효값 */
function priceOf(ticker) {
  const l = state.live[ticker];
  if (l && l.price != null) return l.price;
  const p = state.prices[ticker];
  if (!p) return null;
  if (p.last_close != null) return p.last_close;
  if (Array.isArray(p.close)) {
    for (let i = p.close.length - 1; i >= 0; i--) if (p.close[i] != null) return p.close[i];
  }
  return null;
}

/* ------------------------------------------------------------------ 요약 */
function syncViewToggleBtn() {
  const b = document.getElementById("viewToggleBtn");
  if (b) {
    b.textContent = state.viewMode === "byAccount" ? "종목별" : "회사별";
    b.classList.toggle("on", state.viewMode === "byAccount");
  }
}

function setViewMode(mode) {
  state.viewMode = mode === "byAccount" ? "byAccount" : "byTicker";
  syncViewToggleBtn();
  renderSummary(); // 도넛 + 표 갱신
  updateAcctStrip(); // 상세는 계좌 스트립만 토글 (지수/뉴스/차트 재렌더 안 함)
}

/* 원그래프 접기/펼치기 — 접으면 종목 표가 가로 1칸을 전부 차지 */
function setPieCollapsed(on, redraw = true) {
  const wrap = document.querySelector(".summary-charts");
  if (!wrap) return;
  wrap.classList.toggle("pie-collapsed", !!on);
  const b = document.getElementById("pieCollapseBtn");
  if (b) b.textContent = on ? "원그래프 펼치기" : "원그래프 접기";
  try { localStorage.setItem("medstock.pieCollapsed", on ? "1" : "0"); } catch (_) {}
  if (on) {
    // 도넛 인스턴스를 완전히 파기 (responsive 리사이즈 옵저버가 남으면 캔버스가 무한 확장됨)
    if (state.charts && state.charts.weightChart) {
      try { state.charts.weightChart.destroy(); } catch (_) {}
      delete state.charts.weightChart;
    }
  } else if (redraw) {
    renderSummary(); // 펼칠 때 도넛 새로 그림
  }
}
function togglePie() {
  const wrap = document.querySelector(".summary-charts");
  setPieCollapsed(!(wrap && wrap.classList.contains("pie-collapsed")));
}

/* 회사별↔종목별 시 상세 상단 계좌 스트립만 갱신 */
function updateAcctStrip() {
  const el = document.getElementById("acctStrip");
  if (!el || !state.panel) return;
  el.innerHTML = state.viewMode === "byAccount" ? acctStripHtml(state.panel.h) : "";
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

/* 해당 종목 '주가'의 전일대비 변동 (1주당, 환종 유지) + %.
   마지막 봉이 결측이어도 유효한 최근 2개 종가로 계산 */
function dayChangeOf(ticker) {
  const l = state.live[ticker];
  const p = state.prices[ticker];
  let c2 = null, c1 = null; // 최근 유효 종가, 그 직전
  if (p && Array.isArray(p.close)) {
    for (let i = p.close.length - 1; i >= 0 && c1 == null; i--) {
      if (p.close[i] == null) continue;
      if (c2 == null) c2 = p.close[i];
      else c1 = p.close[i];
    }
  }
  const cur = l && l.price != null ? l.price : p && p.last_close != null ? p.last_close : c2;
  const prev =
    l && l.prevClose != null ? l.prevClose
    : p && p.prev_close != null && p.prev_close !== cur ? p.prev_close
    : c1;
  if (cur == null || prev == null) return { px: null, pct: null };
  return { px: cur - prev, pct: prev ? ((cur - prev) / prev) * 100 : null };
}

/* ▲/▼ 전일대비 셀 HTML — 주가 변동(1주당) */
function dayCell(ticker, market) {
  const { px, pct } = dayChangeOf(ticker);
  if (px == null || px === 0) return `<td class="dim">-</td>`;
  const up = px > 0;
  return `<td class="${up ? "pos" : "neg"}">${up ? "▲" : "▼"} ${fmt.price(Math.abs(px), market)} (${fmt.pct(pct)})</td>`;
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
    case "day": return dayChangeOf(r.h.ticker).pct;
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
  renderSummary(false); // 정렬은 표만 다시 그리고 도넛은 그대로
}

function markSortHeader() {
  document.querySelectorAll("#posTable thead th").forEach((th) => {
    const base = th.dataset.label || th.textContent.replace(/[▲▼]\s*$/, "").trim();
    th.dataset.label = base;
    th.textContent = base + (th.dataset.key === state.sort.key ? (state.sort.dir === "asc" ? " ▲" : " ▼") : "");
  });
}

function renderSummary(withPie = true) {
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
  // 총 평가손익: 금액 (수익률%) 한 칸에
  const plEl = setText(
    "sumPl",
    pl == null ? "—" : `${fmt.wonSigned(pl)} (${fmt.pct(plPct)})`
  );
  plEl.className = "value " + (pl == null ? "" : pl < 0 ? "neg" : "pos");

  // 전일대비: (오늘 평가액 − 전일 종가 기준 평가액), 금액 (변동%) 한 칸에
  let vToday = 0, vPrev = 0, dayOk = true;
  for (const r of rows) {
    const p = state.prices[r.h.ticker];
    const cur = priceOf(r.h.ticker);
    const prev = p ? (p.prev_close ?? (p.close && p.close[p.close.length - 2])) : null;
    if (cur == null || prev == null) { dayOk = false; break; }
    vToday += toKRW(cur * r.h.quantity, r.h.market);
    vPrev += toKRW(prev * r.h.quantity, r.h.market);
  }
  const dayChg = dayOk ? vToday - vPrev : null;
  const dayPct = dayOk && vPrev ? (dayChg / vPrev) * 100 : null;
  const dayEl = setText(
    "sumDay",
    dayChg == null ? "—" : `${fmt.wonSigned(dayChg)} (${fmt.pct(dayPct)})`
  );
  dayEl.className = "value " + (dayChg == null ? "" : dayChg < 0 ? "neg" : "pos");

  markSortHeader();
  if (state.viewMode === "byAccount") renderByAccount(applySort(rows), withPie);
  else renderByTicker(applySort(rows), withPie);
}

/* ================= 자산 추이 (data/equity_curve.json) ================= */
const EQ_RANGE_BTNS = [
  ["1M", "1M"], ["3M", "3M"], ["6M", "6M"], ["1Y", "1Y"], ["3Y", "3Y"], ["ALL", "전체"],
];
const EQ_RANGE_DAYS = { "1M": 31, "3M": 92, "6M": 184, "1Y": 366, "3Y": 1096, "ALL": null };

/* 금액 축약: 1억 이상 "N.N억", 1만 이상 "N만", 그 외 원 단위 */
function eqWon(v) {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(a >= 1e10 ? 0 : 1) + "억";
  if (a >= 1e4) return Math.round(v / 1e4).toLocaleString("ko-KR") + "만";
  return Math.round(v).toLocaleString("ko-KR");
}

function renderEquity() {
  const box = document.getElementById("equityBlock");
  if (!box) return;
  const eq = state.equity;
  if (!eq || !Array.isArray(eq.points) || eq.points.length < 2) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  document.getElementById("eqRange").innerHTML = EQ_RANGE_BTNS
    .map(([k, l]) => `<button type="button" data-eqr="${k}"${state.eqRange === k ? ' class="on"' : ""}>${l}</button>`)
    .join("");

  const days = EQ_RANGE_DAYS[state.eqRange];
  let full = eq.points;
  if (days) {
    const cut = new Date(full[full.length - 1].d).valueOf() - days * 864e5;
    full = full.filter((p) => new Date(p.d).valueOf() >= cut);
  }
  if (full.length < 2) full = eq.points.slice(-2);

  const last = eq.last || full[full.length - 1];
  const first = full[0];
  // 구간 내 전고점 — 다운샘플 전 원본에서 계산
  let wp = full[0];
  for (const p of full) if (p.v > wp.v) wp = p;

  // 과다 포인트 스트라이드 샘플링 (마지막 + 전고점 포함)
  let pts = full;
  if (pts.length > 500) {
    const stride = Math.ceil(pts.length / 500);
    pts = pts.filter((_, i) => i % stride === 0);
    if (pts[pts.length - 1] !== full[full.length - 1]) pts.push(full[full.length - 1]);
    if (!pts.includes(wp)) {
      pts.push(wp);
      pts.sort((a, b) => (a.d < b.d ? -1 : 1));
    }
  }
  const vsPeak = wp.v ? (last.v / wp.v - 1) * 100 : null;
  const vsCost = last.c ? (last.v / last.c - 1) * 100 : null;
  const vsStart = first.v ? (last.v / first.v - 1) * 100 : null;

  const stat = (label, val, cls2 = "") => `<span class="eq-stat"><i>${label}</i><b class="${cls2}">${val}</b></span>`;
  document.getElementById("eqStats").innerHTML =
    stat("현재 평가액", eqWon(last.v)) +
    stat(`구간 전고점 <em>${wp.d}</em>`, eqWon(wp.v)) +
    stat("전고점 대비", vsPeak == null ? "—" : fmt.pct(vsPeak), cls(vsPeak)) +
    (vsCost == null ? "" : stat("원금 대비", fmt.pct(vsCost), cls(vsCost))) +
    stat(`${state.eqRange === "ALL" ? "시작" : "구간 시작"} 대비`, vsStart == null ? "—" : fmt.pct(vsStart), cls(vsStart));

  const note = [];
  if (eq.assumption === "ledger") {
    note.push("※ transactions.csv 의 매수·매도 이력으로 재구성. 일봉 시세가 있는 종목만 포함되며(상장폐지·비상장 제외), 입출금·배당은 반영되지 않습니다.");
  } else if (eq.assumption === "buy_date") {
    note.push("※ buy_date 가 있는 종목은 매수일부터, 없는 종목은 현재 수량으로 전 구간 소급. 매도·입출금은 반영되지 않습니다.");
  } else {
    note.push("※ 현재 보유 수량을 과거 종가에 소급한 가상 곡선. transactions.csv 에 매매 이력을 넣으면 실제 곡선으로 바뀝니다. 매도·입출금은 반영되지 않습니다.");
  }
  if (eq.assumption !== "ledger" && eq.first_full_date && eq.first_full_date > eq.points[0].d)
    note.push(`전 종목이 데이터에 잡히는 시점: ${eq.first_full_date}`);
  document.getElementById("eqNote").textContent = note.join(" ");

  _eqDraw = { pts, wp };
  drawEquityChart(pts, wp, null);

  // 특정일 평가금액 조회
  const di = document.getElementById("eqDate");
  if (di) {
    di.min = eq.points[0].d;
    di.max = eq.points[eq.points.length - 1].d;
    if (di.value < di.min || di.value > di.max) di.value = "";
    di.onchange = () => { eqShowAsOf(di.value); if (di.value) eqOpenTable(di.value); };
    const tb = document.getElementById("eqTableBtn");
    if (tb) { tb.hidden = !di.value; tb.onclick = () => di.value && eqOpenTable(di.value); }
    if (di.value) eqShowAsOf(di.value);
    else document.getElementById("eqAsof").textContent = "";
  }
  const mc = document.getElementById("eqModalClose");
  if (mc) mc.onclick = () => { document.getElementById("eqModal").hidden = true; };
  const mo = document.getElementById("eqModal");
  if (mo) mo.onclick = (e) => { if (e.target === mo) mo.hidden = true; };
}

let _eqDraw = null;

function eqShowAsOf(dateStr) {
  const out = document.getElementById("eqAsof");
  const eq = state.equity;
  if (!out || !eq || !dateStr) { if (out) out.textContent = ""; return; }
  const pts = eq.points;
  let hit = null;
  for (const p of pts) { if (p.d <= dateStr) hit = p; else break; }
  if (!hit) hit = pts[0];
  const pnl = hit.v - hit.c;
  const pct = hit.c ? (pnl / hit.c) * 100 : null;
  out.innerHTML =
    `<b>${hit.d}</b> 기준 · 평가 <b>${eqWon(hit.v)}</b> · 원금 ${eqWon(hit.c)} · ` +
    `<b class="${cls(pnl)}">손익 ${pnl < 0 ? "-" : "+"}${eqWon(Math.abs(pnl))}${pct == null ? "" : ` (${fmt.pct(pct)})`}</b>`;
  const tb = document.getElementById("eqTableBtn");
  if (tb) tb.hidden = false;
  if (_eqDraw) drawEquityChart(_eqDraw.pts, _eqDraw.wp, hit);
}

/* ── 특정일 보유내역 표 (모달) ── */
let _eqTx = null, _eqPrices = null, _eqLoading = null;

async function eqEnsureData() {
  if (_eqTx && _eqPrices) return true;
  if (!_eqLoading) {
    _eqLoading = Promise.all([
      getJSON(`${state.dataBase}/equity_tx.json`).catch(() => null),
      getJSON(`${state.dataBase}/equity_prices.json`).catch(() => null),
    ]).then(([tx, pr]) => {
      _eqTx = tx; _eqPrices = pr && pr.series ? pr.series : null;
    });
  }
  await _eqLoading;
  return !!(_eqTx && _eqTx.tx);
}

function _asOfClose(map, d) {           // {date: close} 에서 d 이하 마지막 값
  if (!map) return null;
  let best = null;
  for (const k in map) if (k <= d && (best === null || k > best)) best = k;
  return best === null ? null : map[best];
}
function _fxOn(d) {
  const f = _eqTx && _eqTx.fx;
  return _asOfClose(f, d) || (f ? Object.values(f).slice(-1)[0] : 1350) || 1350;
}

async function eqOpenTable(dateStr) {
  const modal = document.getElementById("eqModal");
  const body = document.getElementById("eqModalBody");
  const title = document.getElementById("eqModalTitle");
  if (!modal || !body) return;
  modal.hidden = false;
  title.textContent = `${dateStr} 기준 보유내역`;
  body.innerHTML = "<div class='muted'>불러오는 중…</div>";
  if (!(await eqEnsureData())) { body.innerHTML = "<div class='error'>데이터를 불러오지 못했습니다.</div>"; return; }

  // 거래 리플레이 → 종목별 수량·평균매수원가(원)
  const pos = {}, cost = {}, solidAfter = {};
  for (const row of _eqTx.tx) {
    const [d, t, sq, px, isUs] = row;
    if (d > dateStr) { solidAfter[t] = 1; continue; }
    const rate = isUs ? _fxOn(d) : 1;
    if (sq > 0) { pos[t] = (pos[t] || 0) + sq; cost[t] = (cost[t] || 0) + sq * px * rate; }
    else {
      const have = pos[t] || 0, avg = have > 0 ? (cost[t] || 0) / have : 0;
      const sold = Math.min(-sq, have);
      pos[t] = have - sold; cost[t] = Math.max(0, (cost[t] || 0) - sold * avg);
    }
  }
  // 이력이 불완전한 '유령 보유' 제거: 기준일 이후 거래가 있거나(그때 실제 보유)
  // 지금도 보유 중인 종목만 남긴다.
  const heldNow = new Set(state.holdings.map((h) => h.ticker));
  for (const t in pos) if (pos[t] > 1e-6 && !(solidAfter[t] || heldNow.has(t))) delete pos[t];

  const priced = [], unpriced = [];
  for (const t in pos) {
    const q = pos[t];
    if (q <= 1e-6) continue;
    const c = cost[t], avg = c / q;
    const isUs = (_eqTx.tx.find((x) => x[1] === t) || [])[4] || 0;
    let closeNative = null;
    const cur = state.prices[t];
    if (cur && cur.dates && cur.close) {
      for (let k = cur.dates.length - 1; k >= 0; k--) if (cur.dates[k] <= dateStr && cur.close[k] != null) { closeNative = cur.close[k]; break; }
    }
    if (closeNative == null) closeNative = _asOfClose(_eqPrices && _eqPrices[t], dateStr);
    const priceKRW = closeNative == null ? null : closeNative * (isUs ? _fxOn(dateStr) : 1);
    const rec = { name: (_eqTx.names && _eqTx.names[t]) || t, t, q, avg, c, isUs,
                  v: priceKRW == null ? null : q * priceKRW };
    (rec.v == null ? unpriced : priced).push(rec);
  }
  priced.sort((a, b) => b.v - a.v);
  unpriced.sort((a, b) => b.c - a.c);

  if (!priced.length && !unpriced.length) {
    body.innerHTML = "<div class='muted'>해당일 보유 종목이 없습니다.</div>"; return;
  }
  const tr = (r) => {
    const pnl = r.v - r.c, pct = r.c ? (pnl / r.c) * 100 : null;
    return `<tr>
      <td class="l">${escapeHtml(r.name)}${r.isUs ? ' <span class="us">$</span>' : ""}</td>
      <td>${fmt.num(r.q, 4)}</td><td>${fmt.won(r.avg)}</td><td>${fmt.won(r.v)}</td>
      <td class="${cls(pnl)}">${fmt.wonSigned(pnl)}</td>
      <td class="${cls(pct)}">${pct == null ? "—" : fmt.pct(pct)}</td>
    </tr>`;
  };
  const totV = priced.reduce((a, r) => a + r.v, 0);
  const totC = priced.reduce((a, r) => a + r.c, 0);
  const tPnl = totV - totC, tPct = totC ? (tPnl / totC) * 100 : null;
  const unpC = unpriced.reduce((a, r) => a + r.c, 0);

  body.innerHTML =
    (dateStr < "2024-07-01"
      ? `<div class="eq-warn">⚠ 2024년 이전 구간입니다. 액면분할·무상증자·공모주·일부 매도가 이력에 없어
         수량·평균매수가·수익률이 실제와 다를 수 있습니다. (곡선상 그날 평가금액은 상단 요약을 참고)</div>`
      : "") +
    (priced.length
      ? `<table class="eq-htbl"><thead><tr>
           <th class="l">종목</th><th>수량</th><th>평균매수가</th><th>평가금액</th><th>평가손익</th><th>수익률</th>
         </tr></thead><tbody>${priced.map(tr).join("")}</tbody>
         <tfoot><tr>
           <td class="l">합계 <span class="muted">(시세 있는 ${priced.length}종목)</span></td>
           <td></td><td>${fmt.won(totC)}</td><td>${fmt.won(totV)}</td>
           <td class="${cls(tPnl)}">${fmt.wonSigned(tPnl)}</td>
           <td class="${cls(tPct)}">${tPct == null ? "—" : fmt.pct(tPct)}</td>
         </tr></tfoot></table>`
      : "<div class='muted'>이 날짜에 시세가 있는 보유 종목이 없습니다.</div>") +
    (unpriced.length
      ? `<div class="eq-unpriced"><b>시세 없는 계산상 보유 ${unpriced.length}종목</b>` +
        ` (상장폐지·비상장이거나 이력 누락분) — 평가 생략<br>` +
        `<span class="muted">${unpriced.slice(0, 8).map((r) => escapeHtml(r.name)).join(" · ")}` +
        `${unpriced.length > 8 ? " …" : ""}</span></div>`
      : "") +
    `<p class="eq-hnote">금액은 원화 환산(미국 $ 종목은 그날 환율). ` +
    `공모주 배정·무상증자·액면분할·일부 매도가 이력에 없어 <b>오래된 종목의 수량·평균매수가·수익률이 부정확</b>할 수 있습니다 — 최근 1~2년이 가장 정확.</p>`;
}

function drawEquityChart(pts, peak, asOf) {
  const X = (p) => new Date(p.d).valueOf();
  makeChart("equityChart", {
    data: {
      datasets: [
        {
          type: "line",
          label: "평가액",
          data: pts.map((p) => ({ x: X(p), y: p.v })),
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245,158,11,.10)",
          borderWidth: 1.6, pointRadius: 0, fill: "origin", tension: 0, order: 2,
        },
        {
          type: "line",
          label: "원금",
          data: pts.map((p) => ({ x: X(p), y: p.c })),
          borderColor: "#8b95a1", borderWidth: 1, borderDash: [5, 4],
          pointRadius: 0, fill: false, tension: 0, order: 1,
        },
        {
          label: "구간 전고점",
          data: [{ x: X(peak), y: peak.v }],
          type: "scatter",
          pointRadius: 4, pointHoverRadius: 5,
          pointBackgroundColor: "#ef4444", pointBorderColor: "#fff", pointBorderWidth: 1,
          showLine: false, order: 3,
          datalabels: {
            display: true, anchor: "center", align: "start", offset: 8, clamp: true,
            color: "#fca5a5", font: { size: 10, weight: "700" },
            backgroundColor: "rgba(15,18,22,.82)", borderRadius: 4, padding: { x: 5, y: 2 },
            formatter: () => "전고점 " + eqWon(peak.v),
          },
        },
        ...(asOf ? [{
          label: "선택일",
          data: [{ x: X(asOf), y: asOf.v }],
          type: "scatter",
          pointRadius: 5, pointHoverRadius: 6,
          pointBackgroundColor: "#22d3ee", pointBorderColor: "#fff", pointBorderWidth: 1,
          showLine: false, order: 4,
          datalabels: {
            display: true, anchor: "center", align: "end", offset: 8, clamp: true,
            color: "#67e8f9", font: { size: 10, weight: "700" },
            backgroundColor: "rgba(15,18,22,.82)", borderRadius: 4, padding: { x: 5, y: 2 },
            formatter: () => `${asOf.d}  ${eqWon(asOf.v)}`,
          },
        }] : []),
      ],
    },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "time",
          time: { tooltipFormat: "yyyy-MM-dd" },
          grid: { display: false },
          ticks: { color: "#8b95a1", maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
        },
        y: {
          position: "right",
          afterFit: (s) => { s.width = AXIS_Y_W; },
          ticks: { color: "#8b95a1", callback: (v) => eqWon(v) },
          grid: { color: "#2b333d40" },
        },
      },
      plugins: {
        legend: {
          display: true, position: "bottom",
          labels: {
            color: "#8b95a1", boxWidth: 12, font: { size: 11 },
            filter: (it) => it.text !== "구간 전고점" && it.text !== "선택일",
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString("ko-KR")}원`,
          },
        },
      },
    },
  });
}

/* 한 포지션 행 <td> 묶음. 단가/현재가는 환종 유지, 금액류는 원화 환산. */
function posCells({ h, cur, cost, value, pl, plPct }, weightPct) {
  const m = h.market;
  return `
    <td>${fmt.num(h.quantity, 4)}</td>
    <td>${fmt.price(h.buy_price, m)}</td>
    <td>${fmt.price(cur, m)}</td>
    ${dayCell(h.ticker, m)}
    <td>${fmt.won(toKRW(cost, m))}</td>
    <td>${value == null ? "—" : fmt.won(toKRW(value, m))}</td>
    <td class="${cls(pl)}">${pl == null ? "—" : fmt.wonSigned(toKRW(pl, m))}</td>
    <td class="${cls(plPct)}">${fmt.pct(plPct)}</td>
    <td>${weightPct == null ? "—" : weightPct.toFixed(1) + "%"}</td>`;
}

/* ---- 종목별 조회: 계좌 무관, 통합 평단가 한 줄 ---- */
function renderByTicker(rows, withPie = true) {
  const items = rows.map((r) => ({
    label: r.h.name || r.h.ticker,
    value: toKRW(r.value, r.h.market) ?? toKRW(r.cost, r.h.market),
  }));
  if (withPie) drawPie("weightChart", items);
  const sumW = items.reduce((a, b) => a + b.value, 0) || 1;

  document.querySelector("#posTable tbody").innerHTML = rows
    .map((r, i) => `<tr class="lvl-ticker">
        <td>${escapeHtml(r.h.name || r.h.ticker)}</td>
        ${posCells(r, (items[i].value / sumW) * 100)}
      </tr>`)
    .join("");
}

/* ---- 회사별 조회: 종목별로 나오되 계좌 버블 + 계좌별 매수금액/수량/평가액 ---- */
function renderByAccount(rows, withPie = true) {
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
  if (withPie) drawPie("weightChart", pieItems);
  const sumW = pieItems.reduce((a, b) => a + b.value, 0) || 1;

  const html = [];
  for (const r of rows) {
    const lots = lotsOf(r.h);
    const tW = (toKRW(r.value, r.h.market) ?? toKRW(r.cost, r.h.market)) / sumW * 100;
    html.push(`<tr class="lvl-ticker">
      <td>${escapeHtml(r.h.name || r.h.ticker)} <span class="src">${lots.length}개 계좌</span></td>
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
/* 보유종목 + 추가종목 통합 조회 */
function allHoldings() {
  return [...state.holdings, ...state.extras];
}
function findHolding(ticker) {
  return allHoldings().find((x) => x.ticker === ticker) || null;
}

function loadExtras() {
  try {
    const a = JSON.parse(localStorage.getItem(EXTRAS_KEY) || "[]");
    return Array.isArray(a)
      ? a.filter((x) => x && x.ticker).map((x) => ({ ...x, _adhoc: true }))
      : [];
  } catch (_) {
    return [];
  }
}
function saveExtras() {
  try {
    localStorage.setItem(
      EXTRAS_KEY,
      JSON.stringify(state.extras.map(({ ticker, name, market }) => ({ ticker, name, market })))
    );
  } catch (_) {}
}
function addExtra({ ticker, name, market }) {
  ticker = String(ticker || "").trim().toUpperCase();
  if (!ticker) return;
  if (allHoldings().some((x) => x.ticker === ticker)) {
    selectTicker(ticker);
    return;
  }
  if (!market) market = /^\d[0-9A-Z]{5}$/.test(ticker) ? "KOSPI" : "US";
  state.extras.push({ ticker, name: name || ticker, market, _adhoc: true });
  saveExtras();
  buildTabs();
  selectTicker(ticker);
}
function removeExtra(ticker) {
  state.extras = state.extras.filter((x) => x.ticker !== ticker);
  delete state.prices[ticker];
  saveExtras();
  buildTabs();
  if (state.active === ticker) selectTicker((state.holdings[0] || {}).ticker);
}

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
  for (const h of state.extras) {
    const b = document.createElement("button");
    b.className = "tab-extra";
    b.dataset.ticker = h.ticker;
    b.innerHTML = `${escapeHtml(h.name || h.ticker)}<span class="tab-x" title="제거">×</span>`;
    b.addEventListener("click", (e) => {
      if (e.target.classList.contains("tab-x")) removeExtra(h.ticker);
      else selectTicker(h.ticker);
    });
    nav.appendChild(b);
  }
  nav.appendChild(buildAddControl());
}

/* + 버튼 + 검색 팝오버 */
function buildAddControl() {
  const wrap = document.createElement("span");
  wrap.className = "tab-add-wrap";
  wrap.innerHTML = `
    <button class="tab-add" title="종목 추가">+</button>
    <div class="tab-add-pop" hidden>
      <input type="text" placeholder="회사명 또는 종목코드" autocomplete="off" />
      <ul class="tab-add-res"></ul>
    </div>`;
  const btn = wrap.querySelector(".tab-add");
  const pop = wrap.querySelector(".tab-add-pop");
  const inp = wrap.querySelector("input");
  const res = wrap.querySelector(".tab-add-res");

  const close = () => { pop.hidden = true; res.innerHTML = ""; inp.value = ""; };
  const open = () => { pop.hidden = false; inp.focus(); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });

  let timer = null;
  const runSearch = async () => {
    const q = inp.value.trim();
    if (!q) { res.innerHTML = ""; return; }
    if (/^\d[0-9A-Za-z]{5}$/.test(q)) {
      res.innerHTML = `<li data-code="${q.toUpperCase()}" data-name="${q.toUpperCase()}">${q.toUpperCase()} <span class="dim">코드로 추가</span></li>`;
    }
    if (!PROXY_BASE) {
      if (!res.innerHTML) res.innerHTML = "<li class='dim'>PROXY_BASE 미설정 — 코드 6자리로만 추가 가능</li>";
      return;
    }
    try {
      const r = await getJSON(`${PROXY_BASE}/search?q=${encodeURIComponent(q)}`);
      const rows = (r.items || []).slice(0, 10)
        .map((x) => `<li data-code="${escapeHtml(x.code)}" data-name="${escapeHtml(x.name)}" data-market="${escapeHtml(x.market || "")}">${escapeHtml(x.name)} <span class="dim">${escapeHtml(x.code)}${x.market ? " · " + escapeHtml(x.market) : ""}</span></li>`)
        .join("");
      res.innerHTML = (res.innerHTML || "") + (rows || "<li class='dim'>결과 없음</li>");
    } catch (_) {
      if (!res.innerHTML) res.innerHTML = "<li class='dim'>검색 실패</li>";
    }
  };
  inp.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 220); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = res.querySelector("li[data-code]");
      if (first) first.click();
    } else if (e.key === "Escape") close();
  });
  res.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-code]");
    if (!li) return;
    addExtra({ ticker: li.dataset.code, name: li.dataset.name, market: li.dataset.market });
    close();
  });
  return wrap;
}

function selectTicker(ticker) {
  state.active = ticker;
  document.querySelectorAll("#tabs button[data-ticker]").forEach((b) => {
    b.classList.toggle("active", b.dataset.ticker === ticker);
  });
  renderDetail(ticker);
}

/* ------------------------------------------------------------------ 종목 상세 */
const RANGE_BTNS = [
  ["1W", "1주"], ["1M", "1개월"], ["3M", "3개월"], ["6M", "6개월"],
  ["1Y", "1년"], ["3Y", "3년"], ["5Y", "5년"],
];
const MA_BTNS = [["ma5", "MA5"], ["ma20", "MA20"], ["ma60", "MA60"], ["ma120", "MA120"]];
const OV_BTNS = [["bbands", "볼린저밴드"], ["volume", "거래량"], ["buyprice", "내 매수가"], ["ichimoku", "일목균형표"]];

function chartCtlHtml() {
  const g = (arr, attr, on) =>
    arr
      .map(([k, label]) => `<button data-${attr}="${k}"${on(k) ? ' class="on"' : ""}>${label}</button>`)
      .join("");
  const subBtn = (k, label) => `<button data-sub="${k}"${state.sub[k] ? ' class="on"' : ""}>${label}</button>`;
  return `
    <div class="ctl-row"><span class="ctl-lbl">기간</span>${g(RANGE_BTNS, "range", (k) => state.chartRange === k)}</div>
    <div class="ctl-row"><span class="ctl-lbl">이동평균</span>${g(MA_BTNS, "ma", (k) => state.ma[k])}</div>
    <div class="ctl-row"><span class="ctl-lbl">보조지표</span>${g(OV_BTNS, "ov", (k) => state.overlay[k])}${subBtn("rsi", "RSI")}${subBtn("macd", "MACD")}${subBtn("stoch", "스토캐스틱")}</div>`;
}

function isEtf(h) {
  return h && (h.type === "ETF" || /^(KODEX|TIGER|KBSTAR|ARIRANG|HANARO|KOSEF|KINDEX|ACE|PLUS|RISE|SOL|TIMEFOLIO)\b/i.test(h.name || ""));
}

async function renderDetail(ticker) {
  const h = findHolding(ticker);
  if (h && h._adhoc && !state.prices[ticker]) await ensureAdhocPrice(h);
  const etf = isEtf(h);
  const main = document.getElementById("detail");
  main.innerHTML = `
    <div id="acctStrip">${state.viewMode === "byAccount" ? acctStripHtml(h) : ""}</div>
    <div class="panel-grid">
      <div class="pg-charts">
        <div class="block">
          <h3>차트</h3>
          <div class="chart-ctl" id="chartCtl">${chartCtlHtml()}</div>
          <canvas id="priceChart"></canvas>
        </div>
        <div class="block" id="signalBlock">
          <h3 class="h3-row">보조지표 신호<button class="sig-help-btn" id="sigHelpBtn" title="지표 설명" aria-label="지표 설명">?</button></h3>
          <div id="signalBox">로딩…</div>
          <div id="sigHelp" class="sig-help" hidden></div>
        </div>
        <div class="block sub-block${state.sub.macd ? "" : " collapsed"}" id="macdBlock"><h3>MACD (12·26·9)</h3><canvas id="macdChart"></canvas></div>
        <div class="block sub-block${state.sub.stoch ? "" : " collapsed"}" id="stochBlock"><h3>스토캐스틱 (14·3·3)</h3><canvas id="stochChart"></canvas></div>
        <div class="block sub-block${state.sub.rsi ? "" : " collapsed"}" id="rsiBlock">
          <h3 class="h3-row">RSI (14)<span class="tf-btns" id="rsiTf">${rsiTfBtns()}</span></h3>
          <canvas id="rsiChart"></canvas>
        </div>
        <div class="block"><h3 class="h3-row">수급 (최근 4주)<span class="unit-tag">(억원)</span></h3><canvas id="flowChart" height="90"></canvas></div>
        ${etf ? "" : `<div class="block"><h3>투자의견 컨센서스</h3><div id="consensusBox" class="tbl-scroll">로딩…</div></div>`}
      </div>
      <div class="pg-metrics">
        <div class="block"><h3>기본 지표</h3><div id="fundBox">로딩…</div></div>
        ${etf
          ? `<div class="block"><h3>구성 종목</h3><div id="etfBox">로딩…</div></div>`
          : `<div class="block"><h3>목표주가 갭</h3><div id="targetBox">로딩…</div></div>
        <div class="block"><h3>주가전망</h3><div id="forecastBox">로딩…</div></div>`}
      </div>
      <div class="pg-market">
        <div class="block"><h3>주요 지수</h3><div id="indicesBox">로딩…</div></div>
        <div class="block"><h3>최근 뉴스</h3><ul class="news" id="newsBox"><li>로딩…</li></ul></div>
      </div>
    </div>`;

  document.getElementById("chartCtl").addEventListener("click", onChartCtl);

  let fund, flow, target, news, etfData = null, sigDoc = null;
  if (h && h._adhoc) {
    // 추가 종목: 워커에서 기본지표·목표주가·수급·뉴스를 한 번에
    const info = PROXY_BASE
      ? await getJSON(`${PROXY_BASE}/stockinfo?ticker=${encodeURIComponent(ticker)}`).catch(() => null)
      : null;
    fund = info && info.fundamentals;
    flow = info && info.flow;
    target = info && info.target;
    news = info && info.news;
  } else {
    [fund, flow, target, news, etfData, sigDoc] = await Promise.all([
      getJSON(`${state.dataBase}/fundamentals/${ticker}.json`).catch(() => null),
      getJSON(`${state.dataBase}/flows/${ticker}.json`).catch(() => null),
      etf ? Promise.resolve(null) : getJSON(`${state.dataBase}/targets/${ticker}.json`).catch(() => null),
      getJSON(`${state.dataBase}/news/${ticker}.json`).catch(() => null),
      etf ? getJSON(`${state.dataBase}/etf/${ticker}.json`).catch(() => null) : Promise.resolve(null),
      getJSON(`${state.dataBase}/signals/${ticker}.json`).catch(() => null),
    ]);
  }
  state.panel = { h, fund, flow, target, news, etfData, sigDoc };

  renderFundamentals(h, fund);
  renderIndices();
  drawFlowChart(flow);
  if (etf) {
    renderEtfHoldings(etfData);
  } else {
    renderTarget(h, target);    // state._targets 캐시 → 시나리오 앵커에 사용
    renderForecast(h, target);
    renderConsensus(h, target);
  }
  renderNews(news);
  renderSignals(h, sigDoc);
  document.getElementById("sigHelpBtn").addEventListener("click", () => {
    const el = document.getElementById("sigHelp");
    if (el.hidden) { el.innerHTML = SIG_HELP_HTML; el.hidden = false; }
    else el.hidden = true;
  });
  document.getElementById("rsiTf").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.tf === state.rsiTf) return;
    state.rsiTf = b.dataset.tf;
    document.querySelectorAll("#rsiTf button").forEach((x) => x.classList.toggle("on", x === b));
    state._noAnim = true;
    try { drawRsiChart(state.prices[h.ticker]); } finally { state._noAnim = false; }
  });
  drawPriceChart(h);            // 목표주가 로드 후 그려야 컨센서스 점선이 표시됨
  drawRsiChart(state.prices[h.ticker]);
  drawMacdChart(state.prices[h.ticker]);
  drawStochChart(state.prices[h.ticker]);
}

function rsiTfBtns() {
  return [["D", "일봉"], ["W", "주봉"], ["M", "월봉"]]
    .map(([k, l]) => `<button data-tf="${k}"${state.rsiTf === k ? ' class="on"' : ""}>${l}</button>`)
    .join("");
}

/* 차트 컨트롤 버튼 — 바뀐 항목이 영향 주는 차트만, 애니메이션 없이 다시 그린다 */
function onChartCtl(e) {
  const b = e.target.closest("button");
  if (!b) return;
  let scope; // "all"(기간) | "price"(이평·오버레이) | "macd" | "stoch" | "rsi"
  if (b.dataset.range) { state.chartRange = b.dataset.range; scope = "all"; }
  else if (b.dataset.ma) { state.ma[b.dataset.ma] = !state.ma[b.dataset.ma]; scope = "price"; }
  else if (b.dataset.ov) { state.overlay[b.dataset.ov] = !state.overlay[b.dataset.ov]; scope = "price"; }
  else if (b.dataset.sub) { state.sub[b.dataset.sub] = !state.sub[b.dataset.sub]; scope = b.dataset.sub; }
  else return;

  // 버튼 활성표시만 갱신 (innerHTML 전체 교체 X)
  if (b.dataset.range) {
    b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  } else {
    const st = b.dataset.ma ? state.ma[b.dataset.ma]
      : b.dataset.ov ? state.overlay[b.dataset.ov]
      : state.sub[b.dataset.sub];
    b.classList.toggle("on", !!st);
  }

  const h = state.panel && state.panel.h;
  if (!h) return;
  const p = state.prices[h.ticker];

  // 보조지표 on/off: 해당 블록만 위/아래로 슬라이드. 나머지 차트는 손대지 않는다.
  const toggleSub = (id, on, draw) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!on) { el.classList.add("collapsed"); return; }
    el.classList.remove("collapsed");
    setTimeout(draw, 420); // 슬라이드가 끝나 레이아웃이 확정된 뒤 그려야 캔버스 높이가 정확
  };
  if (scope === "macd") { toggleSub("macdBlock", state.sub.macd, () => drawMacdChart(p)); return; }
  if (scope === "stoch") { toggleSub("stochBlock", state.sub.stoch, () => drawStochChart(p)); return; }
  if (scope === "rsi") { toggleSub("rsiBlock", state.sub.rsi, () => drawRsiChart(p)); return; }

  // 기간 변경 → 전 차트 / 이평·오버레이 → 가격 차트만. 애니메이션 없이 다시 그린다.
  state._noAnim = true;
  try {
    if (scope === "all") { drawPriceChart(h); drawRsiChart(p); drawMacdChart(p); drawStochChart(p); }
    else if (scope === "price") { drawPriceChart(h); }
  } finally {
    state._noAnim = false;
  }
}


/* state.chartRange 에 맞는 시작 인덱스 */
function rangeStartIdx(dates) {
  if (!dates || !dates.length) return 0;
  const days = RANGE_DAYS[state.chartRange] || 366;
  const cutoff = new Date(dates[dates.length - 1]).valueOf() - days * 864e5;
  const i = dates.findIndex((d) => new Date(d).valueOf() >= cutoff);
  return i < 0 ? 0 : i;
}

/* 구간이 길면 표시 포인트를 ~420개로 스트라이드 샘플링 → 가로 폭 과다 팽창 방지.
   [si, len) 범위에서 고른 인덱스 배열(마지막 포함) 반환 */
function sampleIdx(si, len) {
  const n = len - si;
  const target = 420;
  const stride = n > target ? Math.ceil(n / target) : 1;
  const out = [];
  for (let i = si; i < len; i += stride) out.push(i);
  if (out[out.length - 1] !== len - 1) out.push(len - 1);
  return out;
}

/* 기간별 x축 시간축 설정. '월/연 표기는 처음 한 번 + 바뀔 때만' 규칙 적용.
   lastRealTs 이후(전망 구간)의 눈금 라벨은 숨긴다. */
function xTimeScale(kind, lastRealTs) {
  // kind: "day" | "month" | "quarter"
  // 넓은 구간(1·3·5년)은 달력에 고정된 세로선/라벨 규칙(데이터 시작월과 무관).
  //   1Y : 세로선 매월 · 라벨 1·4·7·10월(1월은 'YY.1월)
  //   3Y : 세로선 3개월(3·6·9·12월) · 매년 3월 'YY.3월, 그 외 M월
  //   5Y : 세로선 6개월(6·12월)      · 매년 6월 'YY.6월, 그 외 M월
  const R = state.chartRange;
  const spec =
    R === "1Y" ? { grid: 1, months: [1, 4, 7, 10], prefixMonth: 1 }
    : R === "3Y" ? { grid: 3, months: [3, 6, 9, 12], prefixMonth: 3 }
    : R === "5Y" ? { grid: 6, months: [6, 12], prefixMonth: 6 }
    : null;

  const cb = function (value, index, ticks) {
    if (lastRealTs && value > lastRealTs) return ""; // 전망 구간: 라벨 없음
    const d = new Date(value);
    const m = d.getMonth() + 1;
    const yy = String(d.getFullYear()).slice(2);

    if (spec) {
      if (!spec.months.includes(m)) return "";        // 세로선만, 라벨 없음
      return m === spec.prefixMonth ? `'${yy}.${m}월` : `${m}월`;
    }

    const prev = index > 0 && ticks[index - 1] ? new Date(ticks[index - 1].value) : null;
    if (kind === "day") {
      const showM = !prev || prev.getMonth() !== d.getMonth();
      return showM ? `${m}월${d.getDate()}일` : `${d.getDate()}일`;
    }
    const showY = !prev || prev.getFullYear() !== d.getFullYear() || d.getMonth() === 0;
    return showY ? `'${yy}.${m}월` : `${m}월`;
  };

  const unit = kind === "day" ? "day" : "month";
  const stepSize = kind === "quarter" ? 3 : 1;
  const scale = {
    type: "time",
    // 축 양끝을 눈금이 아니라 데이터(=강제 min/max)에 정확히 맞춘다 →
    // 가격 차트와 MACD·RSI·스토캐스틱의 시작·끝이 완전히 일치
    bounds: "data",
    offset: false,
    time: { unit, stepSize, tooltipFormat: "yyyy-MM-dd" },
    ticks: {
      color: "#8b95a1", maxRotation: 0,
      autoSkip: !spec, autoSkipPadding: 16,
      major: kind === "day" || spec ? { enabled: false } : { enabled: true },
      callback: cb,
    },
    grid: { color: "#2b333d40" },
  };

  if (spec) {
    // 달력 고정 눈금 직접 생성 (매월 1일 기준, spec.grid 개월 간격)
    scale.afterBuildTicks = (sc) => {
      const min = sc.min, max = sc.max;
      if (min == null || max == null) return;
      const s = new Date(min);
      let d = new Date(s.getFullYear(), s.getMonth(), 1);
      if (d.getTime() < min) d.setMonth(d.getMonth() + 1);
      const out = [];
      while (d.getTime() <= max) {
        const m = d.getMonth() + 1;
        if (spec.grid === 1 || m % spec.grid === 0) out.push({ value: d.getTime() });
        d.setMonth(d.getMonth() + 1);
      }
      sc.ticks = out;
    };
  }

  return scale;
}

/* state.chartRange → x축 kind */
function xKind() {
  if (["1W", "1M"].includes(state.chartRange)) return "day";
  if (["3M", "6M"].includes(state.chartRange)) return "month";
  return "quarter"; // 1Y 이상: 3개월 간격
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

/* 일목균형표 — 전환선(9)·기준선(26)·선행스팬1·2(52). 선행스팬은 이동 전 원시 중간값을
   전체 길이로 반환(그리는 쪽에서 disp 만큼 미래로 민다). 후행스팬은 종가를 그대로 뒤로. */
function ichimoku(candles, p1 = 9, p2 = 26, p3 = 52) {
  const n = candles.length;
  const mid = (i, w) => {
    if (i < w - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - w + 1; j <= i; j++) {
      const c = candles[j];
      if (!c || c.h == null || c.l == null) return null;
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
    }
    return (hi + lo) / 2;
  };
  const tenkan = [], kijun = [], spanA = [], spanB = [];
  for (let i = 0; i < n; i++) {
    const t = mid(i, p1), k = mid(i, p2);
    tenkan.push(t);
    kijun.push(k);
    spanA.push(t == null || k == null ? null : (t + k) / 2);
    spanB.push(mid(i, p3));
  }
  return { tenkan, kijun, spanA, spanB, disp: p2 };
}

/* ── 추가 종목(보유목록 밖): 프록시로 일봉을 받아 지표를 브라우저에서 계산 ── */
const _sma = (a, w) =>
  a.map((_, i) => (i < w - 1 ? null : a.slice(i - w + 1, i + 1).reduce((x, y) => x + y, 0) / w));
function _ema(a, span) {
  const k = 2 / (span + 1), out = [];
  let prev = a[0];
  for (let i = 0; i < a.length; i++) {
    prev = i === 0 ? a[0] : a[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function _macd(close) {
  const f = _ema(close, 12), s = _ema(close, 26);
  const macd = close.map((_, i) => f[i] - s[i]);
  const signal = _ema(macd, 9);
  return { macd, signal, hist: macd.map((v, i) => v - signal[i]) };
}
function _bbands(close, w = 20, k = 2) {
  const mid = _sma(close, w), upper = [], lower = [];
  for (let i = 0; i < close.length; i++) {
    if (i < w - 1) { upper.push(null); lower.push(null); continue; }
    const seg = close.slice(i - w + 1, i + 1), m = mid[i];
    const sd = Math.sqrt(seg.reduce((a, v) => a + (v - m) ** 2, 0) / w);
    upper.push(m + k * sd); lower.push(m - k * sd);
  }
  return { upper, mid, lower };
}

async function ensureAdhocPrice(h) {
  if (!PROXY_BASE || state.prices[h.ticker]) return;
  let d;
  try {
    d = await getJSON(`${PROXY_BASE}/history?ticker=${encodeURIComponent(h.ticker)}`);
  } catch (_) {
    return;
  }
  if (!d || !Array.isArray(d.dates) || !d.dates.length) return;

  const dates = [], O = [], H = [], L = [], C = [], V = [];
  for (let i = 0; i < d.dates.length; i++) {
    const c = d.close[i];
    if (c == null) continue;
    dates.push(d.dates[i]);
    C.push(+c);
    O.push(d.open[i] == null ? +c : +d.open[i]);
    H.push(d.high[i] == null ? +c : +d.high[i]);
    L.push(d.low[i] == null ? +c : +d.low[i]);
    V.push(d.volume[i] == null ? null : +d.volume[i]);
  }
  if (C.length < 30) return;

  state.prices[h.ticker] = {
    dates,
    close: C,
    volume: V,
    candles: dates.map((t, i) => ({ t, o: O[i], h: H[i], l: L[i], c: C[i], v: V[i] })),
    ma: { ma5: _sma(C, 5), ma20: _sma(C, 20), ma60: _sma(C, 60), ma120: _sma(C, 120) },
    bbands: _bbands(C, 20, 2),
    macd: _macd(C),
    rsi: rsiFrom(C, 14),
    last_close: C[C.length - 1],
    prev_close: C.length > 1 ? C[C.length - 2] : null,
    last_date: dates[dates.length - 1],
    _adhoc: true,
  };
}

/* ---- 가격 차트: 기간/이동평균/볼린저/거래량/내매수가/일목균형표 ---- */
function drawPriceChart(h) {
  const p = state.prices[h.ticker];
  const box = document.getElementById("priceChart");
  if (!box) return;
  if (!p || !p.dates || !p.dates.length) {
    box.parentElement.innerHTML =
      "<h3>가격</h3><div class='error'>가격 데이터 없음 (price_collector 미실행)</div>";
    state._xDomain = null;
    return;
  }

  const total = p.dates.length;
  const si = rangeStartIdx(p.dates);
  const idxs = sampleIdx(si, total);            // 표시할 인덱스 (긴 구간은 스트라이드 샘플)
  const xs = idxs.map((k) => new Date(p.dates[k]).valueOf());
  const pick = (arr) => (arr ? idxs.map((k) => arr[k]) : []);
  const line = (label, arr, color, w = 1) => ({
    type: "line", label, borderColor: color, borderWidth: w, pointRadius: 0, spanGaps: true, order: 5,
    data: xs.map((x, i) => ({ x, y: pick(arr)[i] })),
  });

  const hasFinancial = !!(window.Chart && Chart.registry.controllers.get("candlestick"));
  const useCandle = hasFinancial && p.candles && xs.length <= 400;
  const datasets = [];

  // 국내 관습: 상승(종가>시가) 빨강 / 하락 파랑
  const UP = "#ef4444", DOWN = "#3b82f6", UNCH = "#8b95a1";
  if (useCandle) {
    datasets.push({
      type: "candlestick",
      label: h.name || h.ticker,
      data: pick(p.candles).map((c) => ({ x: new Date(c.t).valueOf(), o: c.o, h: c.h, l: c.l, c: c.c })),
      borderColors: { up: UP, down: DOWN, unchanged: UNCH },
      backgroundColors: { up: UP, down: DOWN, unchanged: UNCH },
      order: 10,
    });
  } else {
    // 구간 첫 종가 대비 마지막 종가로 라인 색 결정
    const cl = pick(p.close).filter((v) => v != null);
    const rising = cl.length < 2 || cl[cl.length - 1] >= cl[0];
    datasets.push({ ...line("종가", p.close, rising ? UP : DOWN, 1.6), order: 10 });
  }

  const maColors = { ma5: "#f59e0b", ma20: "#22d3ee", ma60: "#22c55e", ma120: "#a855f7" };
  for (const key of ["ma5", "ma20", "ma60", "ma120"]) {
    if (state.ma[key] && p.ma && p.ma[key]) datasets.push(line(key.toUpperCase(), p.ma[key], maColors[key]));
  }

  if (state.overlay.bbands && p.bbands) {
    datasets.push(line("BB 상단", p.bbands.upper, "#8b95a180"));
    datasets.push(line("BB 중심", p.bbands.mid, "#8b95a160"));
    datasets.push(line("BB 하단", p.bbands.lower, "#8b95a180"));
  }

  const lastRealTs = xs[xs.length - 1];

  // ---- 일목균형표: 주가전망 점선과 무관하게, 마지막 봉 이후 26영업일 구간에
  //      선행스팬(구름)을 실제로 밀어서 그린다. (전환/기준/후행은 과거 구간만) ----
  let ichiXMax = lastRealTs;
  const useIchi = state.overlay.ichimoku && p.candles && total >= 52;
  if (useIchi) {
    const ichi = ichimoku(p.candles);
    const D = ichi.disp;
    // 마지막 실제일 이후 D 영업일 타임스탬프
    const futTs = [];
    let ts = new Date(p.dates[total - 1]).getTime();
    while (futTs.length < D) {
      ts += 864e5;
      const wd = new Date(ts).getUTCDay();
      if (wd !== 0 && wd !== 6) futTs.push(ts);
    }
    ichiXMax = futTs[futTs.length - 1];

    const base = { borderWidth: 1, pointRadius: 0, spanGaps: true };
    datasets.push({
      type: "line", label: "전환선", order: 4, borderColor: "#3b82f6", ...base,
      data: xs.map((x, i) => ({ x, y: ichi.tenkan[idxs[i]] })),
    });
    datasets.push({
      type: "line", label: "기준선", order: 4, borderColor: "#ef4444", ...base,
      data: xs.map((x, i) => ({ x, y: ichi.kijun[idxs[i]] })),
    });
    datasets.push({
      type: "line", label: "후행스팬", order: 4, borderColor: "#9ca3af", borderDash: [2, 2], ...base,
      data: xs.map((x, i) => ({ x, y: p.close[idxs[i] + D] ?? null })),
    });
    // 선행스팬1·2: 과거 구간은 disp 만큼 당겨온 값, 미래 stub 은 최근 26봉 값
    const spanData = (arr) => [
      ...xs.map((x, i) => ({ x, y: arr[idxs[i] - D] ?? null })),
      ...futTs.map((x, j) => ({ x, y: arr[total - D + j] ?? null })),
    ];
    datasets.push({
      type: "line", label: "선행스팬1", order: 30, borderColor: "#22c55eaa", borderWidth: 1,
      pointRadius: 0, spanGaps: true, data: spanData(ichi.spanA),
      fill: { target: "+1", above: "rgba(34,197,94,0.13)", below: "rgba(239,68,68,0.13)" },
    });
    datasets.push({
      type: "line", label: "선행스팬2", order: 30, borderColor: "#ef4444aa", borderWidth: 1,
      pointRadius: 0, spanGaps: true, fill: false, data: spanData(ichi.spanB),
    });
  }
  const scales = {
    x: xTimeScale(xKind(), lastRealTs),
    y: {
      position: "right", grid: { color: "#2b333d40" }, ticks: { color: "#8b95a1" },
      afterFit: (s) => { s.width = AXIS_Y_W; },
    },
  };
  let xMax = Math.max(lastRealTs, ichiXMax);

  if (state.overlay.buyprice && h.buy_price != null) {
    datasets.push({
      type: "line", label: "내 매수가", borderColor: "#ef4444", borderWidth: 1.6, pointRadius: 0, order: 2,
      data: [{ x: xs[0], y: h.buy_price }, { x: xMax, y: h.buy_price }],
    });
  }

  if (state.overlay.volume && p.volume) {
    const vol = pick(p.volume);
    const vmax = Math.max(1, ...vol.filter((v) => v != null));
    datasets.push({
      type: "bar", label: "거래량", yAxisID: "vol", order: 20,
      backgroundColor: "#8b95a140",
      data: xs.map((x, i) => ({ x, y: vol[i] })),
    });
    scales.vol = { display: false, position: "left", min: 0, max: vmax * 4 };
  }

  scales.x.min = xs[0];
  scales.x.max = xMax;
  // 보조지표들이 같은 x 구간·눈금·전망라벨 숨김을 쓰도록 도메인 저장
  state._xDomain = { min: xs[0], max: xMax, lastRealTs };

  makeChart("priceChart", {
    data: { datasets },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales,
      plugins: {
        legend: { labels: { color: "#8b95a1", boxWidth: 12, font: { size: 10 } } },
        tooltip: { callbacks: {} },
      },
    },
  });
}

/* ---- MACD 서브차트 ---- */
function drawMacdChart(p) {
  const el = document.getElementById("macdChart");
  if (!el || !state.sub.macd) return;
  if (!p || !p.macd || !p.dates) {
    el.parentElement.innerHTML = "<h3>MACD (12·26·9)</h3><div class='error'>MACD 데이터 없음</div>";
    return;
  }
  const total = p.dates.length;
  const idxs = sampleIdx(rangeStartIdx(p.dates), total);
  const xs = idxs.map((k) => new Date(p.dates[k]).valueOf());
  const S = (a) => idxs.map((k) => a[k]);
  const xg = xTimeScale(xKind(), state._xDomain && state._xDomain.lastRealTs);
  xg.grid = { display: false };
  if (state._xDomain) { xg.min = state._xDomain.min; xg.max = state._xDomain.max; }
  makeChart("macdChart", {
    data: {
      datasets: [
        { type: "bar", label: "히스토그램", data: xs.map((x, i) => ({ x, y: S(p.macd.hist)[i] })),
          backgroundColor: xs.map((_, i) => (S(p.macd.hist)[i] >= 0 ? "#ef444455" : "#3b82f655")) },
        { type: "line", label: "MACD", data: xs.map((x, i) => ({ x, y: S(p.macd.macd)[i] })), borderColor: "#22d3ee", borderWidth: 1.2, pointRadius: 0 },
        { type: "line", label: "시그널", data: xs.map((x, i) => ({ x, y: S(p.macd.signal)[i] })), borderColor: "#f59e0b", borderWidth: 1.2, pointRadius: 0 },
      ],
    },
    options: {
      parsing: false, responsive: true, maintainAspectRatio: false,
      scales: {
        x: xg,
        y: { position: "right", afterFit: (s) => { s.width = AXIS_Y_W; }, ticks: { color: "#8b95a1" }, grid: { color: "#2b333d40" } },
      },
      plugins: { legend: { labels: { color: "#8b95a1", boxWidth: 12, font: { size: 10 } } } },
    },
  });
}

/* 일봉 close/dates → 주봉(W)/월봉(M) 마지막 종가 시리즈 */
function resampleClose(dates, close, tf) {
  if (tf !== "W" && tf !== "M") return { dates: dates.slice(), close: close.slice() };
  const key = (d) => {
    const x = new Date(d);
    if (tf === "M") return x.getFullYear() * 12 + x.getMonth();
    const t = new Date(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()));
    const day = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - day + 3); // ISO 주 목요일
    return Math.floor(t / 6048e5);
  };
  const outD = [], outC = [];
  let cur = null;
  for (let i = 0; i < dates.length; i++) {
    if (close[i] == null) continue;
    const k = key(dates[i]);
    if (k !== cur) { outD.push(dates[i]); outC.push(close[i]); cur = k; }
    else { outD[outD.length - 1] = dates[i]; outC[outC.length - 1] = close[i]; }
  }
  return { dates: outD, close: outC };
}

/* Wilder RSI */
function rsiFrom(close, period = 14) {
  const n = close.length, out = new Array(n).fill(null);
  if (n <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = close[i] - close[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < n; i++) {
    const d = close[i] - close[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/* Stochastic %K(slow)/%D from candles [{h,l,c}] */
function stochFrom(candles, kP = 14, dP = 3) {
  const n = candles.length, kRaw = new Array(n).fill(null);
  for (let i = kP - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kP + 1; j <= i; j++) {
      const c = candles[j]; if (!c) continue;
      if (c.h > hi) hi = c.h;
      if (c.l < lo) lo = c.l;
    }
    const c = candles[i];
    kRaw[i] = hi === lo || !c ? null : ((c.c - lo) / (hi - lo)) * 100;
  }
  const sma = (arr, p) =>
    arr.map((_, i) => {
      if (i < p - 1) return null;
      let s = 0;
      for (let j = i - p + 1; j <= i; j++) {
        if (arr[j] == null) return null;
        s += arr[j];
      }
      return s / p;
    });
  const k = sma(kRaw, dP);
  return { k, d: sma(k, dP) };
}

/* ============ 보조지표 종합 신호 — collectors/signals.py 의 JS 포팅 ============
 * 보유 종목은 배치가 만든 data/signals/{ticker}.json (규칙 + Gemini 서술)을 쓰고,
 * 보유목록 밖(+)으로 추가한 종목은 여기 evaluateSignals(p) 로 브라우저에서 계산한다.
 * 규칙·문구는 파이썬 쪽과 1:1 로 맞춘다. */
const _SIG_DIR_KO = { bull: "상승", bear: "하락", neutral: "중립" };
const _SIG_STANCE_KO = { bull: "상승 우위", bear: "하락 우위", mixed: "혼조", neutral: "중립" };
const _SIG_CROSS_MA = 10, _SIG_CROSS_MACD = 5, _SIG_CROSS_STOCH = 3;
const _SIG_VOL_SPIKE = 2.0, _SIG_SQUEEZE_LB = 60, _SIG_NEAR_52W = 0.03;
// 참고(ref) 지표 파라미터 — signals.py 와 1:1
const _SIG_DISPARITY_HOT = 110, _SIG_DISPARITY_COLD = 90;
const _SIG_CCI_HOT = 100, _SIG_CCI_COLD = -100;
const _SIG_STREAK_MIN = 4, _SIG_DIV_WIN = 40;
const _SIG_DIV_PRICE_MARGIN = 0.01, _SIG_DIV_RSI_MARGIN = 3.0;

function _sigLastValid(a) {
  if (!a) return [null, null];
  for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return [i, a[i]];
  return [null, null];
}
function _sigPrevValid(a, before) {
  for (let i = before - 1; i >= 0; i--) if (a[i] != null) return [i, a[i]];
  return [null, null];
}
function _sigCross(a, b, within) {
  const n = Math.min(a.length, b.length), pairs = [];
  for (let i = 0; i < n; i++) if (a[i] != null && b[i] != null) pairs.push([i, a[i] - b[i]]);
  if (pairs.length < 2) return null;
  const lastI = pairs[pairs.length - 1][0];
  const win = pairs.slice(-(within + 1));
  for (let k = win.length - 1; k > 0; k--) {
    const d0 = win[k - 1][1], d1 = win[k][1];
    if (d0 <= 0 && d1 > 0) return ["up", lastI - win[k][0]];
    if (d0 >= 0 && d1 < 0) return ["down", lastI - win[k][0]];
  }
  return null;
}
function _sigSmaLast(seq, w) {
  const v = seq.filter((x) => x != null);
  if (v.length < w) return null;
  return v.slice(-w).reduce((a, b) => a + b, 0) / w;
}
function _sigTypical(candles) {
  return candles.map((c) =>
    c && c.h != null && c.l != null && c.c != null ? (c.h + c.l + c.c) / 3 : null);
}
function _sigHlExtremes(candles, period, end) {
  if (end + 1 < period) return [null, null];
  let hi = -Infinity, lo = Infinity;
  for (let j = end - period + 1; j <= end; j++) {
    const c = candles[j];
    if (!c || c.h == null || c.l == null) return [null, null];
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  return [hi, lo];
}
function _sg(key, label, dir, strength, detail, tier = "core") {
  return { key, label, dir, strength, detail, tier };
}

/* 신호별 상세 설명 — 패널에서 마우스오버/터치로 펼침. collectors/signals.py 의 _SIG_GUIDE 와 동일. */
const _SIG_GUIDE = {
  ma_align:
    "이동평균선이 단기>중기>장기 순으로 정렬(정배열)이면 상승 추세, 반대(역배열)면 하락 추세다. " +
    "정배열에서는 눌림목이 매수 기회로, 역배열에서는 반등이 매도 기회로 자주 쓰인다. 이평선은 후행 지표라 전환점을 늦게 알려준다.",
  ma_cross:
    "MA20이 MA60을 위로 뚫으면 골든크로스(중기 추세가 상승으로), 아래로 뚫으면 데드크로스(하락으로)다. " +
    "추세장에서는 신뢰도가 높지만 횡보장에서는 자주 뒤집히니 거래량·가격 위치와 함께 본다.",
  ma_cross_s:
    "MA5가 MA20을 교차하는 단기 신호다. 방향을 빠르게 알려주는 대신 잦게 뒤바뀐다. " +
    "핵심 신호(정배열·MA20×60)와 같은 방향일 때 참고 가치가 커진다.",
  price_ma:
    "종가가 MA20·MA60 위에 있으면 그 기간 매수자가 평균적으로 이익 구간이라 매물 부담이 적다. " +
    "아래에 있으면 반대로 매물벽이 위에 쌓여 있다는 뜻이다.",
  rsi:
    "RSI는 0~100으로 상승·하락 압력의 균형을 본다. 70 위는 과매수(되돌림 확률↑), 30 아래는 과매도(반등 확률↑)지만 " +
    "즉시 방향 전환을 뜻하진 않는다. 강한 추세에서는 한쪽에 오래 머문다. 50선 돌파는 모멘텀 전환 신호.",
  macd:
    "MACD선이 시그널선을 위로 교차하면 매수, 아래로 교차하면 매도 쪽 신호다. " +
    "MACD선이 0선 위면 중기 상승 우위, 아래면 하락 우위. 급등락 직후에는 교차가 연달아 나올 수 있다.",
  bb_edge:
    "종가가 볼린저 상단(+2σ)에 닿으면 단기 과열이거나 강한 추세, 하단(−2σ)에 닿으면 낙폭과대다. " +
    "추세가 강하면 밴드를 타고 계속 갈 수 있으니 단독으로 역방향 베팅하지 않는다.",
  bb_squeeze:
    "밴드 폭이 최근 60거래일 최저라는 것은 변동성이 바짝 수축했다는 뜻이다. " +
    "곧 큰 방향성 움직임이 나올 확률이 높다는 '경고'일 뿐, 위아래 방향은 알려주지 않는다(중립).",
  volume:
    "거래량이 20일 평균의 2배 이상 터지며 주가가 오르면 매수세 유입, 내리면 매도 출회로 본다. " +
    "거래량 없는 등락은 신뢰도가 낮다. 지수 편입·배당락·만기 같은 이벤트성 급증은 방향 의미가 약하다.",
  stoch:
    "스토캐스틱은 최근 14일 고저 범위에서 종가 위치를 본다. %K·%D가 모두 80 위면 과매수, 20 아래면 과매도. " +
    "과매도권에서 %K가 %D를 상향 교차하면 반등 신호로 쓴다. RSI보다 민감해 신호가 잦다.",
  stoch_cross:
    "과매도(또는 과매수) 구간에서 %K와 %D가 교차하는 순간을 잡는 신호다. " +
    "짧은 반등·조정을 노리는 단기 관점이며, 추세장에서는 속임수가 많다.",
  range52w:
    "종가가 52주 최고가에 근접하면 강한 상승 추세(신고가 돌파 시도), 최저가에 근접하면 약세 지속으로 읽는다. " +
    "신고가는 매물 부담이 적고, 신저가는 지지선 붕괴 위험이 있다. 단독 판단은 금물.",
  disparity:
    "이격도는 종가가 MA20에서 몇 % 떨어져 있는지 본다(100 = 이평선과 일치). " +
    "110 이상은 단기 과열, 90 이하는 단기 침체로 보고 평균 회귀(이평선으로 되돌림)를 기대하는 지표다. 참고용.",
  cci:
    "CCI는 대표가격이 평균에서 얼마나 벗어났는지를 본다. +100 위는 과열, −100 아래는 침체권. " +
    "추세 진입 초기에는 +100 돌파가 상승 가속 신호로도 쓰이니 방향과 함께 해석한다. 참고용.",
  ichimoku:
    "일목균형표는 전환선(9)·기준선(26)과 '구름대'로 추세를 한눈에 본다. " +
    "종가가 구름 위 + 전환선>기준선이면 상방 정렬, 그 반대면 하방 정렬이다. 구름 안이면 방향 불명확. 참고용.",
  obv:
    "OBV는 상승일 거래량은 더하고 하락일 거래량은 빼서 누적한 값으로, 돈이 들어오는지 나가는지를 본다. " +
    "주가와 OBV가 반대로 움직이면(다이버전스) 추세 힘이 빠지고 있다는 신호다. 참고용.",
  streak:
    "양봉/음봉이 연속으로 며칠 이어졌는지 본다. 추세가 살아있다는 뜻이면서, 너무 길면 단기 과열·과매도로 " +
    "되돌림이 나오기도 한다. 다른 신호와 함께 '지금 추세가 어느 국면인지' 가늠하는 용도. 참고용.",
  rsi_div:
    "주가 고점은 높아지는데 RSI 고점은 낮아지면(약세 다이버전스) 상승 힘이 빠지는 것, " +
    "주가 저점은 낮아지는데 RSI 저점은 높아지면(강세 다이버전스) 하락 힘이 빠지는 것이다. " +
    "전환을 미리 암시하지만 타이밍은 늦거나 빗나갈 수 있다. 참고용.",
};

function evaluateSignals(p) {
  if (!p || !p.close) return null;
  const S = [], cav = [];
  const ma = p.ma || {}, bb = p.bbands || {}, mac = p.macd || {};
  const close = p.close, rsi = p.rsi || [];

  { // 이평 배열
    const [, m5] = _sigLastValid(ma.ma5), [, m20] = _sigLastValid(ma.ma20),
          [, m60] = _sigLastValid(ma.ma60), [, m120] = _sigLastValid(ma.ma120);
    if (m5 != null && m20 != null && m60 != null) {
      const chain = [m5, m20, m60].concat(m120 != null ? [m120] : []);
      const up = chain.every((v, i) => i === 0 || chain[i - 1] > v);
      const dn = chain.every((v, i) => i === 0 || chain[i - 1] < v);
      const lbl = "MA5 > MA20 > MA60" + (m120 != null ? " > MA120" : "");
      if (up) S.push(_sg("ma_align", "정배열", "bull", 3, `이동평균 정배열 (${lbl}) — 단기·중기·장기선이 상승 순으로 정렬.`));
      else if (dn) S.push(_sg("ma_align", "역배열", "bear", 3, "이동평균 역배열 — 이평선이 하락 순으로 정렬, 추세적 약세."));
    }
  }
  { // MA20 x MA60
    const c = _sigCross(ma.ma20 || [], ma.ma60 || [], _SIG_CROSS_MA);
    if (c) {
      const when = c[1] === 0 ? "오늘" : `${c[1]}거래일 전`;
      if (c[0] === "up") S.push(_sg("ma_cross", "골든크로스", "bull", 2, `골든크로스 — MA20이 MA60을 ${when} 상향 돌파. 중기 추세 전환 가능.`));
      else S.push(_sg("ma_cross", "데드크로스", "bear", 2, `데드크로스 — MA20이 MA60을 ${when} 하향 이탈. 중기 추세 악화.`));
    }
  }
  { // 종가 vs 이평
    const [, c] = _sigLastValid(close), [, m20] = _sigLastValid(ma.ma20), [, m60] = _sigLastValid(ma.ma60);
    if (c != null && m20 != null && m60 != null) {
      if (c > m20 && c > m60) S.push(_sg("price_ma", "이평선 위", "bull", 1, "종가가 MA20·MA60 위 — 단기·중기 이평선 위에서 거래 중."));
      else if (c < m20 && c < m60) S.push(_sg("price_ma", "이평선 아래", "bear", 1, "종가가 MA20·MA60 아래 — 단기·중기 이평선 아래에서 거래 중."));
    }
  }
  { // RSI(14)
    const [i, rv] = _sigLastValid(rsi);
    if (rv != null) {
      const r = Math.round(rv);
      if (r >= 70) { cav.push(`RSI ${r} 과매수`); S.push(_sg("rsi", "RSI 과매수", "bear", 2, `RSI(14) ${r} — 과매수(70+) 구간. 단기 되돌림 압력.`)); }
      else if (r <= 30) { cav.push(`RSI ${r} 과매도`); S.push(_sg("rsi", "RSI 과매도", "bull", 2, `RSI(14) ${r} — 과매도(30-) 구간. 기술적 반등 가능.`)); }
      else {
        const [, rp] = _sigPrevValid(rsi, i);
        if (rp != null && rp < 50 && r >= 50) S.push(_sg("rsi", "RSI 50 상향", "bull", 1, `RSI(14)가 50선을 상향 돌파(${Math.round(rp)}→${r}) — 모멘텀 개선.`));
        else if (rp != null && rp >= 50 && r < 50) S.push(_sg("rsi", "RSI 50 하향", "bear", 1, `RSI(14)가 50선을 하향 이탈(${Math.round(rp)}→${r}) — 모멘텀 약화.`));
      }
    }
  }
  { // MACD
    const line = mac.macd || [], sig = mac.signal || [];
    const c = _sigCross(line, sig, _SIG_CROSS_MACD);
    if (c) {
      const when = c[1] === 0 ? "오늘" : `${c[1]}거래일 전`;
      if (c[0] === "up") S.push(_sg("macd_cross", "MACD 골든크로스", "bull", 2, `MACD가 시그널선을 ${when} 상향 돌파 — 매수 신호.`));
      else S.push(_sg("macd_cross", "MACD 데드크로스", "bear", 2, `MACD가 시그널선을 ${when} 하향 돌파 — 매도 신호.`));
    }
    const [, ml] = _sigLastValid(line);
    if (ml != null && ml > 0) S.push(_sg("macd_zero", "MACD 0선 위", "bull", 1, "MACD가 0선 위 — 중기 상승 모멘텀 우위."));
    else if (ml != null && ml < 0) S.push(_sg("macd_zero", "MACD 0선 아래", "bear", 1, "MACD가 0선 아래 — 중기 하락 모멘텀 우위."));
  }
  { // 볼린저
    const up = bb.upper || [], mid = bb.mid || [], lo = bb.lower || [];
    const [, c] = _sigLastValid(close), [, u] = _sigLastValid(up), [, l] = _sigLastValid(lo);
    if (c != null && u != null && l != null) {
      if (c >= u) { cav.push("볼린저 상단 접촉"); S.push(_sg("bb_edge", "볼린저 상단", "bear", 1, "종가가 볼린저 상단(+2σ) 도달 — 단기 과열 또는 강한 추세, 되돌림 주의.")); }
      else if (c <= l) { cav.push("볼린저 하단 접촉"); S.push(_sg("bb_edge", "볼린저 하단", "bull", 1, "종가가 볼린저 하단(−2σ) 도달 — 낙폭과대 반등 가능.")); }
    }
    const w = [], n = Math.min(up.length, mid.length, lo.length);
    for (let i = 0; i < n; i++) if (up[i] != null && mid[i] != null && lo[i] != null && mid[i]) w.push((up[i] - lo[i]) / mid[i]);
    if (w.length >= _SIG_SQUEEZE_LB && w[w.length - 1] <= Math.min(...w.slice(-_SIG_SQUEEZE_LB)) + 1e-12) {
      cav.push("변동성 수축");
      S.push(_sg("bb_squeeze", "밴드 스퀴즈", "neutral", 2, `볼린저 밴드 폭이 최근 ${_SIG_SQUEEZE_LB}거래일 최저 — 변동성 수축, 곧 방향성 확대 가능.`));
    }
  }
  { // 거래량
    const vol = p.volume || [];
    const [, v] = _sigLastValid(vol);
    const avg = _sigSmaLast(vol.length && vol[vol.length - 1] != null ? vol.slice(0, -1) : vol, 20);
    const [ci, c] = _sigLastValid(close);
    const [, cprev] = ci != null ? _sigPrevValid(close, ci) : [null, null];
    if (v != null && avg && c != null && cprev != null) {
      const ratio = v / avg;
      if (ratio >= _SIG_VOL_SPIKE && c > cprev) S.push(_sg("volume", "거래량 급증(상승)", "bull", 2, `거래량이 20일 평균의 ${ratio.toFixed(1)}배로 급증 + 주가 상승 — 매수세 유입.`));
      else if (ratio >= _SIG_VOL_SPIKE && c < cprev) S.push(_sg("volume", "거래량 급증(하락)", "bear", 2, `거래량이 20일 평균의 ${ratio.toFixed(1)}배로 급증 + 주가 하락 — 매도 출회.`));
    }
  }
  { // 스토캐스틱(14·3·3)
    if (p.candles && p.candles.length >= 20) {
      const { k, d } = stochFrom(p.candles, 14, 3);
      const [ki, kv] = _sigLastValid(k), [, dv] = _sigLastValid(d);
      if (kv != null && dv != null) {
        if (kv >= 80 && dv >= 80) { cav.push("스토캐스틱 과매수"); S.push(_sg("stoch", "스토캐스틱 과매수", "bear", 1, `스토캐스틱 %K ${kv.toFixed(0)}·%D ${dv.toFixed(0)} — 과매수(80+).`)); }
        else if (kv <= 20 && dv <= 20) { cav.push("스토캐스틱 과매도"); S.push(_sg("stoch", "스토캐스틱 과매도", "bull", 1, `스토캐스틱 %K ${kv.toFixed(0)}·%D ${dv.toFixed(0)} — 과매도(20-).`)); }
        const c = _sigCross(k, d, _SIG_CROSS_STOCH);
        if (c) {
          const [, dAt] = _sigLastValid(d.slice(0, ki + 1));
          const when = c[1] === 0 ? "오늘" : `${c[1]}거래일 전`;
          if (c[0] === "up" && dAt != null && dAt < 35) S.push(_sg("stoch_cross", "스토캐스틱 골든크로스", "bull", 2, `과매도권에서 %K가 %D를 ${when} 상향 돌파 — 반등 신호.`));
          else if (c[0] === "down" && dAt != null && dAt > 65) S.push(_sg("stoch_cross", "스토캐스틱 데드크로스", "bear", 2, `과매수권에서 %K가 %D를 ${when} 하향 돌파 — 조정 신호.`));
        }
      }
    }
  }
  { // 52주 위치
    const c2 = close.filter((x) => x != null);
    if (c2.length >= 60) {
      const win = c2.slice(-252), c = c2[c2.length - 1];
      const hi = Math.max(...win), lo = Math.min(...win);
      if (hi && c >= hi * (1 - _SIG_NEAR_52W)) S.push(_sg("range52w", "52주 고가권", "bull", 1, `52주 최고가의 ${((c / hi - 1) * 100).toFixed(1)}% 이내 — 신고가 근접, 강한 상승 추세.`));
      else if (lo && c <= lo * (1 + _SIG_NEAR_52W)) S.push(_sg("range52w", "52주 저가권", "bear", 1, `52주 최저가의 +${((c / lo - 1) * 100).toFixed(1)}% 이내 — 신저가 근접, 약세 지속.`));
    }
  }
  { // 참고: MA5 x MA20 단기 크로스
    const c = _sigCross(ma.ma5 || [], ma.ma20 || [], _SIG_CROSS_MA);
    if (c) {
      const when = c[1] === 0 ? "오늘" : `${c[1]}거래일 전`;
      if (c[0] === "up") S.push(_sg("ma_cross_s", "단기 골든크로스", "bull", 1, `MA5가 MA20을 ${when} 상향 돌파 — 단기 흐름이 위로.`, "ref"));
      else S.push(_sg("ma_cross_s", "단기 데드크로스", "bear", 1, `MA5가 MA20을 ${when} 하향 이탈 — 단기 흐름이 아래로.`, "ref"));
    }
  }
  { // 참고: 이격도 (종가 / MA20)
    const [, cc] = _sigLastValid(close), [, m20] = _sigLastValid(ma.ma20);
    if (cc != null && m20) {
      const disp = (cc / m20) * 100;
      if (disp >= _SIG_DISPARITY_HOT) S.push(_sg("disparity", "이격도 과열", "bear", 1, `20일 이격도 ${disp.toFixed(0)} — 종가가 MA20보다 ${(disp - 100).toFixed(0)}% 위. 단기 되돌림 소지.`, "ref"));
      else if (disp <= _SIG_DISPARITY_COLD) S.push(_sg("disparity", "이격도 침체", "bull", 1, `20일 이격도 ${disp.toFixed(0)} — 종가가 MA20보다 ${(100 - disp).toFixed(0)}% 아래. 단기 반등 소지.`, "ref"));
    }
  }
  { // 참고: CCI(20)
    const tp = _sigTypical(p.candles || []).filter((x) => x != null);
    if (tp.length >= 20) {
      const w = tp.slice(-20), sma = w.reduce((a, b) => a + b, 0) / 20;
      const mad = w.reduce((a, b) => a + Math.abs(b - sma), 0) / 20;
      if (mad > 0) {
        const cci = (w[w.length - 1] - sma) / (0.015 * mad);
        if (cci >= _SIG_CCI_HOT) S.push(_sg("cci", "CCI 과열", "bear", 1, `CCI(20) ${cci >= 0 ? "+" : ""}${cci.toFixed(0)} — +100 위 과열권. 상승 탄력은 강하나 과열 부담.`, "ref"));
        else if (cci <= _SIG_CCI_COLD) S.push(_sg("cci", "CCI 침체", "bull", 1, `CCI(20) ${cci >= 0 ? "+" : ""}${cci.toFixed(0)} — −100 아래 침체권. 낙폭과대 반등 소지.`, "ref"));
      }
    }
  }
  { // 참고: 일목균형표
    const cd = p.candles || [];
    if (cd.length >= 78) {
      const last = cd.length - 1, base2 = last - 26;
      const [th, tl] = _sigHlExtremes(cd, 9, last), [kh, kl] = _sigHlExtremes(cd, 26, last);
      const [ah, al] = _sigHlExtremes(cd, 9, base2), [bh, bl] = _sigHlExtremes(cd, 26, base2);
      const [bbh, bbl] = _sigHlExtremes(cd, 52, base2);
      const [, cc] = _sigLastValid(close);
      if ([th, tl, kh, kl, ah, al, bh, bl, bbh, bbl].every((v) => v != null) && cc != null) {
        const tenkan = (th + tl) / 2, kijun = (kh + kl) / 2;
        const spanA = (((ah + al) / 2) + ((bh + bl) / 2)) / 2, spanB = (bbh + bbl) / 2;
        const top = Math.max(spanA, spanB), bot = Math.min(spanA, spanB);
        if (cc > top && tenkan > kijun) S.push(_sg("ichimoku", "일목 호전", "bull", 2, "종가가 일목 구름 위 + 전환선 > 기준선 — 추세·모멘텀 모두 상방.", "ref"));
        else if (cc < bot && tenkan < kijun) S.push(_sg("ichimoku", "일목 악화", "bear", 2, "종가가 일목 구름 아래 + 전환선 < 기준선 — 추세·모멘텀 모두 하방.", "ref"));
      }
    }
  }
  { // 참고: OBV
    const vol = p.volume || [];
    const pr = [];
    for (let i = 0; i < Math.min(close.length, vol.length); i++)
      if (close[i] != null && vol[i] != null) pr.push([close[i], vol[i]]);
    if (pr.length >= 25) {
      const obv = [0];
      for (let i = 1; i < pr.length; i++) {
        const ch = pr[i][0] - pr[i - 1][0];
        obv.push(obv[i - 1] + (ch > 0 ? pr[i][1] : ch < 0 ? -pr[i][1] : 0));
      }
      const look = 20;
      const dO = obv[obv.length - 1] - obv[obv.length - 1 - look];
      const dP = pr[pr.length - 1][0] - pr[pr.length - 1 - look][0];
      if (dP < 0 && dO > 0) S.push(_sg("obv", "OBV 강세 다이버전스", "bull", 2, "주가는 20일 전보다 낮은데 OBV(누적 거래량)는 오름 — 저가 매집 가능성.", "ref"));
      else if (dP > 0 && dO < 0) S.push(_sg("obv", "OBV 약세 다이버전스", "bear", 2, "주가는 20일 전보다 높은데 OBV는 내림 — 상승에 거래량 뒷받침 부족.", "ref"));
      else if (dP > 0 && dO > 0) S.push(_sg("obv", "OBV 매집 우위", "bull", 1, "최근 20거래일 OBV 상승 — 거래량이 매수 쪽에 실림.", "ref"));
      else if (dP < 0 && dO < 0) S.push(_sg("obv", "OBV 분산 우위", "bear", 1, "최근 20거래일 OBV 하락 — 거래량이 매도 쪽에 실림.", "ref"));
    }
  }
  { // 참고: 연속 양/음봉
    const cd = p.candles || [];
    const lastC = cd[cd.length - 1];
    if (cd.length >= _SIG_STREAK_MIN && lastC && lastC.o != null && lastC.c != null && lastC.o !== lastC.c) {
      const up = lastC.c > lastC.o;
      let run = 0;
      for (let i = cd.length - 1; i >= 0; i--) {
        const c = cd[i];
        if (!c || c.o == null || c.c == null) break;
        if ((c.c > c.o) === up && c.c !== c.o) run++;
        else break;
      }
      if (run >= _SIG_STREAK_MIN) {
        if (up) S.push(_sg("streak", `${run}일 연속 양봉`, "bull", 1, `${run}거래일 연속 양봉 — 매수 우위가 이어지는 중(단기 과열 여부는 함께 확인).`, "ref"));
        else S.push(_sg("streak", `${run}일 연속 음봉`, "bear", 1, `${run}거래일 연속 음봉 — 매도 우위가 이어지는 중(낙폭과대 여부는 함께 확인).`, "ref"));
      }
    }
  }
  { // 참고: RSI 다이버전스
    const idx = [];
    for (let i = 0; i < Math.min(rsi.length, close.length); i++)
      if (rsi[i] != null && close[i] != null) idx.push(i);
    if (idx.length >= _SIG_DIV_WIN) {
      const w = idx.slice(-_SIG_DIV_WIN), half = Math.floor(w.length / 2);
      const prior = w.slice(0, half), recent = w.slice(half);
      const hi = (seg) => seg.reduce((a, i) => (close[i] > close[a] ? i : a), seg[0]);
      const lo = (seg) => seg.reduce((a, i) => (close[i] < close[a] ? i : a), seg[0]);
      const ph = hi(prior), rh = hi(recent);
      if (close[rh] > close[ph] * (1 + _SIG_DIV_PRICE_MARGIN) && rsi[rh] < rsi[ph] - _SIG_DIV_RSI_MARGIN) {
        S.push(_sg("rsi_div", "RSI 약세 다이버전스", "bear", 2, "주가는 고점을 높였지만 RSI 고점은 낮아짐 — 상승 모멘텀 둔화 경고.", "ref"));
      } else {
        const pl = lo(prior), rl = lo(recent);
        if (close[rl] < close[pl] * (1 - _SIG_DIV_PRICE_MARGIN) && rsi[rl] > rsi[pl] + _SIG_DIV_RSI_MARGIN)
          S.push(_sg("rsi_div", "RSI 강세 다이버전스", "bull", 2, "주가는 저점을 낮췄지만 RSI 저점은 높아짐 — 하락 모멘텀 둔화 신호.", "ref"));
      }
    }
  }

  S.forEach((s) => { if (!s.tier) s.tier = "core"; s.guide = _SIG_GUIDE[s.key] || ""; });
  const core = S.filter((s) => s.tier === "core");
  const score = core.reduce((a, s) => a + s.strength * (s.dir === "bull" ? 1 : s.dir === "bear" ? -1 : 0), 0);
  const nB = core.filter((s) => s.dir === "bull").length, nS = core.filter((s) => s.dir === "bear").length;
  let stance, base;
  if (!core.length) { stance = "neutral"; base = "뚜렷한 기술적 신호 없음"; }
  else if (score >= 3) { stance = "bull"; base = "상승 신호 우위"; }
  else if (score <= -3) { stance = "bear"; base = "하락 신호 우위"; }
  else { stance = "mixed"; base = "신호 혼조 (방향성 불명확)"; }
  const read = base + (cav.length ? ` · ${cav[0]}` : "");
  const dates = p.dates || [];
  return {
    as_of: p.last_date || dates[dates.length - 1] || null,
    stance, score, n_bull: nB, n_bear: nS, n_ref: S.length - core.length,
    read, caveats: cav, signals: S,
  };
}

function renderSignals(h, sigDoc) {
  const box = document.getElementById("signalBox");
  if (!box) return;
  const p = state.prices[h.ticker];
  const sig = (sigDoc && sigDoc.signals) ? sigDoc
            : (p && p.signals && p.signals.signals) ? p.signals
            : (p ? evaluateSignals(p) : null);
  if (!sig || !sig.signals) {
    box.innerHTML = "<div class='muted'>보조지표 신호 데이터가 없습니다.</div>";
    return;
  }
  const all = sig.signals.slice();
  all.forEach((s) => { if (!s.tier) s.tier = "core"; });
  const byStrength = (a, b) => b.strength - a.strength;
  const core = all.filter((s) => s.tier === "core").sort(byStrength);
  const ref = all.filter((s) => s.tier === "ref").sort(byStrength);
  const nB = sig.n_bull != null ? sig.n_bull : core.filter((s) => s.dir === "bull").length;
  const nS = sig.n_bear != null ? sig.n_bear : core.filter((s) => s.dir === "bear").length;
  const guideOf = (s) => s.guide || _SIG_GUIDE[s.key] || "";

  const chips = core.map((s) =>
    `<span class="sig-chip ${s.dir}" title="${escapeHtml(s.detail)}"><b>${"●".repeat(s.strength)}</b>${escapeHtml(s.label)}</span>`
  ).join("");
  const rowHtml = (s) => {
    const g = guideOf(s);
    return `<li class="sig-row ${s.dir}${g ? " has-guide" : ""}"${g ? ' tabindex="0" role="button" aria-expanded="false"' : ""} title="${escapeHtml(g || s.detail)}">
      <span class="sig-tag ${s.dir}">${_SIG_DIR_KO[s.dir]}</span>
      <span class="sig-body"><span class="sig-detail">${escapeHtml(s.detail)}</span>${g ? '<span class="sig-more">ⓘ 설명</span>' : ""}</span>
      ${g ? `<span class="sig-guide" hidden><b>${escapeHtml(s.label)}</b> — ${escapeHtml(g)}</span>` : ""}
    </li>`;
  };
  const coreRows = core.map(rowHtml).join("");
  const refRows = ref.map(rowHtml).join("");
  const narr = (sigDoc && sigDoc.narrative)
    ? `<p class="sig-narrative">${escapeHtml(sigDoc.narrative)}</p>` : "";
  const src = (sigDoc && sigDoc.source === "gemini") ? "AI 서술 + 규칙 엔진" : "규칙 엔진";
  const asOf = sig.as_of ? ` · ${escapeHtml(sig.as_of)} 종가 기준` : "";

  box.innerHTML =
    `<div class="sig-head ${sig.stance}">
       <span class="sig-stance">${_SIG_STANCE_KO[sig.stance] || sig.stance}</span>
       <span class="sig-read">${escapeHtml(sig.read)}</span>
       <span class="sig-tally"><i class="bull">▲${nB}</i> <i class="bear">▼${nS}</i></span>
     </div>
     ${narr}
     ${core.length
        ? `<div class="sig-chips">${chips}</div><ul class="sig-list">${coreRows}</ul>`
        : `<div class="muted">현재 감지된 핵심 신호가 없습니다.</div>`}
     ${ref.length
        ? `<div class="sig-subhead">참고 지표 <span>· 종합 점수 미반영</span></div><ul class="sig-list sig-ref">${refRows}</ul>`
        : ""}
     <div class="sig-foot">${src}${asOf} · 신호를 누르면 의미 설명이 열립니다 · 기술적 참고용이며 투자 판단은 본인 책임</div>`;

  const toggle = (row) => {
    if (!row || !row.classList.contains("has-guide")) return;
    const g = row.querySelector(".sig-guide");
    if (!g) return;
    const open = g.hasAttribute("hidden");
    g.toggleAttribute("hidden", !open);
    row.classList.toggle("open", open);
    row.setAttribute("aria-expanded", open ? "true" : "false");
  };
  box.querySelectorAll(".sig-row.has-guide").forEach((row) => {
    row.addEventListener("click", () => toggle(row));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(row); }
    });
  });
}

const SIG_HELP_HTML = `
  <p>보유 종목의 일봉에서 아래 보조지표를 규칙으로 읽어 <b>지금 나타나는 신호만</b> 모읍니다.
     각 신호는 방향(<span class="sig-tag bull">상승</span>/<span class="sig-tag bear">하락</span>/<span class="sig-tag neutral">중립</span>)과 강도(● ~ ●●●)를 갖고,
     <b>신호를 누르면(마우스오버·터치)</b> 그 지표가 무슨 의미인지 설명이 열립니다.</p>
  <p><b>핵심 지표</b> — 종합 판정에 반영</p>
  <ul>
    <li><b>이동평균 MA(5·20·60·120)</b> — 정배열/역배열, MA20·MA60 골든/데드크로스, 종가의 이평선 위·아래.</li>
    <li><b>RSI(14)</b> — 70↑ 과매수(되돌림 주의), 30↓ 과매도(반등 가능), 50선 돌파로 모멘텀 전환.</li>
    <li><b>MACD(12·26·9)</b> — 시그널선 교차(매수·매도 신호), 0선 위·아래로 중기 모멘텀.</li>
    <li><b>볼린저밴드(20·2σ)</b> — 상·하단 접촉, 밴드 폭이 60거래일 최저면 "스퀴즈"(변동성 확대 임박).</li>
    <li><b>거래량</b> — 20일 평균의 2배 이상 급증 + 주가 방향으로 수급 강도 확인.</li>
    <li><b>스토캐스틱(14·3·3)</b> — 80↑/20↓ 과매수·과매도, 과매도권 %K·%D 골든크로스는 반등 신호.</li>
    <li><b>52주 고·저</b> — 신고가·신저가 ±3% 근접.</li>
  </ul>
  <p><b>참고 지표</b> — 패널에 따로 표시, 종합 점수에는 넣지 않음</p>
  <ul>
    <li><b>MA5×MA20 단기 크로스</b> — 단기 방향 전환(잦게 뒤집힘).</li>
    <li><b>이격도(20일)</b> — 종가가 MA20에서 ±10% 벌어지면 평균 회귀 기대.</li>
    <li><b>CCI(20)</b> — ±100 돌파로 과열·침체.</li>
    <li><b>일목균형표</b> — 구름 위/아래 + 전환선·기준선 정렬로 추세 방향.</li>
    <li><b>OBV</b> — 누적 거래량과 주가의 방향 일치/다이버전스.</li>
    <li><b>연속 양/음봉</b> — 4일 이상 한 방향 캔들.</li>
    <li><b>RSI 다이버전스</b> — 주가와 RSI의 고점·저점 엇갈림(모멘텀 둔화).</li>
  </ul>
  <p>종합 판정은 <b>핵심 신호</b>의 강도를 합산(상승 +, 하락 −)해 <b>±3 이상</b>이면 "상승/하락 우위", 그 사이면 "혼조"로 표시합니다.
     보유목록 밖(＋)으로 추가한 종목은 브라우저에서 같은 규칙으로 즉석 계산합니다.
     자세한 설명: <a href="https://github.com/doheecho/Med-Stock/blob/main/docs/indicators.md" target="_blank" rel="noopener">docs/indicators.md</a></p>`;

/* ---- RSI (일/주/월봉) ---- */
function drawRsiChart(p) {
  const el = document.getElementById("rsiChart");
  if (!el || !state.sub.rsi) return;
  if (!p || !p.dates || !p.close) {
    el.insertAdjacentHTML("afterend", "<div class='error'>RSI 데이터 없음</div>");
    el.remove();
    return;
  }
  const tf = state.rsiTf || "D";
  const rs = resampleClose(p.dates, p.close, tf);
  const rsi = tf === "D" && Array.isArray(p.rsi) ? p.rsi : rsiFrom(rs.close, 14);
  const idxs = sampleIdx(rangeStartIdx(rs.dates), rs.dates.length);
  const xs = idxs.map((k) => new Date(rs.dates[k]).valueOf());
  const ys = idxs.map((k) => rsi[k]);
  const xg = xTimeScale(xKind(), state._xDomain && state._xDomain.lastRealTs);
  xg.grid = { display: false };
  if (state._xDomain) { xg.min = state._xDomain.min; xg.max = state._xDomain.max; }
  makeChart("rsiChart", {
    data: {
      datasets: [
        { type: "line", label: `RSI ${tf === "W" ? "주봉" : tf === "M" ? "월봉" : "일봉"}`, data: xs.map((x, i) => ({ x, y: ys[i] })), borderColor: "#22d3ee", borderWidth: 1.2, pointRadius: 0, spanGaps: true },
        { type: "line", label: "70", data: [{ x: xs[0], y: 70 }, { x: xs[xs.length - 1], y: 70 }], borderColor: "#ef444488", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
        { type: "line", label: "30", data: [{ x: xs[0], y: 30 }, { x: xs[xs.length - 1], y: 30 }], borderColor: "#3b82f688", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
      ],
    },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: xg,
        y: { position: "right", min: 0, max: 100, afterFit: (s) => { s.width = AXIS_Y_W; }, ticks: { color: "#8b95a1", stepSize: 25 }, grid: { color: "#2b333d40" } },
      },
      plugins: { legend: { display: false } },
    },
    plugins: [rsiZoneLabels],
  });
}

/* ---- 스토캐스틱 서브차트 (14·3·3) ---- */
function drawStochChart(p) {
  const el = document.getElementById("stochChart");
  if (!el || !state.sub.stoch) return;
  if (!p || !p.candles || !p.dates) {
    el.insertAdjacentHTML("afterend", "<div class='error'>스토캐스틱 데이터 없음</div>");
    el.remove();
    return;
  }
  const { k, d } = stochFrom(p.candles, 14, 3);
  const idxs = sampleIdx(rangeStartIdx(p.dates), p.dates.length);
  const xs = idxs.map((i) => new Date(p.dates[i]).valueOf());
  const S = (a) => idxs.map((i) => a[i]);
  const xg = xTimeScale(xKind(), state._xDomain && state._xDomain.lastRealTs);
  xg.grid = { display: false };
  if (state._xDomain) { xg.min = state._xDomain.min; xg.max = state._xDomain.max; }
  makeChart("stochChart", {
    data: {
      datasets: [
        { type: "line", label: "%K", data: xs.map((x, i) => ({ x, y: S(k)[i] })), borderColor: "#22d3ee", borderWidth: 1.2, pointRadius: 0, spanGaps: true },
        { type: "line", label: "%D", data: xs.map((x, i) => ({ x, y: S(d)[i] })), borderColor: "#f59e0b", borderWidth: 1.2, pointRadius: 0, spanGaps: true },
        { type: "line", label: "80", data: [{ x: xs[0], y: 80 }, { x: xs[xs.length - 1], y: 80 }], borderColor: "#ef444488", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
        { type: "line", label: "20", data: [{ x: xs[0], y: 20 }, { x: xs[xs.length - 1], y: 20 }], borderColor: "#3b82f688", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
      ],
    },
    options: {
      parsing: false,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: xg,
        y: { position: "right", min: 0, max: 100, afterFit: (s) => { s.width = AXIS_Y_W; }, ticks: { color: "#8b95a1", stepSize: 25 }, grid: { color: "#2b333d40" } },
      },
      plugins: { legend: { labels: { color: "#8b95a1", boxWidth: 12, font: { size: 10 } } } },
    },
    plugins: [stochZoneLabels],
  });
}

/* 오실레이터 차트: 과매수/과매도 버블을 y축 눈금 옆에 그린다 */
function zoneLabelsPlugin(id, obY, osY) {
  return {
    id,
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!scales || !scales.y || !chartArea || !ctx) return;
      const draw = (text, yVal, bg) => {
        const y = scales.y.getPixelForValue(yVal);
        ctx.save();
        ctx.font = "600 10px -apple-system, 'Malgun Gothic', sans-serif";
        const w = ctx.measureText(text).width + 10;
        const x = chartArea.right - w - 4;
        ctx.fillStyle = bg;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y - 9, w, 16, 4);
        else ctx.rect(x, y - 9, w, 16);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x + 5, y);
        ctx.restore();
      };
      draw("과매수", obY, "#ef4444cc");
      draw("과매도", osY, "#3b82f6cc");
    },
  };
}
const rsiZoneLabels = zoneLabelsPlugin("rsiZoneLabels", 85, 15);
const stochZoneLabels = zoneLabelsPlugin("stochZoneLabels", 90, 10);

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
  add("외국인 비율", f.foreign_rate, "%");
  add("시가총액", f.market_cap ? Math.round(f.market_cap / 1e8) : null, f.market_cap ? "억" : "");
  if (f.high_52w != null || f.low_52w != null) {
    rows.push(`<dt>52주 최고/최저</dt><dd>${fmt.num(f.high_52w)} / ${fmt.num(f.low_52w)}</dd>`);
  }
  add("베타", f.beta);
  box.innerHTML = `<dl class="kv">${rows.join("") || "<dt>—</dt><dd>—</dd>"}</dl>
    <div class="src" style="margin-top:8px">기준일 ${f.as_of || f.updated_at || "—"}${f.source ? " · " + f.source : ""}</div>`;
}

/* ---- 주요 지수 / 환율 / 원자재 / 코인 ---- */
function renderIndices() {
  const box = document.getElementById("indicesBox");
  if (!box) return;
  const d = state.indices;
  if (!d || !d.items || !d.items.length) {
    box.innerHTML = "<div class='error'>지수 데이터 없음 (indices_collector 미실행)</div>";
    return;
  }
  const fmtPrice = (v, kind) => {
    if (v == null) return "—";
    if (kind === "usd") return "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (kind === "krw0") return "₩" + Math.round(v).toLocaleString("ko-KR");
    return Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  };
  const rows = d.items
    .map((x) => {
      const chg =
        x.change == null
          ? "—"
          : (x.change >= 0 ? "▲ " : "▼ ") +
            Math.abs(x.change).toLocaleString("ko-KR", { maximumFractionDigits: x.fmt === "krw0" ? 0 : 2 }) +
            (x.change_pct == null
              ? ""
              : ` (${x.change_pct >= 0 ? "+" : "-"}${Math.abs(x.change_pct).toFixed(2)}%)`);
      return `<tr>
        <td>${escapeHtml(x.name)}</td>
        <td>${fmtPrice(x.price, x.fmt)}</td>
        <td class="${cls(x.change)}">${chg}</td>
      </tr>`;
    })
    .join("");
  box.innerHTML = `
    <div class="tbl-scroll"><table class="idx-table">
      <thead><tr><th>지수</th><th>현재가</th><th>전일대비</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="src" style="margin-top:6px">${d.live ? "실시간" : "전일 종가 기준"} · ${shortDate(d.updated_at)}</div>`;
}

/* ---- ETF 구성 종목 (상위 10) ---- */
function renderEtfHoldings(d) {
  const box = document.getElementById("etfBox");
  if (!box) return;
  if (!d || !d.constituents || !d.constituents.length) {
    box.innerHTML = "<div class='error'>구성종목 데이터 없음 (etf_collector 미실행)</div>";
    return;
  }
  const rows = d.constituents
    .map((c) => {
      const chg =
        c.change == null
          ? "—"
          : (c.change >= 0 ? "▲ " : "▼ ") + Math.abs(c.change).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
      return `<tr>
        <td>${escapeHtml(c.name || c.code || "—")}</td>
        <td>${c.price == null ? "—" : Number(c.price).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}</td>
        <td class="${cls(c.change)}">${chg}</td>
        <td class="${cls(c.change_pct)}">${fmt.pct(c.change_pct)}</td>
        <td>${c.weight == null ? "—" : c.weight.toFixed(2) + "%"}</td>
      </tr>`;
    })
    .join("");
  box.innerHTML = `
    <div class="tbl-scroll"><table class="idx-table">
      <thead><tr><th>종목명</th><th>현재가</th><th>전일대비</th><th>등락율</th><th>비중</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="src" style="margin-top:6px">${escapeHtml(d.base_index || "")} 추종 · 상위 ${d.constituents.length}종목 · ${shortDate(d.as_of)}</div>`;
}

/* ---- 수급 막대 (개인·기관·외국인[·기타] 순매수, 억원, 최근 4주) ---- */
function drawFlowChart(flow) {
  const el = document.getElementById("flowChart");
  if (!flow || !flow.rows || !flow.rows.length) {
    el.parentElement.innerHTML =
      "<h3>수급</h3><div class='error'>수급 데이터 없음 (해외 종목·ETF 일부는 미제공)</div>";
    return;
  }
  const rows = flow.rows.slice(-20); // 최근 약 4주(영업일 기준)
  const toEok = (v) => (v == null ? null : Math.round(v / 1e8));
  const hasEtc = rows.some((r) => r.etc != null || r.etc_corp != null);
  const series = [
    ["individual", "개인", "#a855f7"],
    ["institution", "기관", "#f59e0b"],
    ["foreign", "외국인", "#22d3ee"],
  ];
  if (hasEtc) series.push(["etc", "기타", "#8b95a1"]);

  makeChart("flowChart", {
    type: "bar",
    data: {
      labels: rows.map((r) => r.t.slice(5)),
      datasets: series.map(([key, label, color]) => ({
        label,
        data: rows.map((r) => toEok(r[key] ?? r[key + "_corp"])),
        backgroundColor: color,
        // 하루(=한 칸) 안에 3막대를 붙여 넣고, 칸 사이는 벌린다
        categoryPercentage: 0.62,
        barPercentage: 0.95,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: false,
          grid: { display: false },
          ticks: {
            color: "#8b95a1",
            autoSkip: false,
            maxRotation: 0,
            // 월은 빼고 '일'만 앞자리 0 없이(예: 31 1 2 3). 칸이 좁으면 2칸마다 하나씩.
            callback(value, index) {
              const lbl = this.getLabelForValue(value); // "MM-DD"
              const day = String(parseInt(lbl.slice(3), 10));
              const chart = this.chart || {};
              const area = chart.chartArea;
              const w = area ? area.right - area.left : chart.width || 0;
              const labels = (this.getLabels && this.getLabels()) || (chart.data && chart.data.labels) || [];
              const dense = w > 0 && w / (labels.length || 1) < 24;
              if (dense && index % 2 !== 0) return "";
              return day;
            },
          },
        },
        y: {
          position: "right",
          ticks: { color: "#8b95a1" },
          grid: {
            color: (c) => (c.tick.value === 0 ? "#1d4ed8" : "#2b333d40"),
            lineWidth: (c) => (c.tick.value === 0 ? 2 : 1),
          },
        },
      },
      plugins: { legend: { labels: { color: "#8b95a1", boxWidth: 12, font: { size: 10 } } } },
    },
    plugins: [dayDividers],
  });
}

/* 수급 막대: 매 칸(하루) 경계마다 세로 점선 */
const dayDividers = {
  id: "dayDividers",
  afterDatasetsDraw(chart) {
    const x = chart.scales && chart.scales.x;
    const n = ((chart.data && chart.data.labels) || []).length;
    if (!x || n < 2 || !chart.chartArea) return;
    const { top, bottom } = chart.chartArea;
    const half = (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = "#8b95a166";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (let i = 0; i <= n; i++) {
      const px = (i < n ? x.getPixelForValue(i) : x.getPixelForValue(n - 1) + 2 * half) - half;
      if (px < x.left - 1 || px > x.right + 1) continue;
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
      ctx.stroke();
    }
    ctx.restore();
  },
};

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

/* ---- 주가전망: "목표가 (증권사)" 버블. 상단/중간/하단 각 3개(합 9). 클릭 시 리포트 ---- */
function renderForecast(h, t) {
  const box = document.getElementById("forecastBox");
  if (!box) return;
  const m = h.market;
  const items = ((t && t.analyst_targets) || [])
    .filter((x) => x && x.target != null)
    .sort((a, b) => b.target - a.target);

  if (!items.length) {
    const blk = box.closest(".block");
    if (blk) blk.hidden = true;
    else box.innerHTML = "<div class='error'>주가전망 정보 없음</div>";
    return;
  }

  // 정렬된 목록을 항상 상/중/하로 나눔 (각 최대 3)
  const n = items.length;
  let tiers;
  if (n === 1) {
    tiers = [["중간", items, ""]];
  } else {
    const per = Math.max(1, Math.floor(n / 3)); // n=2→1, n=4→1, n=6→2, n=9→3
    tiers = [
      ["상단", items.slice(0, per), "pos"],
      ["중간", items.slice(per, n - per).slice(0, 3), ""],
      ["하단", items.slice(n - per), "neg"],
    ];
  }
  const chip = (x) => {
    const label = `${fmt.price(x.target, m)}${x.firm ? ` (${escapeHtml(x.firm)})` : ""}`;
    return x.url
      ? `<a class="bubble fc-chip" href="${x.url}" target="_blank" rel="noopener">${label}</a>`
      : `<span class="bubble fc-chip">${label}</span>`;
  };

  box.innerHTML =
    tiers
      .filter(([, arr]) => arr.length)
      .map(
        ([name, arr, klass]) => `
      <div class="fc-tier">
        <div class="fc-tier-h ${klass}">${name}</div>
        <div class="firm-bubbles">${arr.map(chip).join("")}</div>
      </div>`
      )
      .join("") +
    `<div class="src" style="margin-top:8px">${
      t && t.source === "yfinance"
        ? "야후 파이낸스 애널리스트 목표가 (최고/평균/중앙값/최저)"
        : items.some((x) => x.src === "yahoo")
        ? `최근 1개월 국내 리포트 + 야후 파이낸스 (${items.length}건)`
        : `최근 1개월 리포트 목표가 (${items.length}건)`
    } · 클릭 시 출처</div>`;
}

/* 투자의견 텍스트 → 색상 클래스 (강력매수/매수/중립/매도/강력매도) */
function opinionClass(s) {
  const t = String(s || "").toLowerCase().replace(/\s+/g, "");
  if (/(strongbuy|적극매수|강력매수)/.test(t)) return "op-sbuy";
  if (/(strongsell|적극매도|강력매도)/.test(t)) return "op-ssell";
  if (/(sell|매도|underperform|underweight|reduce|비중축소)/.test(t)) return "op-sell";
  if (/(buy|매수|outperform|overweight|비중확대|accumulate)/.test(t)) return "op-buy";
  if (/(hold|중립|neutral|보유|marketperform|mar0perform|시장수익률)/.test(t)) return "op-hold";
  return "op-na";
}

/* ---- 투자의견 컨센서스 (최근 1개월, 날짜 내림차순) ---- */
async function renderConsensus(h, t) {
  const box = document.getElementById("consensusBox");
  if (!box) return;
  let rows = (t && t.consensus_rows) || [];
  // 수집기(GitHub Actions)는 한국 금융사이트 IP 차단으로 비어 옴 → 브라우저에서 워커로 조회
  if (!rows.length && PROXY_BASE && /^\d[0-9A-Z]{5}$/.test(h.ticker || "")) {
    box.innerHTML = "<div class='dim'>컨센서스 불러오는 중…</div>";
    try {
      const r = await getJSON(`${PROXY_BASE}/consensus?ticker=${encodeURIComponent(h.ticker)}`);
      rows = (r && r.rows) || [];
    } catch (_) {}
  }
  if (!rows.length) {
    box.innerHTML = "<div class='error'>최근 1개월 내 컨센서스 없음</div>";
    return;
  }
  const num = (v) => (v == null || v === "" || isNaN(+v) ? "—" : (+v).toLocaleString("ko-KR"));
  const pct = (v) =>
    v == null || v === "" || isNaN(+v) ? "—" : `${+v > 0 ? "+" : ""}${(+v).toFixed(1)}%`;
  const body = rows
    .map(
      (r) => `<tr>
      <td>${escapeHtml(r.firm || "—")}</td>
      <td>${escapeHtml(String(r.date || "—").replace(/-/g, "."))}</td>
      <td>${num(r.target)}</td>
      <td>${num(r.prev_target)}</td>
      <td>${pct(r.chg)}</td>
      <td class="${opinionClass(r.opinion)}">${escapeHtml(r.opinion || "—")}</td>
      <td class="${opinionClass(r.prev_opinion)}">${escapeHtml(r.prev_opinion || "—")}</td>
    </tr>`
    )
    .join("");
  box.innerHTML = `<table class="idx-table consensus-table">
    <thead><tr><th>제공처</th><th>최종일자</th><th>목표가</th><th>직전목표가</th><th>변동률(%)</th><th>투자의견</th><th>직전투자의견</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

/* ---- 뉴스 ---- */
function renderNews(news) {
  const box = document.getElementById("newsBox");
  if (!news || !news.items || !news.items.length) {
    box.innerHTML = "<li class='error'>뉴스 없음</li>";
    return;
  }
  box.innerHTML = [...news.items]
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)) // 최신순
    .slice(0, 10)
    .map(
      (n) => `<li><a href="${n.url}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
        <span class="src">${escapeHtml(n.source || "")} ${escapeHtml(newsTime(n.date))}</span></li>`
    )
    .join("");
}

function shortDate(d) {
  if (!d) return "";
  const t = Date.parse(d);
  if (!isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return String(d).slice(0, 16);
}
/* 뉴스: 날짜 + 시:분 (있으면) */
function newsTime(d) {
  const t = Date.parse(d);
  if (isNaN(t)) return String(d || "").slice(0, 16);
  const x = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
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
  if (state._noAnim) cfg.options.animation = false; // 버튼 토글 시 즉시 반영(떠오름 방지)
  state.charts[id] = new Chart(el.getContext("2d"), cfg);
}

/* items: [{label, value(원화)}] — 하단 범례 없이, 조각 위에 "#,###만(#%)",
   마우스오버 시 종목명 툴팁. 칸을 꽉 채운다. */
function drawPie(id, items) {
  // 원그래프가 접혀 있으면 그리지 않는다 (숨김 캔버스에 재생성되어 무한 확장되는 것 방지)
  if (id === "weightChart" && document.querySelector(".summary-charts.pie-collapsed")) return;
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
          backgroundColor: "rgba(255,255,255,0.92)", // 조각색과 글자색이 겹쳐도 보이도록 흰 배경
          borderColor: "rgba(255,255,255,0.95)",
          borderWidth: 1,
          borderRadius: 4,
          padding: { top: 1, bottom: 1, left: 4, right: 4 },
          font: { size: 11, weight: "600" },
          // 마우스오버 전에는 종목명(비중)만. 상세(금액)는 툴팁에서.
          formatter: (v, ctx) =>
            `${ctx.chart.data.labels[ctx.dataIndex]}(${Math.round((v / total) * 100)}%)`,
        },
      },
    },
  });
}
