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
import datetime as _dt
import json
import re
import sys

from common import DATA, PRICES_DIR, ROOT, load_holdings, now_iso, write_json

FX_FALLBACK = 1350.0  # USD→KRW (frankfurter 실패 시)
TX_CSV = ROOT / "transactions.csv"


# ── 공통 헬퍼 ──────────────────────────────────────────────────────────
_HIST_CACHE: dict | None = None


def _hist_series() -> dict:
    """data/equity_prices.json 의 종목별 종가 맵 (equity_price_history.py 산출)."""
    global _HIST_CACHE
    if _HIST_CACHE is None:
        p = DATA / "equity_prices.json"
        try:
            _HIST_CACHE = json.loads(p.read_text(encoding="utf-8")).get("series", {})
        except Exception:  # noqa: BLE001
            _HIST_CACHE = {}
    return _HIST_CACHE


def _price_map(ticker: str) -> dict[str, float]:
    """배치 최신(data/prices) 우선, 없으면 히스토리(data/equity_prices) 사용.
    둘 다 있으면 병합(히스토리로 과거를 메우고 배치로 최근을 덮어씀)."""
    out: dict[str, float] = {}
    h = _hist_series().get(ticker)
    if isinstance(h, dict):
        out.update({d: float(c) for d, c in h.items() if c is not None})
    p = PRICES_DIR / f"{ticker}.json"
    if p.exists():
        doc = json.loads(p.read_text(encoding="utf-8"))
        dates = doc.get("dates") or [c.get("t") for c in doc.get("candles", [])]
        close = doc.get("close") or [c.get("c") for c in doc.get("candles", [])]
        out.update({d: float(c) for d, c in zip(dates, close) if d and c is not None})
    return out


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


def _ffill_lookup(m: dict[str, float], max_gap_days: int | None = None):
    """직전 값을 앞으로 채워 넣는 조회(마지막 거래일 종가를 다음날에도 쓰는 식).
    max_gap_days 를 주면, 그보다 오래된 값은 안 씀 — 종목이 상폐·매도완료 등으로
    가격 수집이 끊긴 뒤에도 마지막 시세가 몇 년씩 그대로 이어져서 이미 정리된
    포지션이 계속 평가되는 걸 막는다(FX 환율처럼 계속 이어 써도 되는 값엔 안 씀)."""
    keys = sorted(m)

    def get(d: str):
        i = bisect.bisect_right(keys, d) - 1
        if i < 0:
            return None
        if max_gap_days is not None:
            gap = (_dt.date.fromisoformat(d) - _dt.date.fromisoformat(keys[i])).days
            if gap > max_gap_days:
                return None
        return m[keys[i]]

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
    # 미국 심볼은 ASCII 대문자 1~5자. 한글 종목명이 티커 칸에 온 경우는 KRX 취급.
    if ticker.isascii() and ticker.isalpha() and 1 <= len(ticker) <= 5:
        return "US"
    return "KRX"


def _norm_ccy(s: str) -> str | None:
    s = (s or "").strip().upper()
    if s in ("KRW", "원", "KOR", "KR", "국내"):
        return "KRX"
    if s in ("USD", "$", "달러", "US", "USA", "해외"):
        return "US"
    return None


def _num(s: str) -> float:
    """'63,000' · '1 200' · '95.4' → float. 실패 시 0."""
    try:
        return float(re.sub(r"[,\s'](?=\d)|[,\s']$", "", str(s)))
    except ValueError:
        return 0.0


# 티커 칸에 종목명이 들어온 경우(상폐·비상장)의 코드 매핑. 못 찾으면 이름 그대로 키로 쓴다
# (시세가 없어 곡선엔 안 잡히지만 특정일 보유표에는 수량·매수가가 표시된다).
_TX_ALIAS = {"홈캐스트": "064240", "홈 캐스트": "064240"}

