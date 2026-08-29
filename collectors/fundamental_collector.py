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
def _pykrx_fundamental(ticker: str) -> dict:
    from pykrx import stock

    # 최근 영업일로 소급하며 조회
    import datetime as dt

    for back in range(0, 7):
        day = (today_kst() - dt.timedelta(days=back)).strftime("%Y%m%d")
        df = stock.get_market_fundamental_by_ticker(day, market="ALL")
        if df is not None and ticker in df.index:
            r = df.loc[ticker]
            return {
                "as_of": day,
                "per": _f(r.get("PER")),
                "pbr": _f(r.get("PBR")),
                "eps": _f(r.get("EPS")),
                "bps": _f(r.get("BPS")),
                "div_yield": _f(r.get("DIV")),
                "dps": _f(r.get("DPS")),
            }
    return {}


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
    base = safe(lambda: _pykrx_fundamental(ticker), default={}, label=f"pykrx fnd {ticker}") or {}
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
