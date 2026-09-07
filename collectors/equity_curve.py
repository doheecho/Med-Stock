"""과거 시점별 포트폴리오 총 평가액(누적 자산총액) 곡선.

우선순위
  1) transactions.csv (매수·매도 이력) 가 있으면 → 그걸로 실제 보유수량 추이를 재구성.
     매도·추가매수가 반영된다. 입출금/배당은 반영 안 됨.
  2) 없으면 → holdings.yaml 의 현재 수량을 과거 종가에 소급(가상 백테스트).
     lot/종목에 buy_date 가 있으면 그 시점부터만 반영.

미국 종목은 시점별 USD/KRW(frankfurter) 로 환산. 조회 실패 시 flat fallback.

출력: data/equity_curve.json
  { updated_at, base_ccy:"KRW", assumption:"ledger"|"buy_date"|"current_qty",
    first_full_date, peak:{d,v}, trough_after_peak:{d,v}, last:{d,v,c},
    points:[ {d:"YYYY-MM-DD", v:평가액, c:투입원금(평균단가 기준)}, ... ] }
"""
from __future__ import annotations

import bisect
import csv
import json
import sys

from common import DATA, PRICES_DIR, ROOT, load_holdings, write_json

FX_FALLBACK = 1350.0  # USD→KRW (frankfurter 실패 시)
TX_CSV = ROOT / "transactions.csv"


# ── 공통 헬퍼 ──────────────────────────────────────────────────────────
def _price_map(ticker: str) -> dict[str, float]:
    p = PRICES_DIR / f"{ticker}.json"
    if not p.exists():
        return {}
    doc = json.loads(p.read_text(encoding="utf-8"))
    dates = doc.get("dates") or [c.get("t") for c in doc.get("candles", [])]
    close = doc.get("close") or [c.get("c") for c in doc.get("candles", [])]
    return {d: float(c) for d, c in zip(dates, close) if d and c is not None}


def _fx_series(start: str, end: str) -> dict[str, float]:
    """{날짜: USDKRW}. stdlib(urllib)만 사용 → holdings.yml 에서도 동작."""
    import urllib.request

    urls = [
        f"https://api.frankfurter.dev/v1/{start}..{end}?base=USD&symbols=KRW",
        f"https://api.frankfurter.app/{start}..{end}?from=USD&to=KRW",
    ]
    for u in urls:
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0 (Med-Stock equity_curve)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                rates = json.loads(r.read()).get("rates") or {}
            out = {d: float(v["KRW"]) for d, v in rates.items() if v.get("KRW")}
            if out:
                print(f"[fx] {u} -> {len(out)}건")
                return out
        except Exception as e:  # noqa: BLE001
            print(f"[fx] 실패 {u}: {e!r}")
    print(f"[fx] 전부 실패 -> flat {FX_FALLBACK}")
    return {}


def _ffill_lookup(m: dict[str, float]):
    keys = sorted(m)

    def get(d: str):
        i = bisect.bisect_right(keys, d) - 1
        return m[keys[i]] if i >= 0 else None

    return get