_TX_FIELDS = ["date", "ticker", "action", "quantity", "price", "currency", "account", "note", "account_no"]


def _split_line(ln: str) -> list[str]:
    """줄 단위로 구분자 판별 — 탭이 있으면 탭(엑셀 붙여넣기), 없으면 콤마."""
    if "\t" in ln:
        return [c.strip() for c in ln.replace(",", "").split("\t")]
    return next(csv.reader([ln]))


# ── 거래 이력(transactions.csv) 로딩 ──────────────────────────────────
def _load_transactions() -> list[dict]:
    if not TX_CSV.exists():
        return []
    rows: list[dict] = []
    raw = [ln for ln in TX_CSV.read_text(encoding="utf-8-sig").splitlines()
           if ln.strip() and not ln.lstrip().startswith("#")]
    if not raw:
        return []
    # 첫 줄이 헤더면(첫 칸이 'date') 건너뛴다
    body = raw[1:] if _split_line(raw[0])[:1] == ["date"] else raw
    for i, ln in enumerate(body):
        vals = _split_line(ln)
        r = dict(zip(_TX_FIELDS, vals + [""] * (len(_TX_FIELDS) - len(vals))))
        d = _norm_date(r["date"])
        act = _norm_action(r["action"])
        raw_tk = r["ticker"].strip()
        tk = _TX_ALIAS.get(raw_tk, raw_tk)
        qty = _num(r["quantity"])
        px = _num(r["price"])
        if not (d and act and tk and qty > 0):
            print(f"[tx] {i+2}행 건너뜀: {ln[:80]}")
            continue
        # 표시명: note 우선, 없으면 티커 칸이 한글이면 그걸, 아니면 코드
        nm = r["note"].strip() or (raw_tk if not raw_tk[:1].isascii() or not raw_tk[:1].isdigit() else tk)
        rows.append({"date": d, "ticker": tk, "action": act, "qty": qty, "price": px,
                     "account": r["account"].strip(), "name": nm,
                     "ccy": _norm_ccy(r["currency"]),
                     # 같은 증권사 안에 계좌가 여러 개면 "account"(증권사명)만으론 못 구분됨.
                     # 평단가를 계좌별로 따로 잡아야 하는 종목만 이 칸에 구분값을 채운다(선택 입력).
                     "acc_no": r["account_no"].strip()})
    if not rows:
        print(f"[tx] {TX_CSV.name}: 데이터 행 없음 -> holdings 백테스트 사용")
        return []
    rows.sort(key=lambda x: (x["date"], x["ticker"]))
    print(f"[tx] {TX_CSV.name}: 유효 {len(rows)}건 ({rows[0]['date']}~{rows[-1]['date']})")
    return rows


# 확인된 액면분할·무상감자 이력. ratio = 이후 주식수 / 이전 주식수
# (액면분할 50:1 → ratio=50, 무상감자 10주→1주 → ratio=0.1).
# equity_prices.json/data/prices 의 시세는 최신 주식수 기준으로 이미 보정돼 있는데
# (FinanceDataReader 가 분할·감자 조정 종가를 줌) transactions.csv 는 그 당시 실제
# 체결가·체결수량 그대로라 스케일이 안 맞음 — 그 날짜 이전 거래를 비율만큼 보정해서
# 맞춘다(수량 ×ratio, 단가 ÷ratio → 투입금액 total 은 그대로).
SPLITS: dict[str, list[tuple[str, float]]] = {
    "005930": [("2018-05-04", 50)],    # 삼성전자 — 액면분할 50:1
    "093230": [("2022-03-30", 0.1)],   # 이아이디 — 무상감자 10주→1주(2022-03-14 이사회, 감자비율 90%)
}


def _apply_splits(txns: list[dict]) -> list[dict]:
    """SPLITS 에 등록된 종목의 분할·감자 시점 이전 거래를 최신 주식수 기준으로 정규화."""
    for tx in txns:
        ratio = 1.0
        for eff_date, r in SPLITS.get(tx["ticker"], []):
            if tx["date"] < eff_date:
                ratio *= r
        if ratio != 1.0:
            tx["qty"] *= ratio
            tx["price"] /= ratio
    return txns


