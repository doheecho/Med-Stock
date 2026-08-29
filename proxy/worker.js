/**
 * 실시간 시세 CORS 프록시 (Cloudflare Worker, 무료 티어)
 *
 * GET /?ticker=005930   → 네이버 국내 실시간 시세 JSON
 * GET /?ticker=MU       → 야후 파이낸스 chart JSON
 *
 * 응답에는 항상 { ticker, price, prevClose, currency, source, raw } 로 정규화한
 * JSON 을 돌려준다. (raw 는 원본 그대로 — 필요 시 프론트에서 참고)
 *
 * 배포:
 *   npm i -g wrangler
 *   wrangler deploy proxy/worker.js --name med-stock-proxy
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

    // GET /dispatch?wf=advisor  → GitHub Actions workflow_dispatch 트리거
    //   필요 Worker 시크릿:  GH_DISPATCH_TOKEN (fine-grained PAT, Actions: read/write)
    //                        GH_REPO          (예: "doheecho/Med-Stock")
    if (url.pathname.replace(/\/+$/, "") === "/dispatch") {
      return dispatchWorkflow(url.searchParams.get("wf") || "advisor", env);
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

async function dispatchWorkflow(wf, env) {
  const file = _WF_FILE[wf];
  if (!file) return json({ error: "unknown workflow" }, 400);
  if (!env || !env.GH_DISPATCH_TOKEN || !env.GH_REPO) {
    return json({ error: "worker secrets GH_DISPATCH_TOKEN / GH_REPO 미설정" }, 501);
  }
  const res = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${file}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "med-stock-proxy",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );
  // 성공 시 204 No Content
  return json({ ok: res.status === 204, status: res.status, workflow: file }, res.status === 204 ? 200 : 502);
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

function num(v) {
  if (v == null) return null;
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, d) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
