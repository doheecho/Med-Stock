"""배치 파이프라인 마지막 단계.

- holdings.yaml / scenarios.yaml → JSON 으로 변환 (프론트가 fetch)
- 종가 기준 포트폴리오 요약(snapshot.json) 생성
  (현재가/평가손익 '실시간' 값은 브라우저가 프록시로 다시 계산하므로 여기서는 종가 기준)
"""
from __future__ import annotations

import json
import sys

from common import (
    DATA,
    PRICES_DIR,
    TARGETS_DIR,
    load_holdings,
    load_scenarios,
    today_kst,
    write_json,
)


def _last_close(ticker: str):
    p = PRICES_DIR / f"{ticker}.json"
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d.get("last_close")
    except Exception:  # noqa: BLE001
        return None


def _targets(ticker: str) -> dict:
    p = TARGETS_DIR / f"{ticker}.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def build_snapshot() -> dict:
    positions = []
    total_cost = 0.0
    total_value = 0.0
    for h in load_holdings():
        ticker = h["ticker"]
        qty = float(h["quantity"])
        buy = float(h["buy_price"])
        close = _last_close(ticker)
        cost = buy * qty
        value = (close * qty) if close is not None else None
        pl = (value - cost) if value is not None else None
        pl_pct = (pl / cost * 100) if pl is not None and cost else None

        total_cost += cost
        if value is not None:
            total_value += value

        # 계좌별 내역 (종가 기준). '실시간' 평가액은 프론트에서 현재가로 재계산.
        lots_out = []
        for lot in h.get("lots", []):
            lq = float(lot["quantity"])
            lb = float(lot["buy_price"])
            lcost = lb * lq
            lvalue = (close * lq) if close is not None else None
            lpl = (lvalue - lcost) if lvalue is not None else None
            lots_out.append(
                {
                    "account": lot.get("account", "기본"),
                    "buy_price": lb,
                    "quantity": lq,
                    "buy_date": lot.get("buy_date"),
                    "cost_basis": round(lcost, 2),
                    "eval_value_close": round(lvalue, 2) if lvalue is not None else None,
                    "pl_close": round(lpl, 2) if lpl is not None else None,
                    "pl_pct_close": round(lpl / lcost * 100, 2) if lpl is not None and lcost else None,
                }
            )

        tg = _targets(ticker)
        positions.append(
            {
                "ticker": ticker,
                "name": h.get("name"),
                "market": h.get("market", "KRX"),
                "buy_price": buy,
                "quantity": qty,
                "buy_date": h.get("buy_date"),
                "lots": lots_out,
                "last_close": close,
                "cost_basis": round(cost, 2),
                "eval_value_close": round(value, 2) if value is not None else None,
                "pl_close": round(pl, 2) if pl is not None else None,
                "pl_pct_close": round(pl_pct, 2) if pl_pct is not None else None,
                "target_avg": tg.get("target_avg"),
                "target_high": tg.get("target_high"),
                "target_low": tg.get("target_low"),
                "opinion": tg.get("opinion"),
            }
        )

    total_pl = total_value - total_cost if total_value else None
    return {
        "as_of": today_kst().isoformat(),
        "basis": "close",  # 종가 기준. 실시간 값은 프론트에서 재계산
        "total_cost": round(total_cost, 2),
        "total_value_close": round(total_value, 2),
        "total_pl_close": round(total_pl, 2) if total_pl is not None else None,
        "total_pl_pct_close": round(total_pl / total_cost * 100, 2)
        if total_pl is not None and total_cost
        else None,
        "positions": positions,
    }


def main() -> int:
    holdings = load_holdings()
    write_json(DATA / "holdings.json", {"holdings": holdings})
    write_json(DATA / "scenarios.json", {"scenarios": load_scenarios()})
    write_json(DATA / "snapshot.json", build_snapshot())
    return 0


if __name__ == "__main__":
    sys.exit(main())
