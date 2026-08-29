"""기본 재무지표 수집.

KRX  : pykrx 기본지표(PER/PBR/DIV/EPS/BPS) + (선택) dart-fss 로 ROE/부채비율 보강
US   : yfinance .info 딕셔너리
출력 : data/fundamentals/{ticker}.json
"""
from __future__ import annotations

import os
import sys

from common import (
    FUNDAMENTALS_DIR,
    krx_holdings,
    safe,
    today_kst,
    us_holdings,
    write_json,
)


# ---------------------------------------------------------------- KRX
_NAVER_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}


def _naver_num(s):
    """'11.53배' '22,292원' '0.65%' '491,875' → float. 실패 시 None."""
    if s is None:
        return None
    t = str(s).replace(",", "")
    for suf in ("배", "원", "%", "주", "P", "pt"):
        t = t.replace(suf, "")
    t = t.strip()
    try:
        return float(t)
    except ValueError:
        return None


def _naver_won(s):
    """'1,502조 4,936억' → 원 단위 float."""
    if s is None:
        return None
    import re

    txt = str(s).replace(",", "").replace(" ", "")
    total = 0.0
    hit = False
    m = re.search(r"([\d.]+)조", txt)
    if m:
        total += float(m.group(1)) * 1e12
        hit = True
    m = re.search(r"([\d.]+)억", txt)
    if m:
        total += float(m.group(1)) * 1e8
        hit = True
    if hit:
        return total
    return _naver_num(s)


def _naver_integration(ticker: str) -> dict:
    import requests

    r = requests.get(
        f"https://m.stock.naver.com/api/stock/{ticker}/integration",
        headers=_NAVER_HEADERS,
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def _naver_fundamental(ticker: str) -> dict:
    d = _naver_integration(ticker)
    ti = {x["code"]: x.get("value") for x in (d.get("totalInfos") or [])}
    if not ti:
        return {}
    out = {
        "as_of": today_kst().isoformat(),
        "per": _naver_num(ti.get("per")),
        "forward_per": _naver_num(ti.get("cnsPer")),
        "pbr": _naver_num(ti.get("pbr")),
        "eps": _naver_num(ti.get("eps")),
        "bps": _naver_num(ti.get("bps")),
        "div_yield": _naver_num(ti.get("dividendYieldRatio")),
        "dps": _naver_num(ti.get("dividend")),
        "market_cap": _naver_won(ti.get("marketValue")),
        "foreign_rate": _naver_num(ti.get("foreignRate")),
        "high_52w": _naver_num(ti.get("highPriceOf52Weeks")),
        "low_52w": _naver_num(ti.get("lowPriceOf52Weeks")),
        "source": "naver",
    }
    return {k: v for k, v in out.items() if v is not None}


def _dart_enrich(ticker: str, corp_name: str | None) -> dict:
    """DART_API_KEY 가 있을 때만 ROE/부채비율 등 보강 시도."""
    key = os.getenv("DART_API_KEY")
    if not key:
        return {}
    import dart_fss as dart

    dart.set_api_key(api_key=key)
    corp_list = dart.get_corp_list()
    corp = None
    if corp_name:
        found = corp_list.find_by_corp_name(corp_name, exactly=True)
        corp = found[0] if found else None
    if corp is None:
        corp = corp_list.find_by_stock_code(ticker)
    if corp is None:
        return {}

    fs = corp.extract_fs(bgn_de=(today_kst().year - 1).__str__() + "0101")
    bs = fs["bs"]  # 재무상태표
    is_ = fs["is"] if "is" in fs else fs.get("cis")

    def _pick(frame, *keywords):
        for kw in keywords:
            hit = frame[frame.iloc[:, 0].astype(str).str.contains(kw, na=False)]
            if not hit.empty:
                return _f(hit.iloc[0, -1])
        return None

    total_assets = _pick(bs, "자산총계")
    total_liab = _pick(bs, "부채총계")
    equity = _pick(bs, "자본총계")
    net_income = _pick(is_, "당기순이익") if is_ is not None else None

    out = {}
    if total_liab and equity:
        out["debt_ratio"] = round(total_liab / equity * 100, 2)
    if net_income and equity:
        out["roe"] = round(net_income / equity * 100, 2)
    if total_assets:
        out["total_assets"] = total_assets
    return out


def collect_krx(h: dict) -> None:
    ticker = h["ticker"]
    base = safe(lambda: _naver_fundamental(ticker), default={}, label=f"naver fnd {ticker}") or {}
    extra = safe(
        lambda: _dart_enrich(ticker, h.get("name")), default={}, label=f"dart {ticker}"
    ) or {}
    if not base and not extra:
        print(f"[skip] {ticker}: 재무지표 없음")
        return
    payload = {"ticker": ticker, "name": h.get("name"), "market": "KRX", **base, **extra}
    write_json(FUNDAMENTALS_DIR / f"{ticker}.json", payload)


# ---------------------------------------------------------------- US
def _yf_info(ticker: str) -> dict:
    import yfinance as yf

    info = yf.Ticker(ticker).info or {}
    return {
        "per": _f(info.get("trailingPE")),
        "forward_per": _f(info.get("forwardPE")),
        "pbr": _f(info.get("priceToBook")),
        "eps": _f(info.get("trailingEps")),
        "roe": _pct(info.get("returnOnEquity")),
        "debt_to_equity": _f(info.get("debtToEquity")),
        "profit_margin": _pct(info.get("profitMargins")),
        "div_yield": _pct(info.get("dividendYield")),
        "market_cap": _f(info.get("marketCap")),
        "beta": _f(info.get("beta")),
    }


def collect_us(h: dict) -> None:
    ticker = h["ticker"]
    data = safe(lambda: _yf_info(ticker), default={}, label=f"yf info {ticker}") or {}
    data = {k: v for k, v in data.items() if v is not None}
    if not data:
        print(f"[skip] {ticker}: 재무지표 없음")
        return
    payload = {"ticker": ticker, "name": h.get("name"), "market": "US", **data}
    write_json(FUNDAMENTALS_DIR / f"{ticker}.json", payload)


def _f(v):
    try:
        if v is None:
            return None
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


def _pct(v):
    f = _f(v)
    return round(f * 100, 2) if f is not None else None


def main() -> int:
    for h in krx_holdings():
        safe(lambda h=h: collect_krx(h), label=f"fnd_krx {h['ticker']}")
    for h in us_holdings():
        safe(lambda h=h: collect_us(h), label=f"fnd_us {h['ticker']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
