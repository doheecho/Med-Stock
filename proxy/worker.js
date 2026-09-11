/**
 * 실시간 시세 CORS 프록시 (Cloudflare Worker, 무료 티어)
 *
 * GET /?ticker=005930   → NH투자증권 나무플러그(NH PLUG) 국내 실시간 시세 JSON (실패 시 네이버 폴백)
 * GET /?ticker=MU       → NH PLUG 해외 실시간 시세 JSON (실패 시 야후 폴백)
 *
 * 응답에는 항상 { ticker, price, prevClose, currency, source, raw } 로 정규화한
 * JSON 을 돌려준다. (raw 는 원본 그대로 — 필요 시 프론트에서 참고, source 로 실제 사용된
 * 공급자(nhplug/naver/yahoo)를 구분)
 *
 * GET /indices           → 코스피·코스닥·다우·나스닥·환율·금/은/WTI·BTC/ETH/XRP 실시간 일괄 조회
 *   (코스피·코스닥은 네이버, 나머지는 야후 — NH PLUG 는 지수 조회 API가 없어 대상이 아니다.
 *    배치 data/indices.json 과 같은 스키마라 프론트에서 제자리 치환한다.)
 *
 * GET /ws?tickers=005930,000660   (WebSocket) → NH PLUG 국내 실시간체결가 릴레이.
 *   브라우저는 wss:// 로 이 워커에 붙고, 워커가 NH PLUG 와의 연결·토큰을 대신 들고 있는다
 *   (access token을 브라우저에 노출하지 않기 위해). 해외종목은 NH PLUG WS가 별도 GIC 코드를
 *   요구해 미지원 — 해외는 계속 REST(/?ticker=) 폴링만 쓴다.
 *
 * GET /dispatch?wf=advisor  → GitHub Actions "Refresh AI Advisor" 워크플로 실행
 * GET /dispatch?wf=update   → "Update dashboard data" 워크플로 실행
 *   (대시보드의 "↻ AI Advisor" 버튼이 /dispatch?wf=advisor 를 호출한다)
 *
 * 배포:
 *   npm i -g wrangler
 *   cd proxy && wrangler deploy
 *   wrangler secret put GH_DISPATCH_TOKEN     # fine-grained PAT (Actions: Read and write)
 *   wrangler secret put NH_APP_KEY            # 나무플러그(nhplug.com) 발급 API KEY
 *   wrangler secret put NH_APP_SECRET         # 나무플러그 발급 APP SECRET
 * 배포 후 나온 URL 을 site/dashboard.js 의 PROXY_BASE 에 넣는다.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // GET /dispatch?wf=advisor|update  → GitHub Actions workflow_dispatch 트리거
    //   필요:  GH_DISPATCH_TOKEN (Worker secret · fine-grained PAT · Actions: Read and write)
    //          GH_REPO           (선택 · [vars] 또는 secret · 기본값 doheecho/Med-Stock)
    const path = url.pathname.replace(/\/+$/, "");

    // GET /ws?tickers=005930,000660  (WebSocket Upgrade) → NH PLUG 실시간체결가(oc) 릴레이.
    //   시크릿(access token)은 워커 안에만 두고, 브라우저엔 정규화된 틱만 보낸다.
    if (path === "/ws") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return json({ error: "websocket upgrade required" }, 426);
      }
      const tickers = (url.searchParams.get("tickers") || "")
        .split(",")
        .map((s) => s.trim())
        .filter((t) => /^\d[0-9A-Z]{5}$/.test(t))
        .slice(0, 30); // NH PLUG 채널당 최대 30 구독
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const relay = relayNH(server, tickers, env).catch((err) => {
        try { server.close(1011, String((err && err.message) || err).slice(0, 120)); } catch (_) {}
      });
      if (ctx && ctx.waitUntil) ctx.waitUntil(relay);
      return new Response(null, { status: 101, webSocket: client });
    }

    // GET /indices → 코스피/코스닥/환율/원자재/암호화폐 실시간 일괄 조회 (배치 data/indices.json 와 동일 스키마)
    if (path === "/indices") {
      const items = await Promise.all(
        INDEX_SPEC.map(async (spec) => {
          try {
            const q = spec.naver
              ? await fetchNaverIndex(spec.naver)
              : await fetchYahooIndex(spec.yahoo, spec.scale || 1);
            return { key: spec.key, name: spec.name, fmt: spec.fmt, ...q };
          } catch (err) {
            return {
              key: spec.key, name: spec.name, fmt: spec.fmt,
              price: null, prev: null, change: null, change_pct: null,
              error: String((err && err.message) || err),
            };
          }
        })
      );
      return json({ items, updated_at: new Date().toISOString() }, 200);
    }

    if (path === "/dispatch") {
      return dispatchWorkflow(
        url.searchParams.get("wf") || "advisor",
        env,
        url.searchParams.get("ref")
      );
    }

    // GET /search?q=삼성 → 회사명/코드 자동완성 (종목 추가용)
    if (path === "/search") {
      try {
        return json(await searchStock(url.searchParams.get("q") || ""), 200);
      } catch (err) {
        return json({ items: [], error: String((err && err.message) || err) }, 502);
      }
    }

    // GET /stockinfo?ticker=005930 → 기본지표·목표주가·수급·뉴스 한 번에 (추가 종목용)
    if (path === "/stockinfo") {
      const t = (url.searchParams.get("ticker") || "").trim();
      if (!/^\d[0-9A-Z]{5}$/.test(t)) {
        return json({ ticker: t, fundamentals: null, target: null, flow: null, news: null }, 200);
      }
      try {
        return json(await stockInfo(t), 200);
      } catch (err) {
        return json({ ticker: t, error: String((err && err.message) || err) }, 502);
      }
    }

    // GET /consensus?ticker=005930 → 제공처별 투자의견 컨센서스
    //   (네이버 증권 종목분석 표. GitHub Actions IP 는 차단돼 브라우저→워커로 받는다)
    if (path === "/consensus") {
      const t = (url.searchParams.get("ticker") || "").trim();
      if (!/^\d[0-9A-Z]{5}$/.test(t)) return json({ ticker: t, rows: [] }, 200);
      try {
        return json(await consensusRows(t), 200);
      } catch (err) {
        return json({ ticker: t, rows: [], error: String((err && err.message) || err) }, 502);
      }
    }

    // GET /history?ticker=005930 → 일봉 OHLCV (보유목록 밖 종목 차트용)
    if (path === "/history") {
      const t = (url.searchParams.get("ticker") || url.searchParams.get("code") || "").trim();
      if (!t) return json({ error: "ticker required" }, 400);
      try {
        const isKRX = /^\d[0-9A-Z]{5}$/.test(t);
        return json(isKRX ? await histNaver(t) : await histYahoo(t), 200);
      } catch (err) {
        return json({ ticker: t, error: String((err && err.message) || err) }, 502);
      }
    }

    const ticker = (url.searchParams.get("ticker") || "").trim();
    if (!ticker) {
      return json({ error: "ticker required" }, 400);
    }

    // KRX 종목/ETF 코드: 6자리, 숫자로 시작(ETF 는 "0183J0" 처럼 영문 혼합 가능).
    // 미국 심볼은 영문으로 시작(MU, AAPL...) → 야후로 라우팅.
    const isKRX = /^\d[0-9A-Z]{5}$/.test(ticker);
    try {
      const data = isKRX
        ? await fetchDomestic(ticker, env)
        : await fetchOverseas(ticker, env);
      return json(data, 200);
    } catch (err) {
      return json({ ticker, error: String(err && err.message || err) }, 502);
    }
  },
};

// NH PLUG 우선, 실패(키 미설정·오류·rsp_cd 비정상) 시 기존 소스로 폴백.
async function fetchDomestic(ticker, env) {
  if (env && env.NH_APP_KEY && env.NH_APP_SECRET) {
    try {
      return await fetchNHDomestic(ticker, env);
    } catch (err) {
      console.log("nhplug domestic fail, fallback to naver:", ticker, String(err && err.message || err));
    }
  }
  return fetchNaver(ticker);
}

async function fetchOverseas(ticker, env) {
  if (env && env.NH_APP_KEY && env.NH_APP_SECRET) {
    try {
      return await fetchNHOverseas(ticker, env);
    } catch (err) {
      console.log("nhplug overseas fail, fallback to yahoo:", ticker, String(err && err.message || err));
    }
  }
  return fetchYahoo(ticker);
}

const _WF_FILE = { advisor: "advisor.yml", update: "update.yml" };
const _DEFAULT_REPO = "doheecho/Med-Stock";

// GET /dispatch?wf=advisor[&ref=main]  → GitHub Actions workflow_dispatch
async function dispatchWorkflow(wf, env, ref) {
  const file = _WF_FILE[wf];
  if (!file) return json({ error: `unknown workflow: ${wf}` }, 400);

  const token = env && env.GH_DISPATCH_TOKEN;
  const repo = (env && env.GH_REPO) || _DEFAULT_REPO;
  if (!token) {
    return json(
      { error: "GH_DISPATCH_TOKEN 미설정 — `wrangler secret put GH_DISPATCH_TOKEN` 필요" },
      501
    );
  }

  const api = `https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`;
  let res;
  try {
    res = await fetch(api, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "med-stock-proxy",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: ref || "main" }),
    });
  } catch (err) {
    return json({ ok: false, error: `github fetch 실패: ${String(err && err.message || err)}` }, 502);
  }

  // 성공 시 204 No Content. 실패면 본문에 사유가 담겨 온다(잘못된 토큰/권한/ref 등).
  if (res.status === 204) {
    return json({ ok: true, status: 204, repo, workflow: file, ref: ref || "main" }, 200);
  }
  const detail = await res.text().catch(() => "");
  return json({ ok: false, status: res.status, repo, workflow: file, detail: detail.slice(0, 400) }, 502);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

async function fetchNaver(ticker) {
  const upstream = `https://polling.finance.naver.com/api/realtime/domestic/stock/${ticker}`;
  const res = await fetch(upstream, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://finance.naver.com/",
    },
    cf: { cacheTtl: 0 },
  });
  const raw = await res.json();

  // 응답 스키마 변형 대응
  const item =
    raw?.datas?.[0] ||
    raw?.result?.areas?.[0]?.datas?.[0] ||
    raw?.[0] ||
    {};

  const price = num(item.closePrice ?? item.nv ?? item.now ?? item.tradePrice);
  const prevClose = num(
    item.compareToPreviousClosePrice != null && price != null
      ? price - num(item.compareToPreviousClosePrice)
      : item.pcv ?? item.prevClosePrice
  );

  return {
    ticker,
    price,
    prevClose,
    changePct: num(item.fluctuationsRatio ?? item.rate),
    currency: "KRW",
    source: "naver",
    ts: Date.now(),
    raw,
  };
}

async function fetchYahoo(ticker) {
  const upstream =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?range=1d&interval=1m`;
  const res = await fetch(upstream, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cf: { cacheTtl: 0 },
  });
  const raw = await res.json();
  const r = raw?.chart?.result?.[0];
  const meta = r?.meta || {};

  return {
    ticker,
    price: num(meta.regularMarketPrice),
    prevClose: num(meta.chartPreviousClose ?? meta.previousClose),
    changePct:
      meta.regularMarketPrice != null && meta.chartPreviousClose
        ? round(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100, 2)
        : null,
    currency: meta.currency || "USD",
    source: "yahoo",
    ts: Date.now(),
    raw,
  };
}

// ── 주요 지수·환율·원자재·암호화폐 (실시간, /indices) ───────────────────
// NH PLUG 는 지수 조회 API가 없어 collectors/indices_collector.py 의 _SPEC 과 같은
// 소스(코스피·코스닥=네이버, 나머지=야후)를 그대로 라이브로 쓴다. 스펙 바뀌면 양쪽 다 고칠 것.
const INDEX_SPEC = [
  { key: "KOSPI", name: "KOSPI", naver: "KOSPI", fmt: "pt" },
  { key: "KOSDAQ", name: "KOSDAQ", naver: "KOSDAQ", fmt: "pt" },
  { key: "DJI", name: "다우 산업", yahoo: "^DJI", fmt: "pt" },
  { key: "IXIC", name: "나스닥 종합", yahoo: "^IXIC", fmt: "pt" },
  { key: "SOX", name: "필라델피아 반도체", yahoo: "^SOX", fmt: "pt" },
  { key: "SPX", name: "S&P 500", yahoo: "^GSPC", fmt: "pt" },
  { key: "USDKRW", name: "원/달러", yahoo: "KRW=X", fmt: "krw" },
  { key: "EURKRW", name: "원/유로", yahoo: "EURKRW=X", fmt: "krw" },
  { key: "JPYKRW100", name: "원/엔100", yahoo: "JPYKRW=X", fmt: "krw", scale: 100 },
  { key: "GOLD", name: "금 선물", yahoo: "GC=F", fmt: "usd" },
  { key: "SILVER", name: "은 선물", yahoo: "SI=F", fmt: "usd" },
  { key: "WTI", name: "WTI 선물", yahoo: "CL=F", fmt: "usd" },
  { key: "BTC", name: "비트코인", yahoo: "BTC-KRW", fmt: "krw0" },
  { key: "ETH", name: "이더리움", yahoo: "ETH-KRW", fmt: "krw0" },
  { key: "XRP", name: "리플", yahoo: "XRP-KRW", fmt: "krw" },
];

async function fetchNaverIndex(key) {
  const upstream = `https://polling.finance.naver.com/api/realtime/domestic/index/${key}`;
  const res = await fetch(upstream, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.naver.com/" },
    cf: { cacheTtl: 0 },
  });
  const raw = await res.json();
  const item = raw?.datas?.[0] || {};
  const price = num(item.closePriceRaw ?? item.closePrice);
  const change = num(item.compareToPreviousClosePriceRaw ?? item.compareToPreviousClosePrice);
  const change_pct = num(item.fluctuationsRatioRaw ?? item.fluctuationsRatio);
  return {
    price,
    prev: price != null && change != null ? round(price - change, 4) : null,
    change,
    change_pct,
  };
}

async function fetchYahooIndex(symbol, scale) {
  const y = await fetchYahoo(symbol);
  const s = scale || 1;
  return {
    price: y.price != null ? round(y.price * s, 4) : null,
    prev: y.prevClose != null ? round(y.prevClose * s, 4) : null,
    change: y.price != null && y.prevClose != null ? round((y.price - y.prevClose) * s, 4) : null,
    change_pct: y.changePct,
  };
}

// ── NH투자증권 나무플러그(NH PLUG) OpenAPI ──────────────────────────────
// https://www.nhplug.com — REST, appkey+appsecretkey → OAuth2 Bearer 토큰(24h).
// 토큰은 같은(warm) 워커 인스턴스 안에서만 메모리 캐시(콜드스타트 시 새로 발급).
// 재발급은 보안 알림을 유발하므로 만료 직전(또는 401)에만 재발급한다.
const NH_BASE = "https://api.nhplug.com:8443";
const NH_WS_BASE = "wss://api.nhplug.com:7070";
let _nhTokenCache = { token: null, exp: 0 };

async function nhToken(env, force) {
  if (!force && _nhTokenCache.token && Date.now() < _nhTokenCache.exp) {
    return _nhTokenCache.token;
  }
  const res = await fetch(`${NH_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      appkey: env.NH_APP_KEY,
      appsecretkey: env.NH_APP_SECRET,
      grant_type: "client_credentials",
      scope: "oob",
    }),
  });
  if (!res.ok) throw new Error(`nhplug token http ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error("nhplug token: access_token 없음");
  _nhTokenCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 86400) * 1000 - 60000 };
  return _nhTokenCache.token;
}

// 401(토큰 만료/무효) 한정으로 1회 재발급 후 재시도.
async function nhPost(env, path, body) {
  let token = await nhToken(env);
  let res = await nhCall(path, token, body);
  if (res.status === 401) {
    token = await nhToken(env, true);
    res = await nhCall(path, token, body);
  }
  if (!res.ok) throw new Error(`nhplug ${path} http ${res.status}`);
  const j = await res.json();
  if (j.rsp_cd && j.rsp_cd !== "00000") throw new Error(`nhplug ${path} rsp_cd=${j.rsp_cd} ${j.rsp_msg || ""}`);
  return j;
}

function nhCall(path, token, body) {
  return fetch(`${NH_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fetchNHDomestic(ticker, env) {
  const raw = await nhPost(env, "/krstock/quote/v1/currentPrice", {
    Input_0: { market_cd: "KRX", iem_cd: ticker },
  });
  const o = raw.Output_0 || {};
  const price = num(o.stck_prpr);
  const prevClose = num(o.stck_prdy_clpr);
  if (price == null) throw new Error("nhplug domestic: stck_prpr 없음");
  return {
    ticker,
    price,
    prevClose,
    changePct: prevClose ? round(((price - prevClose) / prevClose) * 100, 2) : null,
    currency: "KRW",
    source: "nhplug",
    ts: Date.now(),
    raw,
  };
}

async function fetchNHOverseas(ticker, env) {
  const raw = await nhPost(env, "/gbstock/quote/v1/current", { Input_0: { iem_cd: ticker } });
  const o = raw.Output_0 || {};
  const price = num(o.trdprc);
  if (price == null) throw new Error("nhplug overseas: trdprc 없음");
  const down = o.netchng_cls === "5";
  const netchng = num(o.netchng);
  const pctchng = num(o.pctchng);
  const prevClose = netchng != null ? price - (down ? -Math.abs(netchng) : Math.abs(netchng)) : num(o.base_prc);
  return {
    ticker,
    price,
    prevClose,
    changePct: pctchng != null ? (down ? -Math.abs(pctchng) : Math.abs(pctchng)) : null,
    currency: o.currency_unit || "USD",
    source: "nhplug",
    ts: Date.now(),
    raw,
  };
}

// 국내 실시간체결가(WebSocket). 서버 소켓(client용 WebSocketPair 쪽)에 정규화된 틱만 보내고
// access_token 은 워커 밖으로 절대 내보내지 않는다. tickers 는 6자리 KRX 코드만.
async function relayNH(server, tickers, env) {
  if (!env || !env.NH_APP_KEY || !env.NH_APP_SECRET) {
    server.send(JSON.stringify({ type: "error", detail: "NH_APP_KEY/NH_APP_SECRET 미설정" }));
    server.close(1011, "no credentials");
    return;
  }
  if (!tickers.length) {
    server.close(1008, "tickers required");
    return;
  }

  const token = await nhToken(env);
  const upstream = new WebSocket(`${NH_WS_BASE}/websocket`);
  await new Promise((resolve, reject) => {
    upstream.addEventListener("open", resolve, { once: true });
    upstream.addEventListener("error", () => reject(new Error("nhplug ws connect 실패")), { once: true });
  });

  for (const t of tickers) {
    upstream.send(JSON.stringify({ header: { token, tr_type: "1" }, body: { tr_cd: "oc", tr_key: t } }));
  }

  upstream.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch (_) {
      return;
    }
    const header = msg && msg.header;
    if (header && header.rsp_cd) {
      // 구독 등록 ack — 실패한 것만 클라이언트에 알림
      if (header.rsp_cd !== "00000") {
        try { server.send(JSON.stringify({ type: "error", detail: msg })); } catch (_) {}
      }
      return;
    }
    const tick = normalizeTick(msg && msg.body);
    if (tick) {
      try { server.send(JSON.stringify({ type: "tick", ...tick })); } catch (_) {}
    }
  });
  upstream.addEventListener("close", () => { try { server.close(1011, "nhplug ws closed"); } catch (_) {} });
  upstream.addEventListener("error", () => { try { server.close(1011, "nhplug ws error"); } catch (_) {} });
  server.addEventListener("close", () => { try { upstream.close(); } catch (_) {} });
}

// oc 채널 body 필드명이 공식 문서에 없어 REST currentPrice(Output_0)와 같은 이름을
// 우선 시도하고, 흔한 대안 필드명까지 방어적으로 폴백한다.
function normalizeTick(o) {
  if (!o) return null;
  const ticker = o.iem_cd || o.code || o.tr_key;
  const price = num(o.stck_prpr ?? o.prpr ?? o.trdprc ?? o.price ?? o.cntg_prc);
  if (!ticker || price == null) return null;
  const prevClose = num(o.stck_prdy_clpr ?? o.prdy_clpr ?? o.base_prc);
  const changePct =
    num(o.prdy_ctrt) ?? (prevClose ? round(((price - prevClose) / prevClose) * 100, 2) : null);
  return { ticker, price, prevClose, changePct, ts: Date.now() };
}

// ── 종목 검색 (네이버 자동완성) ─────────────────────────────────────────
async function searchStock(q) {
  q = String(q || "").trim();
  if (!q) return { q, items: [] };
  const up = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`;
  const raw = await (
    await fetch(up, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" },
      cf: { cacheTtl: 120 },
    })
  ).json();
  const mkt = (tc, tn) =>
    tc === "KOSDAQ" ? "KOSDAQ" : tc === "KOSPI" ? "KOSPI" : tn || tc || "";
  const items = (raw.items || [])
    .map((x) => ({
      code: x.code,
      name: x.name,
      market: mkt(x.typeCode, x.typeName),
      nation: x.nationCode || "KOR",
    }))
    .filter((x) => x.code && x.name);
  return { q, items };
}

// ── 기본지표 · 목표주가 · 수급 · 뉴스 (추가 종목용) ────────────────────
const _koNum = (s) => {
  const v = Number(String(s == null ? "" : s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(v) ? v : null;
};
// "1,502조 4,936억" → 원
function _koWon(s) {
  s = String(s || "");
  const jo = s.match(/([\d,]+)\s*조/);
  const eok = s.match(/([\d,]+)\s*억/);
  let won = 0, hit = false;
  if (jo) { won += Number(jo[1].replace(/,/g, "")) * 1e12; hit = true; }
  if (eok) { won += Number(eok[1].replace(/,/g, "")) * 1e8; hit = true; }
  if (hit) return won;
  const n = _koNum(s);
  return n == null ? null : n;
}
function _opinionOf(mean) {
  const m = Number(mean);
  if (!Number.isFinite(m)) return null;
  if (m >= 4.5) return "적극매수";
  if (m >= 3.5) return "매수";
  if (m >= 2.5) return "중립";
  return "매도";
}

async function stockInfo(code) {
  const H = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };
  const integ = await (
    await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, { headers: H, cf: { cacheTtl: 900 } })
  ).json();

  const ti = {};
  for (const x of integ.totalInfos || []) ti[x.code] = x.value;
  const fundamentals = {
    per: _koNum(ti.per),
    forward_per: _koNum(ti.cnsPer),
    pbr: _koNum(ti.pbr),
    eps: _koNum(ti.eps),
    bps: _koNum(ti.bps),
    div_yield: _koNum(ti.dividendYieldRatio),
    foreign_rate: _koNum(ti.foreignRate),
    market_cap: _koWon(ti.marketValue),
    high_52w: _koNum(ti.highPriceOf52Weeks),
    low_52w: _koNum(ti.lowPriceOf52Weeks),
    as_of: new Date().toISOString().slice(0, 10),
    source: "네이버",
  };

  const ci = integ.consensusInfo || {};
  const avg = _koNum(ci.priceTargetMean);
  const target = avg
    ? { target_avg: avg, opinion: _opinionOf(ci.recommMean), source: "네이버 컨센서스" }
    : null;

  const [flow, news] = await Promise.all([
    flowRows(code).catch(() => null),
    newsItems(code).catch(() => null),
  ]);
  return { ticker: code, fundamentals, target, flow, news };
}

async function flowRows(code) {
  const byDate = {};
  for (const page of [1, 2]) {
    const buf = await (
      await fetch(`https://finance.naver.com/item/frgn.naver?code=${code}&page=${page}`, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.naver.com/" },
        cf: { cacheTtl: 1800 },
      })
    ).arrayBuffer();
    const html = new TextDecoder("euc-kr").decode(buf);
    // frgn 페이지엔 type2 표가 여러 개 → 날짜가 든 데이터 표를 고른다
    const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
    const tbl = tables.find(
      (t) => /\d{4}\.\d{2}\.\d{2}/.test(t) && (t.match(/<td/gi) || []).length > 20
    );
    if (!tbl) continue;
    for (const tr of tbl.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const c = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map((s) =>
        s.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim()
      );
      if (c.length < 9 || !/\d{4}\.\d{2}\.\d{2}/.test(c[0])) continue;
      const close = _koNum(c[1]);
      const instQ = _koNum(c[5]);
      const frgnQ = _koNum(c[6]);
      if (close == null) continue;
      const t = c[0].replace(/\./g, "-");
      const inst = instQ == null ? null : Math.round(instQ * close);
      const frgn = frgnQ == null ? null : Math.round(frgnQ * close);
      const indiv = inst != null && frgn != null ? -(inst + frgn) : null;
      byDate[t] = { t, institution: inst, foreign: frgn, individual: indiv };
    }
  }
  // 최근 며칠 개인 실측치로 덮어쓰기
  try {
    const tr = await (
      await fetch(`https://m.stock.naver.com/api/stock/${code}/trend`, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" },
        cf: { cacheTtl: 900 },
      })
    ).json();
    for (const x of tr || []) {
      const bd = String(x.bizdate || "");
      const t = bd.length === 8 ? `${bd.slice(0, 4)}-${bd.slice(4, 6)}-${bd.slice(6, 8)}` : bd;
      const iq = _koNum(x.individualPureBuyQuant);
      const cp = _koNum(x.closePrice);
      if (byDate[t] && iq != null && cp) byDate[t].individual = Math.round(iq * cp);
    }
  } catch (_) {}

  const rows = Object.keys(byDate).sort().map((t) => byDate[t]);
  if (!rows.length) return null;
  return {
    rows,
    source: "naver(frgn)",
    note: "기관·외국인 순매매 수량을 종가로 환산한 근사치. 개인은 -(기관+외국인) 근사(최근일 실측).",
  };
}

async function newsItems(code) {
  const raw = await (
    await fetch(`https://m.stock.naver.com/api/news/stock/${code}?pageSize=15&page=1`, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" },
      cf: { cacheTtl: 600 },
    })
  ).json();
  const items = [];
  for (const cluster of Array.isArray(raw) ? raw : []) {
    const it = (cluster.items || [])[0];
    if (!it) continue;
    const dt = String(it.datetime || "");
    const iso =
      dt.length >= 12
        ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(8, 10)}:${dt.slice(10, 12)}`
        : null;
    items.push({
      title: it.title,
      url: `https://n.news.naver.com/article/${it.officeId}/${it.articleId}`,
      date: iso,
      source: it.officeName || "",
    });
  }
  return items.length ? { items } : null;
}

// ── 투자의견 컨센서스 (wisereport c1010001 table#cTB24) ───────────────
async function consensusRows(code) {
  const up = `https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd=${code}`;
  const html = await (
    await fetch(up, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: `https://finance.naver.com/item/coinfo.naver?code=${code}`,
      },
      cf: { cacheTtl: 1800 },
    })
  ).text();

  const m = html.match(/<table[^>]*id=["']cTB24["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!m) return { ticker: code, rows: [] };
  const strip = (s) =>
    s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
  const cleanOp = (s) => (s.replace(/\s*(펼치기|접기)\s*$/, "").trim() || null);
  const int = (s) => {
    const v = Number(String(s).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  };
  const flt = (s) => {
    const v = Number(String(s).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(v) ? v : null;
  };

  const cutoff = new Date(Date.now() - 31 * 864e5);
  const rows = [];
  for (const tr of m[1].match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    if (/<th[\s>]/i.test(tr)) continue;
    const c = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(strip);
    if (c.length < 7) continue;
    const dm = String(c[1]).match(/(\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
    if (!dm) continue;
    const iso = `20${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}`;
    if (new Date(iso) < cutoff) continue;
    rows.push({
      firm: c[0] || null,
      date: iso,
      target: int(c[2]),
      prev_target: int(c[3]),
      chg: flt(c[4]),
      opinion: cleanOp(c[5]),
      prev_opinion: cleanOp(c[6]),
    });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { ticker: code, rows: rows.slice(0, 30) };
}

// ── 일봉 OHLCV ────────────────────────────────────────────────────────
async function histNaver(code) {
  const end = new Date();
  const start = new Date(end.getTime() - 5 * 366 * 864e5); // ~5년치
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const up =
    `https://api.finance.naver.com/siseJson.naver?symbol=${code}` +
    `&requestType=1&startTime=${ymd(start)}&endTime=${ymd(end)}&timeframe=day`;
  const txt = await (
    await fetch(up, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.naver.com/" },
      cf: { cacheTtl: 3600 },
    })
  ).text();
  const arr = JSON.parse(txt.replace(/'/g, '"')); // 헤더행은 홑따옴표라 치환 필요
  const dates = [], open = [], high = [], low = [], close = [], volume = [];
  for (const r of arr.slice(1)) {
    const s = String(r[0]);
    dates.push(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
    open.push(num(r[1])); high.push(num(r[2])); low.push(num(r[3]));
    close.push(num(r[4])); volume.push(num(r[5]));
  }
  return { ticker: code, source: "naver", currency: "KRW", dates, open, high, low, close, volume };
}

async function histYahoo(sym) {
  const up =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
    `?range=5y&interval=1d`;
  const raw = await (await fetch(up, { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 3600 } })).json();
  const r = raw?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0] || {};
  const ts = r?.timestamp || [];
  const dates = ts.map((t) => new Date(t * 1000).toISOString().slice(0, 10));
  return {
    ticker: sym, source: "yahoo",
    currency: r?.meta?.currency || "USD",
    dates,
    open: q.open || [], high: q.high || [], low: q.low || [], close: q.close || [], volume: q.volume || [],
  };
}

function num(v) {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
