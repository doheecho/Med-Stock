/**
 * 실시간 시세 CORS 프록시 (Cloudflare Worker, 무료 티어)
 *
 * GET /?ticker=005930   → 네이버 국내 실시간 시세 JSON
 * GET /?ticker=MU       → 야후 파이낸스 chart JSON
 *
 * 응답에는 항상 { ticker, price, prevClose, currency, source, raw } 로 정규화한
 * JSON 을 돌려준다. (raw 는 원본 그대로 — 필요 시 프론트에서 참고)
 *
 * GET /dispatch?wf=advisor  → GitHub Actions "Refresh AI Advisor" 워크플로 실행
 * GET /dispatch?wf=update   → "Update dashboard data" 워크플로 실행
 *   (대시보드의 "↻ AI Advisor" 버튼이 /dispatch?wf=advisor 를 호출한다)
 *
 * 배포:
 *   npm i -g wrangler
 *   cd proxy && wrangler deploy
 *   wrangler secret put GH_DISPATCH_TOKEN     # fine-grained PAT (Actions: Read and write)
 * 배포 후 나온 URL 을 site/dashboard.js 의 PROXY_BASE 에 넣는다.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // GET /dispatch?wf=advisor|update  → GitHub Actions workflow_dispatch 트리거
    //   필요:  GH_DISPATCH_TOKEN (Worker secret · fine-grained PAT · Actions: Read and write)
    //          GH_REPO           (선택 · [vars] 또는 secret · 기본값 doheecho/Med-Stock)
    const path = url.pathname.replace(/\/+$/, "");

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
      const data = isKRX ? await fetchNaver(ticker) : await fetchYahoo(ticker);
      return json(data, 200);
    } catch (err) {
      return json({ ticker, error: String(err && err.message || err) }, 502);
    }
  },
};

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
