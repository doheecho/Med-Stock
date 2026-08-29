"""공통 유틸: 경로, holdings 로딩, JSON 저장, 날짜 헬퍼."""
from __future__ import annotations

import datetime as dt
import json
import pathlib
from typing import Any

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# data 하위 디렉터리
PRICES_DIR = DATA / "prices"
FUNDAMENTALS_DIR = DATA / "fundamentals"
FLOWS_DIR = DATA / "flows"
TARGETS_DIR = DATA / "targets"
NEWS_DIR = DATA / "news"

for _d in (PRICES_DIR, FUNDAMENTALS_DIR, FLOWS_DIR, TARGETS_DIR, NEWS_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def _norm_date(v: Any) -> Any:
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()[:10]
    return None if v is None else str(v)


def load_holdings() -> list[dict[str, Any]]:
    """holdings.yaml 파싱 → 종목(ticker)당 1행.

    각 행은 계좌별 매수내역 ``lots`` 를 갖는다. buy_price 는 1주당 매수 평단가.
    상위 ``buy_price`` / ``quantity`` 는 계좌 통합값:
        quantity   = Σ lot.quantity
        buy_price  = Σ(lot.buy_price × lot.quantity) / Σ lot.quantity   (통합 평단가)
    구버전(계좌 구분 없이 buy_price/quantity 를 행에 직접 적은 형식)도 그대로 받는다.
    """
    with open(ROOT / "holdings.yaml", encoding="utf-8") as f:
        rows = yaml.safe_load(f) or []

    out: list[dict[str, Any]] = []
    for r in rows:
        ticker = str(r["ticker"])
        raw_lots = r.get("lots")
        if not raw_lots:
            # 구버전 평면 형식 → 단일 lot 으로 감싼다
            raw_lots = [
                {
                    "account": r.get("account", "기본"),
                    "buy_price": r["buy_price"],
                    "quantity": r["quantity"],
                    "buy_date": r.get("buy_date"),
                }
            ]

        lots = []
        tot_qty = 0.0
        tot_amount = 0.0
        lot_dates = []
        for lot in raw_lots:
            qty = float(lot["quantity"])
            price = float(lot["buy_price"])
            bd = _norm_date(lot.get("buy_date"))
            if bd:
                lot_dates.append(bd)
            lots.append(
                {
                    "account": lot.get("account", "기본"),
                    "buy_price": price,
                    "quantity": qty,
                    "buy_date": bd,
                }
            )
            tot_qty += qty
            tot_amount += price * qty

        out.append(
            {
                "ticker": ticker,
                "name": r.get("name"),
                "market": r.get("market", "KRX"),
                "type": (r.get("type") or "").upper() or None,
                "quantity": tot_qty,
                "buy_price": (tot_amount / tot_qty) if tot_qty else 0.0,
                "buy_date": _norm_date(r.get("buy_date")) or (min(lot_dates) if lot_dates else None),
                "lots": lots,
            }
        )
    return out


def load_scenarios() -> dict[str, list[dict[str, Any]]]:
    p = ROOT / "scenarios.yaml"
    if not p.exists():
        return {}
    with open(p, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return {str(k): v for k, v in data.items()}


def krx_holdings() -> list[dict[str, Any]]:
    return [h for h in load_holdings() if h.get("market", "KRX").upper() == "KRX"]


def us_holdings() -> list[dict[str, Any]]:
    return [h for h in load_holdings() if h.get("market", "").upper() == "US"]


def write_json(path: pathlib.Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = _with_meta(payload)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2, default=str)
    print(f"[write] {path.relative_to(ROOT)}")


def _with_meta(payload: Any) -> Any:
    """dict면 갱신 시각 메타를 얹어준다."""
    if isinstance(payload, dict) and "updated_at" not in payload:
        return {"updated_at": now_iso(), **payload}
    return payload


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def today_kst() -> dt.date:
    # Actions 러너는 UTC. KST = UTC+9
    return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=9)).date()


def lookback_start(days: int = 400) -> dt.date:
    return today_kst() - dt.timedelta(days=days)


def safe(fn, default=None, label: str = ""):
    """수집기 하나가 죽어도 파이프라인 전체가 멈추지 않도록 감싼다."""
    try:
        return fn()
    except Exception as e:  # noqa: BLE001
        print(f"[warn] {label or getattr(fn, '__name__', 'call')} failed: {e!r}")
        return default
