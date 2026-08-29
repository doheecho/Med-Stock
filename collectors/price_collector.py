"""일봉 + 이동평균(5/20/60/120) + RSI(14) 수집.

KRX  : FinanceDataReader (실패 시 pykrx 폴백)
US   : yfinance
출력 : data/prices/{ticker}.json
"""
from __future__ import annotations

import sys

import pandas as pd

from common import (
    PRICES_DIR,
    krx_holdings,
    lookback_start,
    safe,
    today_kst,
    us_holdings,
    write_json,
)
from indicators import build_price_series

_COLS = ["open", "high", "low", "close", "volume"]


def _fdr(ticker: str) -> pd.DataFrame:
    import FinanceDataReader as fdr

    df = fdr.DataReader(ticker, lookback_start().isoformat(), today_kst().isoformat())
    df = df.rename(columns=str.lower)[_COLS]
    return df


def _pykrx(ticker: str) -> pd.DataFrame:
    from pykrx import stock

    raw = stock.get_market_ohlcv(
        lookback_start().strftime("%Y%m%d"),
        today_kst().strftime("%Y%m%d"),
        ticker,
    )
    raw = raw.rename(
        columns={"시가": "open", "고가": "high", "저가": "low", "종가": "close", "거래량": "volume"}
    )
    return raw[_COLS]


def _yf(ticker: str) -> pd.DataFrame:
    import yfinance as yf

    df = yf.Ticker(ticker).history(period="2y", auto_adjust=False)
    df = df.rename(columns=str.lower)[_COLS]
    df.index = pd.to_datetime(df.index).tz_localize(None)
    return df


def collect_krx(h: dict) -> None:
    ticker = h["ticker"]
    df = safe(lambda: _fdr(ticker), label=f"fdr {ticker}")
    if df is None or df.empty:
        df = safe(lambda: _pykrx(ticker), label=f"pykrx {ticker}")
    if df is None or df.empty:
        print(f"[skip] {ticker}: 가격 데이터 없음")
        return
    payload = build_price_series(df)
    payload.update(ticker=ticker, name=h.get("name"), market="KRX")
    write_json(PRICES_DIR / f"{ticker}.json", payload)


def collect_us(h: dict) -> None:
    ticker = h["ticker"]
    df = safe(lambda: _yf(ticker), label=f"yfinance {ticker}")
    if df is None or df.empty:
        print(f"[skip] {ticker}: 가격 데이터 없음")
        return
    payload = build_price_series(df)
    payload.update(ticker=ticker, name=h.get("name"), market="US")
    write_json(PRICES_DIR / f"{ticker}.json", payload)


def main() -> int:
    for h in krx_holdings():
        safe(lambda h=h: collect_krx(h), label=f"collect_krx {h['ticker']}")
    for h in us_holdings():
        safe(lambda h=h: collect_us(h), label=f"collect_us {h['ticker']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
