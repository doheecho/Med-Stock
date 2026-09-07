"""보유·거래했던 모든 종목의 '보유 기간' 일별 종가 수집.

transactions.csv 에서 종목별 첫 매수일 ~ 마지막 청산일(계속 보유면 오늘)을 구하고,
그 구간의 일봉 종가만 FinanceDataReader 로 받아 data/equity_prices.json 하나로 모은다.
- 상장폐지 종목도 상장기간 내 데이터는 받아진다(티커만 있으면).
- 보유 기간만 담으므로 파일이 작다.

equity_curve.py 는 data/prices/{t}.json (배치 최신) 다음 순위로 이 파일을 읽어
과거 어느 시점이든 정확한 평가금액을 계산한다.

출력: data/equity_prices.json
  { updated_at, series: { "005930": {"2020-01-02": 55200, ...}, ... },
    windows: { "005930": ["2020-01-02","2026-09-07"], ... },
    missing: [ 티커 ] }
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time

from common import DATA, ROOT, load_holdings, now_iso

FLOOR = "2020-01-01"   # 이보다 이른 구간은 자르기
TODAY = dt.date.today().isoformat()


def _windows() -> dict[str, tuple[str, str]]:
    """종목 -> (첫 활동일, 마지막 활동일). 계속 보유 중이면 오늘."""
    sys.path.insert(0, str(ROOT / "collectors"))
    from equity_curve import _load_transactions

    tx = _load_transactions()
    held_now = {h["ticker"] for h in load_holdings()}
    by: dict[str, list[dict]] = {}
    for t in tx:
        by.setdefault(t["ticker"], []).append(t)

    win: dict[str, tuple[str, str]] = {}
    for tk, rows in by.items():
        rows.sort(key=lambda r: r["date"])
        pos = 0.0
        for r in rows:
            pos += r["qty"] if r["action"] == "buy" else -r["qty"]
        start = max(rows[0]["date"], FLOOR)
        end = TODAY if (pos > 1e-6 or tk in held_now) else rows[-1]["date"]
        if end >= start:
            win[tk] = (start, end)
    # 거래이력엔 없지만 지금 보유 중인 종목(안전망)
    for tk in held_now:
        win.setdefault(tk, (FLOOR, TODAY))
    return win


def _close_series(code: str, start: str, end: str) -> dict[str, float]:
    import FinanceDataReader as fdr

    df = fdr.DataReader(code, start, end)
    if df is None or df.empty:
        return {}
    col = "Close" if "Close" in df.columns else df.columns[0]
    out: dict[str, float] = {}
    for idx, v in df[col].items():
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f == f and f > 0:
            out[idx.strftime("%Y-%m-%d")] = round(f, 4)
    return out


def main() -> int:
    win = _windows()
    tickers = sorted(win)
    print(f"[hist] 대상 {len(tickers)}종목 (보유기간만) · FinanceDataReader")
    series: dict[str, dict] = {}
    missing: list[str] = []
    for i, t in enumerate(tickers, 1):
        s0, e0 = win[t]
        got = {}
        for attempt in (1, 2):
            try:
                got = _close_series(t, s0, e0)
                break
            except Exception as e:  # noqa: BLE001
                if attempt == 2:
                    print(f"  [{i:3}/{len(tickers)}] {t:8} 실패: {e!r}")
                else:
                    time.sleep(1.0)
        if got:
            series[t] = got
            print(f"  [{i:3}/{len(tickers)}] {t:8} {len(got):5}일  {min(got)}~{max(got)}")
        else:
            missing.append(t)
        time.sleep(0.12)

    doc = {
        "updated_at": now_iso(),
        "series": series,
        "windows": {t: list(win[t]) for t in series},
        "missing": missing,
    }
    out = DATA / "equity_prices.json"
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    print(f"[write] {out.relative_to(ROOT)}  ({len(series)}종목, {out.stat().st_size/1024:.0f} KB)")
    if missing:
        print(f"[hist] 시세 못 받은 {len(missing)}종목: {missing}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