def build_from_ledger(txns: list[dict]) -> dict:
    all_txns = list(txns)
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
        print(f"[tx] 시세 없어 제외 {len(missing)}종목 (대부분 2020년 전 청산분): "
              f"{missing[:8]}{' …' if len(missing) > 8 else ''}")
    if not pmaps:
        print("[tx] 평가 가능한 종목이 없음 -> 백테스트로 폴백")
        return {}

    # 시세가 있는 종목만 남긴다 — 없는 종목을 원금에만 넣으면 과거 곡선이 가짜로 눌린다.
    txns = [tx for tx in txns if tx["ticker"] in pmaps]
    if not txns:
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

    # 30일 넘게 새 시세가 없으면(상폐·매도완료로 수집 종료) 그 이후엔 평가에서 뺀다.
    pget = {t: _ffill_lookup(m, max_gap_days=30) for t, m in pmaps.items()}
    first_px = {t: min(m) for t, m in pmaps.items()}

    # (ticker, 계좌구분) 로 따로 추적 — 같은 증권사 안에 계좌가 여러 개면 "account"(증권사명)
    # 만으론 못 나눠서 평단가가 서로 다른 계좌끼리 섞여버림(예: A계좌 6만원대 매수 + B계좌 저가
    # 매수가 하나의 평균으로 뭉개짐). transactions.csv 의 account_no 칸에 구분값을 채운 종목만
    # 계좌별로 분리되고, 안 채우면(대부분) 기존처럼 종목 전체가 한 평균으로 잡힌다.
    pos: dict[tuple[str, str], float] = {}
    cost: dict[tuple[str, str], float] = {}  # KRW, 평균단가 기준 순투입

    last_tx_date: dict[str, str] = {}
    for tx in txns:
        if tx["date"] > last_tx_date.get(tx["ticker"], ""):
            last_tx_date[tx["ticker"]] = tx["date"]

    def apply_tx(tx):
        t = tx["ticker"]
        key = (t, tx.get("acc_no") or "")
        mkt = _market_of(t, mkt_hint)
        rate = fx_on(tx["date"]) if mkt == "US" else 1.0
        q, price = tx["qty"], tx["price"]
        if tx["action"] == "buy":
            pos[key] = pos.get(key, 0.0) + q
            cost[key] = cost.get(key, 0.0) + q * price * rate
        else:  # sell — 평균단가법(계좌 단위). 매도 쪽 계좌 태그가 매수 쪽과 다르거나
               # 비어 있으면(실수·누락) 그 계좌엔 팔 수량이 없어 수량이 그냥 증발해버림
               # — 부족분은 같은 종목의 다른 계좌 버킷에서 채워서 수량이 안 사라지게 한다.
            remaining = q
            have = pos.get(key, 0.0)
            avg = (cost.get(key, 0.0) / have) if have > 0 else 0.0
            sold = min(remaining, have)
            pos[key] = have - sold
            cost[key] = max(0.0, cost.get(key, 0.0) - sold * avg)
            remaining -= sold
            if remaining > 1e-9:
                other_keys = sorted(
                    (k for k in pos if k[0] == t and k != key and pos[k] > 1e-9),
                    key=lambda k: -pos[k],
                )
                for k2 in other_keys:
                    if remaining <= 1e-9:
                        break
                    have2 = pos.get(k2, 0.0)
                    avg2 = (cost.get(k2, 0.0) / have2) if have2 > 0 else 0.0
                    sold2 = min(remaining, have2)
                    pos[k2] = have2 - sold2
                    cost[k2] = max(0.0, cost.get(k2, 0.0) - sold2 * avg2)
                    remaining -= sold2

    ti = 0
    points = []
    for d in axis:
        while ti < len(txns) and txns[ti]["date"] <= d:
            apply_tx(txns[ti])
            ti += 1
        # 평가액은 계좌 구분과 무관하게 종목 전체 보유수량 합산으로 계산
        qty_by_ticker: dict[str, float] = {}
        for (t, _acc), q in pos.items():
            qty_by_ticker[t] = qty_by_ticker.get(t, 0.0) + q
        # 유령보유 필터: 지금 보유 중이거나, 이 날짜 이후에도 그 종목 거래가 더 있어야
        # (나중에 매도 등으로 이어짐) 이 시점에 실제로 들고 있었다고 신뢰할 수 있다.
        # 프론트 eqOpenTable(특정일 보유내역 표) 의 필터와 동일 — 안 맞추면 같은 날짜인데
        # 그래프와 표가 다른 값을 보여줌(같은 날 여러 매도 순서 모호성 등으로 생기는
        # 일시적 잔량 아티팩트가 그래프에만 남는 문제).
        trusted = {t for t in qty_by_ticker if t in holds or last_tx_date.get(t, "") > d}
        value = 0.0
        for t, q in qty_by_ticker.items():
            if t not in trusted or q <= 1e-9 or t not in pget or d < first_px[t]:
                continue
            px = pget[t](d)
            if px is None:
                continue
            mkt = _market_of(t, mkt_hint)
            value += q * px * (fx_on(d) if mkt == "US" else 1.0)
        if value <= 0:
            continue
        cost_total = sum(c for (t, _acc), c in cost.items() if t in trusted)
        points.append({"d": d, "v": round(value), "c": round(cost_total)})

    # 정합성 경고: 이력 최종 보유수량 vs holdings.yaml (계좌 구분과 무관하게 종목 전체 합산)
    final_qty_by_ticker: dict[str, float] = {}
    for (t, _acc), q in pos.items():
        final_qty_by_ticker[t] = final_qty_by_ticker.get(t, 0.0) + q
    for t in tickers:
        want = holds.get(t, {}).get("quantity")
        got = round(final_qty_by_ticker.get(t, 0.0), 4)
        if want is not None and abs(got - float(want)) > 1e-6:
            print(f"[tx][warn] {t} 이력 합계 {got} != holdings.yaml {want}")

    _write_tx_json(all_txns, mkt_hint, fx_raw)
    return _finish(points, "ledger", first_full=axis[0]) if points else {}


