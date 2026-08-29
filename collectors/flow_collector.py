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


def _nnum(s):
    try:
        return float(str(s).replace(",", "").replace("+", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return None


def _naver_flow(ticker: str) -> dict:
    """pykrx 실패 시 폴백. finance.naver.com 외인·기관 매매동향 표(페이지당 20일) 스크래핑.

    표에는 기관/외국인 순매매 '수량' 만 있으므로 개인 = -(기관+외국인) 근사.
    (정확한 개인/기타 4분류는 KRX 원천 필요 — pykrx 복구 시 자동 대체)
    최근 며칠은 m.stock trend API 로 개인 순매수 실측치를 덮어쓴다.
    """
    import requests
    from bs4 import BeautifulSoup

    H = {"User-Agent": "Mozilla/5.0", "Referer": "https://finance.naver.com/"}
    by_date: dict[str, dict] = {}
    for page in (1, 2):  # 약 40영업일
        url = f"https://finance.naver.com/item/frgn.naver?code={ticker}&page={page}"
        html = requests.get(url, headers=H, timeout=10).content.decode("euc-kr", "replace")
        soup = BeautifulSoup(html, "lxml")
        for tr in soup.select("table.type2 tr"):
            tds = [td.get_text(strip=True) for td in tr.select("td")]
            if len(tds) < 9 or "." not in tds[0]:
                continue
            close = _nnum(tds[1])
            inst_q = _nnum(tds[5])
            frgn_q = _nnum(tds[6])
            if close is None:
                continue
            t = tds[0].replace(".", "-")
            inst = int(inst_q * close) if inst_q is not None else None
            frgn = int(frgn_q * close) if frgn_q is not None else None
            indiv = None
            if inst is not None and frgn is not None:
                indiv = -(inst + frgn)
            by_date[t] = {"t": t, "institution": inst, "foreign": frgn, "individual": indiv}

    if not by_date:
        return {}

    # 개인 실측치 덮어쓰기 (최근 ~10영업일)
    try:
        tr = requests.get(
            f"https://m.stock.naver.com/api/stock/{ticker}/trend",
            headers={"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"},
            timeout=10,
        ).json()
        for x in tr:
            bd = str(x.get("bizdate", ""))
            t = f"{bd[:4]}-{bd[4:6]}-{bd[6:8]}" if len(bd) == 8 else bd
            iq = _nnum(x.get("individualPureBuyQuant"))
            cp = _nnum(x.get("closePrice"))
            if t in by_date and iq is not None and cp:
                by_date[t]["individual"] = int(iq * cp)
    except Exception:  # noqa: BLE001
        pass

    rows = [by_date[t] for t in sorted(by_date)]  # 오래된 → 최신
    return {
        "rows": rows,
        "summary": {
            "foreign_20d": int(sum((r.get("foreign") or 0) for r in rows[-20:])),
            "institution_20d": int(sum((r.get("institution") or 0) for r in rows[-20:])),
            "individual_20d": int(sum((r.get("individual") or 0) for r in rows[-20:])),
        },
        "source": "naver(frgn)",
        "note": "기관·외국인 순매매 수량을 종가로 환산한 근사치. 개인은 -(기관+외국인) 근사(최근일은 실측). 기타법인 미제공.",
    }


def collect(h: dict) -> None:
    ticker = h["ticker"]
    data = safe(lambda: _fetch(ticker), label=f"flow {ticker}")
    if not data or not data.get("rows"):
        data = safe(lambda: _naver_flow(ticker), label=f"naver flow {ticker}")
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
