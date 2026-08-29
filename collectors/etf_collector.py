"""ETF 구성종목 (상위 10) + 각 구성종목 종가/전일대비.

입력 : holdings.yaml 에서 type: ETF 인 종목
소스 : m.stock.naver.com etfAnalysis (etfTop10MajorConstituentAssets)
       + 국내 구성종목 종가는 FinanceDataReader
출력 : data/etf/{ticker}.json  { name, base_index, as_of, constituents: [...] }
"""
from __future__ import annotations

import re
import sys

import requests

from common import DATA, load_holdings, safe, today_kst, write_json

_H = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}
ETF_DIR = DATA / "etf"


def _pct(s):
    m = re.search(r"-?[\d.]+", str(s or ""))
    return float(m.group()) if m else None


def _fdr_close_prev(code: str):
    import FinanceDataReader as fdr

    df = fdr.DataReader(code)
    c = df["Close"].dropna()
    if len(c) < 2:
        return None, None
    return float(c.iloc[-1]), float(c.iloc[-2])


def _collect(h: dict) -> None:
    ticker = h["ticker"]
    d = requests.get(
        f"https://m.stock.naver.com/api/stock/{ticker}/etfAnalysis", headers=_H, timeout=12
    ).json()
    top = d.get("etfTop10MajorConstituentAssets") or []
    if not top:
        print(f"[skip] {ticker}: 구성종목 없음")
        return

    out = []
    for x in top:
        code = (x.get("itemCode") or "").strip()
        name = (x.get("itemName") or "").strip()
        weight = _pct(x.get("etfWeight"))
        row = {"code": code or None, "name": name, "weight": weight}
        if re.fullmatch(r"\d[0-9A-Z]{5}", code):
            last, prev = safe(lambda c=code: _fdr_close_prev(c), default=(None, None), label=f"etf px {code}")
            if last is not None:
                row["price"] = round(last, 2)
                row["prev"] = round(prev, 2)
                row["change"] = round(last - prev, 2)
                row["change_pct"] = round((last - prev) / prev * 100, 2) if prev else None
        out.append(row)

    write_json(
        ETF_DIR / f"{ticker}.json",
        {
            "ticker": ticker,
            "name": h.get("name") or d.get("itemName"),
            "base_index": d.get("etfBaseIndex"),
            "as_of": today_kst().isoformat(),
            "constituents": out,
        },
    )


def main() -> int:
    ETF_DIR.mkdir(parents=True, exist_ok=True)
    etfs = [h for h in load_holdings() if (h.get("type") or "").upper() == "ETF"]
    for h in etfs:
        safe(lambda h=h: _collect(h), label=f"etf {h['ticker']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
