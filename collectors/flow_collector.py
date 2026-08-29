"""투자자별 매매동향(외국인/기관/개인 순매수) + 거래량·거래대금.

KRX  : pykrx.stock.get_market_trading_value_by_date (금액 기준)
US   : 해당 지표 없음 → 스킵
출력 : data/flows/{ticker}.json
"""
from __future__ import annotations

import datetime as _dt
import sys

from common import FLOWS_DIR, krx_holdings, safe, today_kst, write_json

_LOOKBACK_DAYS = 90
# pykrx 컬럼명(한글) → 표준 키
_MAP = {
    "외국인합계": "foreign",
    "기관합계": "institution",
    "개인": "individual",
    "기타법인": "etc_corp",
}


def _fetch(ticker: str) -> dict:
    from pykrx import stock

    s = (today_kst() - _dt.timedelta(days=_LOOKBACK_DAYS)).strftime("%Y%m%d")
    e = today_kst().strftime("%Y%m%d")

    val = stock.get_market_trading_value_by_date(s, e, ticker)  # 순매수 금액
    ohlcv = stock.get_market_ohlcv(s, e, ticker)  # 거래량/거래대금

    rows = []
    for d, r in val.iterrows():
        rec = {"t": d.strftime("%Y-%m-%d")}
        for kcol, key in _MAP.items():
            if kcol in r:
                rec[key] = int(r[kcol])
        if d in ohlcv.index:
            o = ohlcv.loc[d]
            rec["volume"] = int(o.get("거래량", 0))
            rec["value"] = int(o.get("거래대금", 0))
        rows.append(rec)

    # 최근 5/20일 누적 순매수(참고용 요약)
    def _cum(key: str, n: int) -> int:
        return int(sum(x.get(key, 0) for x in rows[-n:]))

    summary = {
        "foreign_5d": _cum("foreign", 5),
        "foreign_20d": _cum("foreign", 20),
        "institution_5d": _cum("institution", 5),
        "institution_20d": _cum("institution", 20),
    }
    return {"rows": rows, "summary": summary}


def collect(h: dict) -> None:
    ticker = h["ticker"]
    data = safe(lambda: _fetch(ticker), label=f"flow {ticker}")
    if not data or not data.get("rows"):
        print(f"[skip] {ticker}: 수급 데이터 없음")
        return
    data.update(ticker=ticker, name=h.get("name"), market="KRX")
    write_json(FLOWS_DIR / f"{ticker}.json", data)


def main() -> int:
    for h in krx_holdings():
        safe(lambda h=h: collect(h), label=f"flow_collect {h['ticker']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
