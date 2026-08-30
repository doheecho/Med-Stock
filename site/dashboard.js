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
  scenarios: {},
  snapshot: null,
  prices: {},       // ticker -> prices json
  live: {},         // ticker -> {price, prevClose, currency,...}
  active: null,
  charts: {},       // canvasId -> Chart
  viewMode: "byTicker",              // "byTicker" | "byAccount"
  fx: null,                          // { USDKRW, date }
  sort: { key: null, dir: "desc" },  // 표 정렬 상태
  advisor: null,                     // data/advisor.json
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
    // 캔들: 한국 관습(상승 빨강 / 하락 파랑) — 데이터셋 옵션이 무시돼도 기본값으로 보장
    if (window.Chart && Chart.defaults.elements) {
      const RED = "#ef4444", BLUE = "#3b82f6", GRAY = "#8b95a1";
      for (const el of ["candlestick", "ohlc"]) {
        const d = Chart.defaults.elements[el];
        if (!d) continue;
        d.color = { up: RED, down: BLUE, unchanged: GRAY };
        d.borderColor = { up: RED, down: BLUE, unchanged: GRAY };
      }
    }
  } catch (_) {}
  document.getElementById("refreshBtn").addEventListener("click", refreshData);
  document.getElementById("advisorBtn").addEventListener("click", refreshAdvisor);
  document.getElementById("viewToggleBtn").addEventListener("click", () =>
    setViewMode(state.viewMode === "byAccount" ? "byTicker" : "byAccount")
  );
  document.querySelectorAll("#posTable thead th").forEach((th) => {
    if (th.dataset.key) th.addEventListener("click", () => onSort(th.dataset.key));
  });
  try {
    state.dataBase = await resolveDataBase();
    const [holdings, scenarios, snapshot, advisor, indices, fx] = await Promise.all([
      getJSON(`${state.dataBase}/holdings.json`).catch(() => null),
      getJSON(`${state.dataBase}/scenarios.json`).catch(() => ({ scenarios: {} })),
      getJSON(`${state.dataBase}/snapshot.json`).catch(() => null),
      getJSON(`${state.dataBase}/advisor.json`).catch(() => null),
      getJSON(`${state.dataBase}/indices.json`).catch(() => null),
      getJSON("https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW")
        .catch(() => getJSON("https://api.frankfurter.app/latest?from=USD&to=KRW"))
        .catch(() => null),
    ]);

    if (fx && fx.rates && fx.rates.KRW) state.fx = { USDKRW: fx.rates.KRW, date: fx.date };
    state.advisor = advisor;
    state.indices = indices;
    renderAdvisor();

    state.snapshot = snapshot;
    state.scenarios = (scenarios && scenarios.scenarios) || {};
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

    buildTabs();
    syncViewToggleBtn();
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

function renderAdvisor() {
  const el = document.getElementById("advisor");
  if (!el) return;
  const a = state.advisor;
  if (!a || !a.comment) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML =
    `<span class="tag">AI Advisor :</span> ` +
    escapeHtml(a.comment) +
    (a.updated_at ? ` <span class="src">(${escapeHtml(shortDate(a.updated_at))})</span>` : "");
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
    for (const h of state.extras) delete state.prices[h.ticker]; // 추가종목은 다시 받도록
    if (snap && snap.as_of) document.getElementById("asOf").textContent = "배치 기준일 " + snap.as_of;
    renderSummary();
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
        showToast("AI Advisor 재생성 요청됨 · 1~2분 후 자동 반영", 3500);
        // 잠시 후부터 몇 차례 advisor.json 을 확인해 갱신되면 반영
        const before = state.advisor && state.advisor.updated_at;
        for (let i = 0; i < 12; i++) {
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
  await Promise.all(
    allHoldings().map(async (h) => {
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

  const [fund, flow, target, news, etfData] = await Promise.all([
    getJSON(`${state.dataBase}/fundamentals/${ticker}.json`).catch(() => null),
    getJSON(`${state.dataBase}/flows/${ticker}.json`).catch(() => null),
    etf ? Promise.resolve(null) : getJSON(`${state.dataBase}/targets/${ticker}.json`).catch(() => null),
    getJSON(`${state.dataBase}/news/${ticker}.json`).catch(() => null),
    etf ? getJSON(`${state.dataBase}/etf/${ticker}.json`).catch(() => null) : Promise.resolve(null),
  ]);
  state.panel = { h, fund, flow, target, news, etfData };

  renderFundamentals(h, fund);
  renderIndices();
  drawFlowChart(flow);
  if (etf) {
    renderEtfHoldings(etfData);
  } else {
    renderTarget(h, target);    // state._targets 캐시 → 시나리오 앵커에 사용
    renderForecast(h, target);
    renderConsensus(target);
  }
  renderNews(news);
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

/* ---- 가격 차트: 기간/이동평균/볼린저/거래량/내매수가/시나리오/일목균형표 ---- */
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
  const UP = "#ef4444", DOWN = "#3b82f6";
  if (useCandle) {
    // chartjs-chart-financial@0.2.1 은 up/down 키가 뒤집혀 있음:
    //   close<open → *.up  /  close>open → *.down  → 아래처럼 매핑
    const ckUp = DOWN, ckDown = UP, ckUnch = "#8b95a1";
    datasets.push({
      type: "candlestick",
      label: h.name || h.ticker,
      data: pick(p.candles).map((c) => ({ x: new Date(c.t).valueOf(), o: c.o, h: c.h, l: c.l, c: c.c })),
      borderColors: { up: ckUp, down: ckDown, unchanged: ckUnch },
      backgroundColors: { up: ckUp, down: ckDown, unchanged: ckUnch },
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

  // ---- 목표주가 점선 (ETF 제외, 1년 이상 구간에서만). 실제 목표시점(12M)과
  //      무관하게 과거 구간을 넓히려고 x축은 약 1개월분만 사용, 전망 구간 라벨은 숨김 ----
  const showScenario =
    !isEtf(h) && ["1Y", "3Y", "5Y"].includes(state.chartRange);
  const cur = priceOf(h.ticker) ?? p.last_close;
  if (showScenario) {
    const anchor = lastRealTs;
    const horizon = anchor + 30 * 864e5; // 약 1개월
    xMax = Math.max(xMax, horizon);
    for (const sc of scenarioAnchors(h)) {
      datasets.push({
        type: "line", label: sc.label, borderColor: sc.color, borderDash: [5, 5], borderWidth: 1.5,
        pointRadius: 3, pointBackgroundColor: sc.color, order: 1,
        data: [{ x: anchor, y: cur }, { x: horizon, y: sc.target }],
      });
    }
  }

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
    <div class="src" style="margin-top:6px">전일 종가 기준 · ${shortDate(d.updated_at)}</div>`;
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
function renderConsensus(t) {
  const box = document.getElementById("consensusBox");
  if (!box) return;
  const rows = (t && t.consensus_rows) || [];
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
