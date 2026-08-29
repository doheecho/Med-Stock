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


def load_holdings() -> list[dict[str, Any]]:
    """holdings.yaml 파싱. buy_date는 문자열(ISO)로 정규화."""
    with open(ROOT / "holdings.yaml", encoding="utf-8") as f:
        rows = yaml.safe_load(f) or []
    for r in rows:
        r["ticker"] = str(r["ticker"])
        bd = r.get("buy_date")
        if isinstance(bd, (dt.date, dt.datetime)):
            r["buy_date"] = bd.isoformat()[:10]
        elif bd is not None:
            r["buy_date"] = str(bd)
    return rows


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
