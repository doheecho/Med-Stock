"""증권사 목표주가 컨센서스 / 투자의견.

KRX  : 네이버페이 증권 종목 페이지의 '투자의견·목표주가' 섹션 스크래핑
US   : yfinance analyst price target 필드
출력 : data/targets/{ticker}.json  (최고/평균/최저 목표가 + 투자의견)
"""
from __future__ import annotations

import re
import sys

import requests
from bs4 import BeautifulSoup

from common import TARGETS_DIR, krx_holdings, safe, us_holdings, write_json

_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
_NUM = re.compile(r"-?[\d,]+(?:\.\d+)?")


def _to_num(text: str):
    if not text:
        return None
    m = _NUM.search(text.replace("\xa0", " "))
    if not m:
        return None
    try:
        return float(m.group().replace(",", ""))
    except ValueError:
        return None


# ------------------------------------------------------------- KRX (네이버 모바일 API)
_NAVER_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}


def _opinion_text(mean):
    """네이버 recommMean(1~5, 클수록 매수) → 한글 투자의견."""
    if mean is None:
        return None
    if mean >= 4.5:
        return "적극매수"
    if mean >= 3.5:
        return "매수"
    if mean >= 2.5:
        return "중립"
    return "매도"


def _analyst_targets(ticker: str) -> list[dict]:
    """네이버 리서치 리포트 목록의 미리보기 텍스트에서 '목표주가 XX만원' 을 추출.
    증권사별 최신(목표가가 파싱된) 1건만 남긴다 — 근사치."""
    try:
        rows = requests.get(
            f"https://m.stock.naver.com/api/research/stock/{ticker}?page=1&pageSize=30",
            headers=_NAVER_HEADERS, timeout=12,
        ).json()
    except Exception:  # noqa: BLE001
        return []
    by_firm: dict[str, dict] = {}
    for x in rows if isinstance(rows, list) else []:
        firm = (x.get("brokerName") or "").strip()
        if not firm:
            continue
        txt = f"{x.get('title', '')} {x.get('previewContent', '')}"
        tgt = None
        m = re.search(r"목표주가[^0-9]{0,6}([0-9][0-9,\.]*)\s*만", txt)
        if m:
            tgt = int(round(float(m.group(1).replace(",", "")) * 10000))
        else:
            m = re.search(r"목표주가[^0-9]{0,8}([0-9]{2,3},[0-9]{3})\s*원", txt)
            if m:
                tgt = int(m.group(1).replace(",", ""))
        date = x.get("writeDate")
        # 증권사별 첫 등장(=최신) 우선, 단 목표가 파싱된 건이 있으면 그것으로 갱신
        cur = by_firm.get(firm)
        if cur is None:
            by_firm[firm] = {"firm": firm, "target": tgt, "date": date}
        elif cur.get("target") is None and tgt is not None:
            by_firm[firm] = {"firm": firm, "target": tgt, "date": date}
    out = [v for v in by_firm.values()]
    out.sort(key=lambda v: (v["target"] is None, -(v["target"] or 0)))
    return out[:10]


def _naver_target(ticker: str) -> dict:
    url = f"https://m.stock.naver.com/api/stock/{ticker}/integration"
    d = requests.get(url, headers=_NAVER_HEADERS, timeout=10).json()
    c = d.get("consensusInfo") or {}
    avg = _to_num(c.get("priceTargetMean"))
    if not avg:
        return {}
    mean = _to_num(c.get("recommMean"))
    firms = safe(lambda: _analyst_targets(ticker), default=[], label=f"analyst {ticker}") or []
    priced = [f["target"] for f in firms if f.get("target")]
    return {
        "source": "naver(consensus)",
        "url": f"https://m.stock.naver.com/domestic/stock/{ticker}/total",
        "target_avg": avg,
        "target_high": max(priced) if priced else round(avg * 1.15, 2),
        "target_low": min(priced) if priced else round(avg * 0.85, 2),
        "approx_band": not priced,
        "opinion": _opinion_text(mean),
        "opinion_score": mean,
        "as_of": c.get("createDate"),
        "analyst_targets": firms,
        "covering_firms": [f["firm"] for f in firms],
    }


def collect_krx(h: dict) -> None:
    ticker = h["ticker"]
    data = safe(lambda: _naver_target(ticker), default={}, label=f"naver target {ticker}") or {}
    if not data.get("target_avg"):
        print(f"[skip] {ticker}: 목표주가 컨센서스 없음 (ETF 등)")
        return
    data.update(ticker=ticker, name=h.get("name"), market="KRX")
    write_json(TARGETS_DIR / f"{ticker}.json", data)


# ------------------------------------------------------------- US (yfinance)
def _yf_target(ticker: str) -> dict:
    import yfinance as yf

    t = yf.Ticker(ticker)
    info = t.info or {}
    out = {
        "source": "yfinance",
        "target_high": _n(info.get("targetHighPrice")),
        "target_low": _n(info.get("targetLowPrice")),
        "target_avg": _n(info.get("targetMeanPrice")),
        "target_median": _n(info.get("targetMedianPrice")),
        "num_analysts": info.get("numberOfAnalystOpinions"),
        "opinion": info.get("recommendationKey"),
        "opinion_score": _n(info.get("recommendationMean")),
        "current_price": _n(info.get("currentPrice")),
    }
    return {k: v for k, v in out.items() if v is not None}


def collect_us(h: dict) -> None:
    ticker = h["ticker"]
    data = safe(lambda: _yf_target(ticker), default={}, label=f"yf target {ticker}") or {}
    if not data.get("target_avg"):
        print(f"[skip] {ticker}: 목표주가 없음")
        return
    data.update(ticker=ticker, name=h.get("name"), market="US")
    write_json(TARGETS_DIR / f"{ticker}.json", data)


def _n(v):
    try:
        return round(float(v), 4) if v is not None else None
    except (TypeError, ValueError):
        return None


def main() -> int:
    for h in krx_holdings():
        safe(lambda h=h: collect_krx(h), label=f"target_krx {h['ticker']}")
    for h in us_holdings():
        safe(lambda h=h: collect_us(h), label=f"target_us {h['ticker']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