def _write_tx_json(txns: list[dict], mkt_hint: dict, fx_raw: dict) -> None:
    """프론트 '특정일 보유내역 표' 용 — 정규화된 거래 + 환율 시계열.
    tx = [일자, 티커, 부호수량, 체결가(현지통화), 미국?(1/0), 계좌구분]
    계좌구분은 equity_curve.py 의 계좌별 평단가 분리와 같은 값을 써야 프론트 리플레이가
    동일한 결과를 낸다(비어있으면 기존처럼 종목 전체가 한 평균으로 잡힘)."""
    names, tx = {}, []
    for r in txns:
        t = r["ticker"]
        is_us = 1 if _market_of(t, mkt_hint) == "US" else 0
        names.setdefault(t, r.get("name") or t)
        q = r["qty"] if r["action"] == "buy" else -r["qty"]
        tx.append([r["date"], t, round(q, 4), round(r["price"], 4), is_us, r.get("acc_no") or ""])
    doc = {
        "updated_at": now_iso(),
        "names": names,
        "fx": {d: round(v, 2) for d, v in sorted(fx_raw.items())},
        "tx": tx,
    }
    (DATA / "equity_tx.json").write_text(
        json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[write] data/equity_tx.json ({len(tx)}건, {len(names)}종목)")


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

    pget = {t: _ffill_lookup(m, max_gap_days=30) for t, m in priced.items()}
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
    txns = _apply_splits(_load_transactions())
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