def _norm_date(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    digits = s.replace("-", "").replace(".", "").replace("/", "")
    if len(digits) == 8 and digits.isdigit():
        return f"{digits[:4]}-{digits[4:6]}-{digits[6:]}"
    return s if len(s) == 10 and s[4] == "-" else None


def _norm_action(s: str) -> str | None:
    s = (s or "").strip().lower()
    if s in ("buy", "b", "매수", "매입", "bought"):
        return "buy"
    if s in ("sell", "s", "매도", "매각", "sold"):
        return "sell"
    return None


def _market_of(ticker: str, hint: dict[str, str]) -> str:
    if ticker in hint:
        return hint[ticker]
    return "KRX" if len(ticker) == 6 and ticker[0].isdigit() else "US"


def _norm_ccy(s: str) -> str | None:
    s = (s or "").strip().upper()
    if s in ("KRW", "원", "KOR", "KR", "국내"):
        return "KRX"
    if s in ("USD", "$", "달러", "US", "USA", "해외"):
        return "US"
    return None


# ── 거래 이력(transactions.csv) 로딩 ──────────────────────────────────
def _load_transactions() -> list[dict]:
    if not TX_CSV.exists():
        return []
    rows: list[dict] = []
    lines = [ln for ln in TX_CSV.read_text(encoding="utf-8-sig").splitlines()
             if ln.strip() and not ln.lstrip().startswith("#")]
    if not lines:
        return []
    for i, r in enumerate(csv.DictReader(lines)):
        rl = { (k or "").strip().lower(): (v or "").strip() for k, v in r.items() }
        d = _norm_date(rl.get("date", ""))
        act = _norm_action(rl.get("action", ""))
        tk = rl.get("ticker", "")
        try:
            qty = float(rl.get("quantity") or rl.get("qty") or 0)
            px = float(rl.get("price") or 0)
        except ValueError:
            qty = px = 0.0
        if not (d and act and tk and qty > 0):
            print(f"[tx] {i+2}행 건너뜀: {r}")
            continue
        rows.append({"date": d, "ticker": tk, "action": act, "qty": qty, "price": px,
                     "account": rl.get("account", ""),
                     "ccy": _norm_ccy(rl.get("currency") or rl.get("ccy") or "")})
    if not rows:
        print(f"[tx] {TX_CSV.name}: 데이터 행 없음 -> holdings 백테스트 사용")
        return []
    rows.sort(key=lambda x: (x["date"], x["ticker"]))
    print(f"[tx] {TX_CSV.name}: 유효 {len(rows)}건 ({rows[0]['date']}~{rows[-1]['date']})")
    return rows


def build_from_ledger(txns: list[dict]) -> dict:
    holds = {h["ticker"]: h for h in load_holdings()}
    mkt_hint = {t: h.get("market", "KRX") for t, h in holds.items()}
    # transactions.csv 의 currency 열이 있으면 그 종목 시장을 확정 (holdings.yaml 다음 우선)
    for tx in txns:
        if tx.get("ccy") and tx["ticker"] not in holds:
            mkt_hint[tx["ticker"]] = tx["ccy"]
    tickers = sorted({t["ticker"] for t in txns})

    pmaps, missing = {}, []
    for t in tickers:
        m = _price_map(t)
        if m:
            pmaps[t] = m
        else:
            missing.append(t)
    if missing:
        print(f"[tx] 가격 데이터 없는 종목(평가액서 제외): {missing}")
    if not pmaps:
        print("[tx] 평가 가능한 종목이 없음 -> 백테스트로 폴백")
        return {}

    all_dates = sorted({d for m in pmaps.values() for d in m})
    start = max(txns[0]["date"], all_dates[0])
    axis = [d for d in all_dates if d >= start]
    if not axis:
        return {}
    end = axis[-1]

    fx_raw = _fx_series(start, end)
    fx_get = _ffill_lookup(fx_raw) if fx_raw else (lambda d: None)
    fx_flat = next(iter(fx_raw.values()), FX_FALLBACK) if fx_raw else FX_FALLBACK

    def fx_on(d):
        return (fx_get(d) or fx_flat) or FX_FALLBACK

    pget = {t: _ffill_lookup(m) for t, m in pmaps.items()}
    first_px = {t: min(m) for t, m in pmaps.items()}

    pos: dict[str, float] = {}
    cost: dict[str, float] = {}  # KRW, 평균단가 기준 순투입

    def apply_tx(tx):
        t = tx["ticker"]
        mkt = _market_of(t, mkt_hint)
        rate = fx_on(tx["date"]) if mkt == "US" else 1.0
        q, price = tx["qty"], tx["price"]
        if tx["action"] == "buy":
            pos[t] = pos.get(t, 0.0) + q
            cost[t] = cost.get(t, 0.0) + q * price * rate
        else:  # sell — 평균단가법
            have = pos.get(t, 0.0)
            avg = (cost.get(t, 0.0) / have) if have > 0 else 0.0
            sold = min(q, have)
            pos[t] = have - sold
            cost[t] = max(0.0, cost.get(t, 0.0) - sold * avg)

    ti = 0
    points = []
    for d in axis:
        while ti < len(txns) and txns[ti]["date"] <= d:
            apply_tx(txns[ti])
            ti += 1
        value = 0.0
        for t, q in pos.items():
            if q <= 1e-9 or t not in pget or d < first_px[t]:
                continue
            px = pget[t](d)
            if px is None:
                continue
            mkt = _market_of(t, mkt_hint)
            value += q * px * (fx_on(d) if mkt == "US" else 1.0)
        if value <= 0:
            continue
        points.append({"d": d, "v": round(value), "c": round(sum(cost.values()))})

    # 정합성 경고: 이력 최종 보유수량 vs holdings.yaml
    for t in tickers:
        want = holds.get(t, {}).get("quantity")
        got = round(pos.get(t, 0.0), 4)
        if want is not None and abs(got - float(want)) > 1e-6:
            print(f"[tx][warn] {t} 이력 합계 {got} != holdings.yaml {want}")

    return _finish(points, "ledger", first_full=axis[0]) if points else {}


# ── holdings.yaml 백테스트 (폴백) ────────────────────────────────────
def build_from_holdings() -> dict:
    holdings = load_holdings()
    if not holdings:
        return {}
    pmaps, lots = {}, []
    for h in holdings:
        t = h["ticker"]
        pmaps[t] = _price_map(t)
        for lot in h.get("lots") or [{"buy_price": h["buy_price"], "quantity": h["quantity"],
                                      "buy_date": h.get("buy_date")}]:
            lots.append({"ticker": t, "market": h.get("market", "KRX"),
                         "qty": float(lot["quantity"]), "buy_price": float(lot["buy_price"]),
                         "buy_date": lot.get("buy_date")})
    priced = {t: m for t, m in pmaps.items() if m}
    if not priced:
        return {}
    all_dates = sorted({d for m in priced.values() for d in m})
    first_date = {t: min(m) for t, m in priced.items()}

    cost_krw: dict[str, float] = {}
    for lot in lots:
        c = lot["qty"] * lot["buy_price"] * (FX_FALLBACK if lot["market"] == "US" else 1.0)
        cost_krw[lot["ticker"]] = cost_krw.get(lot["ticker"], 0.0) + c
    total_cost = sum(cost_krw.values()) or 1.0
    curve_start = all_dates[0]
    for d in all_dates:
        if sum(cost_krw.get(t, 0.0) for t in priced if first_date[t] <= d) >= 0.70 * total_cost:
            curve_start = d
            break
    axis = [d for d in all_dates if d >= curve_start]
    start, end = axis[0], axis[-1]

    fx_raw = _fx_series(start, end)
    fx_get = _ffill_lookup(fx_raw) if fx_raw else (lambda d: None)
    fx_flat = next(iter(fx_raw.values()), FX_FALLBACK) if fx_raw else FX_FALLBACK

    def fx_on(d):
        return (fx_get(d) or fx_flat) or FX_FALLBACK

    pget = {t: _ffill_lookup(m) for t, m in priced.items()}
    has_bd = any(lot["buy_date"] for lot in lots)
    first_full = max(first_date[lot["ticker"]] for lot in lots if lot["ticker"] in priced)

    points = []
    for d in axis:
        value = cost = 0.0
        ok = False
        for lot in lots:
            t = lot["ticker"]
            if t not in priced or d < first_date[t]:
                continue
            if lot["buy_date"] and d < lot["buy_date"]:
                continue
            px = pget[t](d)
            if px is None:
                continue
            rate = fx_on(d) if lot["market"] == "US" else 1.0
            value += lot["qty"] * px * rate
            crate = (fx_on(lot["buy_date"]) if (lot["market"] == "US" and lot["buy_date"])
                     else (fx_on(end) if lot["market"] == "US" else 1.0))
            cost += lot["qty"] * lot["buy_price"] * crate
            ok = True
        if ok and value > 0:
            points.append({"d": d, "v": round(value), "c": round(cost)})
    return _finish(points, "buy_date" if has_bd else "current_qty", first_full) if points else {}


def _finish(points: list[dict], assumption: str, first_full: str) -> dict:
    peak = max(points, key=lambda p: p["v"])
    after = [p for p in points if p["d"] >= peak["d"]]
    trough = min(after, key=lambda p: p["v"]) if after else peak
    last = points[-1]
    print(f"[equity] {len(points)}pt {points[0]['d']}~{last['d']} · 전고점 {peak['v']:,}({peak['d']})"
          f" · 현재 {last['v']:,} · 기준={assumption}")
    return {
        "base_ccy": "KRW",
        "assumption": assumption,
        "first_full_date": first_full,
        "peak": {"d": peak["d"], "v": peak["v"]},
        "trough_after_peak": {"d": trough["d"], "v": trough["v"]},
        "last": {"d": last["d"], "v": last["v"], "c": last["c"]},
        "points": points,
    }


def build() -> dict:
    txns = _load_transactions()
    if txns:
        doc = build_from_ledger(txns)
        if doc:
            return doc
        print("[equity] 이력 기반 실패 -> holdings 백테스트")
    return build_from_holdings()


def main() -> int:
    doc = build()
    if doc:
        write_json(DATA / "equity_curve.json", doc)
    else:
        print("[skip] 곡선 생성 실패")
    return 0


if __name__ == "__main__":
    sys.exit(main())
