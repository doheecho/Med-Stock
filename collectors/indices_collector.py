"""주요 지수 / 환율 / 원자재 / 암호화폐 시세 (전일 종가 기준).

출력: data/indices.json  { updated_at, items: [{key,name,price,prev,change,change_pct,fmt}] }
  fmt: "pt"(지수, 소수2) | "krw"(원, 소수2) | "krw0"(원, 정수) | "usd"(달러, 소수2)

소스: FinanceDataReader 우선, 실패 시 yfinance.
"""
from __future__ import annotations

import sys

from common import DATA, write_json

# (key, 표시명, FDR심볼, yfinance심볼, fmt, scale)
_SPEC = [
    ("KOSPI", "KOSPI", "KS11", "^KS11", "pt", 1),
    ("KOSDAQ", "KOSDAQ", "KQ11", "^KQ11", "pt", 1),
    ("DJI", "다우 산업", "DJI", "^DJI", "pt", 1),
    ("IXIC", "나스닥 종합", "IXIC", "^IXIC", "pt", 1),
    ("SOX", "필라델피아 반도체", None, "^SOX", "pt", 1),
    ("SPX", "S&P 500", "US500", "^GSPC", "pt", 1),
    ("USDKRW", "원/달러", "USD/KRW", "KRW=X", "krw", 1),
    ("EURKRW", "원/유로", "EUR/KRW", "EURKRW=X", "krw", 1),
    ("JPYKRW100", "원/엔100", "JPY/KRW", "JPYKRW=X", "krw", 100),
    ("GOLD", "금 선물", "GC=F", "GC=F", "usd", 1),
    ("SILVER", "은 선물", "SI=F", "SI=F", "usd", 1),
    ("WTI", "WTI 선물", "CL=F", "CL=F", "usd", 1),
    ("BTC", "비트코인", "BTC/KRW", "BTC-KRW", "krw0", 1),
    ("ETH", "이더리움", "ETH/KRW", "ETH-KRW", "krw0", 1),
    ("XRP", "리플", "XRP/KRW", "XRP-KRW", "krw", 1),
]


def _fdr_last_prev(sym: str):
    import FinanceDataReader as fdr

    df = fdr.DataReader(sym)
    c = df["Close"].dropna()
    if len(c) < 2:
        return None
    return float(c.iloc[-1]), float(c.iloc[-2])


def _yf_last_prev(sym: str):
    import yfinance as yf

    fi = yf.Ticker(sym).fast_info
    last = float(fi.last_price)
    prev = float(fi.previous_close)
    if not last or not prev:
        return None
    return last, prev


def collect() -> dict:
    items = []
    for key, name, fdr_sym, yf_sym, fmt, scale in _SPEC:
        lp = None
        if fdr_sym:
            try:
                lp = _fdr_last_prev(fdr_sym)
            except Exception as e:  # noqa: BLE001
                print(f"[warn] fdr {key} {fdr_sym}: {e!r}")
        if lp is None and yf_sym:
            try:
                lp = _yf_last_prev(yf_sym)
            except Exception as e:  # noqa: BLE001
                print(f"[warn] yf {key} {yf_sym}: {e!r}")
        if lp is None:
            print(f"[skip] {key}: 시세 없음")
            continue
        last, prev = lp[0] * scale, lp[1] * scale
        chg = last - prev
        items.append(
            {
                "key": key,
                "name": name,
                "price": round(last, 4),
                "prev": round(prev, 4),
                "change": round(chg, 4),
                "change_pct": round(chg / prev * 100, 2) if prev else None,
                "fmt": fmt,
            }
        )
        print(f"[ok] {key}: {last:.2f} ({chg:+.2f})")
    return {"items": items}


def main() -> int:
    write_json(DATA / "indices.json", collect())
    return 0


if __name__ == "__main__":
    sys.exit(main())
