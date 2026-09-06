"""보조지표 종합 신호 엔진 (규칙 기반, 순수 함수).

`indicators.build_price_series()` 가 만든 지표 시계열(ma·bbands·macd·rsi·candles·volume)을
입력받아 "지금 이 종목에 나타나는" 기술적 신호를 규칙으로 판정한다.

- 외부 호출/API 없음. `price_collector` 가 배치에서 `attach()` 로
  `data/prices/{ticker}.json` 에 `"signals"` 블록을 얹고,
  `advisor_collector` 가 그 목록을 Gemini 에 넘겨 종목별 한국어 서술을 만든다.
- 프론트(`dashboard.js`)는 보유목록 밖 종목을 동일 규칙(JS 포팅)으로 계산한다.

신호 1건 = {key, label, dir("bull"|"bear"|"neutral"), strength(1~3), detail}
결과      = {as_of, signals[], score, stance, read, caveats[]}
  stance : score>=+3 "bull" / score<=-3 "bear" / 신호는 있으나 그 사이 "mixed" / 신호 없음 "neutral"
"""
from __future__ import annotations

from typing import Any, Optional

_CROSS_MA = 10      # 골든/데드크로스 인정 범위(거래일)
_CROSS_MACD = 5     # MACD 교차 인정 범위
_CROSS_STOCH = 3    # 스토캐스틱 교차 인정 범위
_VOL_SPIKE = 2.0    # 20일 평균 대비 거래량 급증 배수
_SQUEEZE_LB = 60    # 볼린저 밴드폭 최저 판정 구간
_NEAR_52W = 0.03    # 52주 고/저 근접 임계(±3%)


# ── 저수준 헬퍼 ──────────────────────────────────────────────────────────
def _last_valid(seq) -> tuple[Optional[int], Any]:
    if not seq:
        return None, None
    for i in range(len(seq) - 1, -1, -1):
        if seq[i] is not None:
            return i, seq[i]
    return None, None


def _prev_valid(seq, before: int) -> tuple[Optional[int], Any]:
    for i in range(before - 1, -1, -1):
        if seq[i] is not None:
            return i, seq[i]
    return None, None


def _cross(a, b, within: int) -> Optional[tuple[str, int]]:
    """a 가 b 를 상향/하향 교차했는지. 반환 ("up"|"down", 몇 거래일 전) 또는 None."""
    n = min(len(a), len(b))
    pairs = [(i, a[i] - b[i]) for i in range(n) if a[i] is not None and b[i] is not None]
    if len(pairs) < 2:
        return None
    last_i = pairs[-1][0]
    window = pairs[-(within + 1):]
    for k in range(len(window) - 1, 0, -1):
        d0 = window[k - 1][1]
        d1 = window[k][1]
        if d0 <= 0 < d1:
            return "up", last_i - window[k][0]
        if d0 >= 0 > d1:
            return "down", last_i - window[k][0]
    return None


def _sma_last(seq, window: int) -> Optional[float]:
    vals = [v for v in seq if v is not None]
    if len(vals) < window:
        return None
    return sum(vals[-window:]) / window


def _pct(x) -> str:
    return f"{x:+.1f}%"


def _stochastic(candles, k_period: int = 14, d_period: int = 3):
    """dashboard.js 의 stochFrom() 과 동일: slow %K / %D."""
    n = len(candles)
    k_raw: list[Optional[float]] = [None] * n
    for i in range(k_period - 1, n):
        hi, lo = -1e18, 1e18
        for j in range(i - k_period + 1, i + 1):
            c = candles[j]
            if not c:
                continue
            hi = max(hi, c["h"])
            lo = min(lo, c["l"])
        c = candles[i]
        k_raw[i] = None if hi == lo or not c else (c["c"] - lo) / (hi - lo) * 100

    def _sma(arr, p):
        out: list[Optional[float]] = [None] * len(arr)
        for i in range(len(arr)):
            if i < p - 1:
                continue
            seg = arr[i - p + 1:i + 1]
            if any(v is None for v in seg):
                continue
            out[i] = sum(seg) / p
        return out

    k = _sma(k_raw, d_period)
    return k, _sma(k, d_period)


def _sig(key, label, direction, strength, detail) -> dict:
    return {"key": key, "label": label, "dir": direction,
            "strength": int(strength), "detail": detail}


# ── 규칙들 ──────────────────────────────────────────────────────────────
def _rule_ma_alignment(s, out, cav):
    ma = s.get("ma") or {}
    vals = []
    for w in ("ma5", "ma20", "ma60", "ma120"):
        _, v = _last_valid(ma.get(w) or [])
        vals.append(v)
    m5, m20, m60, m120 = vals
    if None in (m5, m20, m60):
        return
    chain = [m5, m20, m60] + ([m120] if m120 is not None else [])
    label_up = "MA5 > MA20 > MA60" + (" > MA120" if m120 is not None else "")
    if all(chain[i] > chain[i + 1] for i in range(len(chain) - 1)):
        out.append(_sig("ma_align", "정배열", "bull", 3,
                        f"이동평균 정배열 ({label_up}) — 단기·중기·장기선이 상승 순으로 정렬."))
    elif all(chain[i] < chain[i + 1] for i in range(len(chain) - 1)):
        out.append(_sig("ma_align", "역배열", "bear", 3,
                        "이동평균 역배열 — 이평선이 하락 순으로 정렬, 추세적 약세."))


def _rule_ma_cross(s, out, cav):
    ma = s.get("ma") or {}
    c = _cross(ma.get("ma20") or [], ma.get("ma60") or [], _CROSS_MA)
    if not c:
        return
    d, ago = c
    when = "오늘" if ago == 0 else f"{ago}거래일 전"
    if d == "up":
        out.append(_sig("ma_cross", "골든크로스", "bull", 2,
                        f"골든크로스 — MA20이 MA60을 {when} 상향 돌파. 중기 추세 전환 가능."))
    else:
        out.append(_sig("ma_cross", "데드크로스", "bear", 2,
                        f"데드크로스 — MA20이 MA60을 {when} 하향 이탈. 중기 추세 악화."))


def _rule_price_vs_ma(s, out, cav):
    ma = s.get("ma") or {}
    _, close = _last_valid(s.get("close") or [])
    _, m20 = _last_valid(ma.get("ma20") or [])
    _, m60 = _last_valid(ma.get("ma60") or [])
    if None in (close, m20, m60):
        return
    if close > m20 and close > m60:
        out.append(_sig("price_ma", "이평선 위", "bull", 1,
                        "종가가 MA20·MA60 위 — 단기·중기 이평선 위에서 거래 중."))
    elif close < m20 and close < m60:
        out.append(_sig("price_ma", "이평선 아래", "bear", 1,
                        "종가가 MA20·MA60 아래 — 단기·중기 이평선 아래에서 거래 중."))


def _rule_rsi(s, out, cav):
    rsi = s.get("rsi") or []
    i, r = _last_valid(rsi)
    if r is None:
        return
    r = round(r)
    if r >= 70:
        cav.append(f"RSI {r} 과매수")
        out.append(_sig("rsi", "RSI 과매수", "bear", 2,
                        f"RSI(14) {r} — 과매수(70+) 구간. 단기 되돌림 압력."))
        return
    if r <= 30:
        cav.append(f"RSI {r} 과매도")
        out.append(_sig("rsi", "RSI 과매도", "bull", 2,
                        f"RSI(14) {r} — 과매도(30-) 구간. 기술적 반등 가능."))
        return
    _, rprev = _prev_valid(rsi, i)
    if rprev is None:
        return
    if rprev < 50 <= r:
        out.append(_sig("rsi", "RSI 50 상향", "bull", 1, f"RSI(14)가 50선을 상향 돌파({round(rprev)}→{r}) — 모멘텀 개선."))
    elif rprev >= 50 > r:
        out.append(_sig("rsi", "RSI 50 하향", "bear", 1, f"RSI(14)가 50선을 하향 이탈({round(rprev)}→{r}) — 모멘텀 약화."))


def _rule_macd(s, out, cav):
    m = s.get("macd") or {}
    line = m.get("macd") or []
    sigl = m.get("signal") or []
    c = _cross(line, sigl, _CROSS_MACD)
    if c:
        d, ago = c
        when = "오늘" if ago == 0 else f"{ago}거래일 전"
        if d == "up":
            out.append(_sig("macd_cross", "MACD 골든크로스", "bull", 2,
                            f"MACD가 시그널선을 {when} 상향 돌파 — 매수 신호."))
        else:
            out.append(_sig("macd_cross", "MACD 데드크로스", "bear", 2,
                            f"MACD가 시그널선을 {when} 하향 돌파 — 매도 신호."))
    _, ml = _last_valid(line)
    if ml is not None:
        if ml > 0:
            out.append(_sig("macd_zero", "MACD 0선 위", "bull", 1, "MACD가 0선 위 — 중기 상승 모멘텀 우위."))
        elif ml < 0:
            out.append(_sig("macd_zero", "MACD 0선 아래", "bear", 1, "MACD가 0선 아래 — 중기 하락 모멘텀 우위."))


def _rule_bollinger(s, out, cav):
    bb = s.get("bbands") or {}
    up, mid, lo = bb.get("upper") or [], bb.get("mid") or [], bb.get("lower") or []
    _, close = _last_valid(s.get("close") or [])
    _, u = _last_valid(up)
    _, m = _last_valid(mid)
    _, l = _last_valid(lo)
    if None not in (close, u, l):
        if close >= u:
            cav.append("볼린저 상단 접촉")
            out.append(_sig("bb_edge", "볼린저 상단", "bear", 1,
                            "종가가 볼린저 상단(+2σ) 도달 — 단기 과열 또는 강한 추세, 되돌림 주의."))
        elif close <= l:
            cav.append("볼린저 하단 접촉")
            out.append(_sig("bb_edge", "볼린저 하단", "bull", 1,
                            "종가가 볼린저 하단(−2σ) 도달 — 낙폭과대 반등 가능."))
    # 밴드 스퀴즈: (상단-하단)/중심 이 최근 _SQUEEZE_LB 거래일 최저
    width = [
        (up[i] - lo[i]) / mid[i]
        for i in range(min(len(up), len(mid), len(lo)))
        if None not in (up[i], mid[i], lo[i]) and mid[i]
    ]
    if len(width) >= _SQUEEZE_LB and width[-1] <= min(width[-_SQUEEZE_LB:]) + 1e-12:
        cav.append("변동성 수축")
        out.append(_sig("bb_squeeze", "밴드 스퀴즈", "neutral", 2,
                        f"볼린저 밴드 폭이 최근 {_SQUEEZE_LB}거래일 최저 — 변동성 수축, 곧 방향성 확대 가능."))


def _rule_volume(s, out, cav):
    vol = s.get("volume") or []
    close = s.get("close") or []
    _, v = _last_valid(vol)
    avg = _sma_last(vol[:-1] if vol and vol[-1] is not None else vol, 20)
    ci, c = _last_valid(close)
    _, cprev = _prev_valid(close, ci) if ci is not None else (None, None)
    if None in (v, avg, c, cprev) or not avg:
        return
    ratio = v / avg
    if ratio < _VOL_SPIKE:
        return
    if c > cprev:
        out.append(_sig("volume", "거래량 급증(상승)", "bull", 2,
                        f"거래량이 20일 평균의 {ratio:.1f}배로 급증 + 주가 상승 — 매수세 유입."))
    elif c < cprev:
        out.append(_sig("volume", "거래량 급증(하락)", "bear", 2,
                        f"거래량이 20일 평균의 {ratio:.1f}배로 급증 + 주가 하락 — 매도 출회."))


def _rule_stochastic(s, out, cav):
    candles = s.get("candles") or []
    if len(candles) < 20:
        return
    k, d = _stochastic(candles)
    ki, kv = _last_valid(k)
    _, dv = _last_valid(d)
    if None in (kv, dv):
        return
    if kv >= 80 and dv >= 80:
        cav.append("스토캐스틱 과매수")
        out.append(_sig("stoch", "스토캐스틱 과매수", "bear", 1, f"스토캐스틱 %K {kv:.0f}·%D {dv:.0f} — 과매수(80+)."))
    elif kv <= 20 and dv <= 20:
        cav.append("스토캐스틱 과매도")
        out.append(_sig("stoch", "스토캐스틱 과매도", "bull", 1, f"스토캐스틱 %K {kv:.0f}·%D {dv:.0f} — 과매도(20-)."))
    c = _cross(k, d, _CROSS_STOCH)
    if c:
        dirn, ago = c
        _, d_at = _last_valid(d[:ki + 1])
        when = "오늘" if ago == 0 else f"{ago}거래일 전"
        if dirn == "up" and d_at is not None and d_at < 35:
            out.append(_sig("stoch_cross", "스토캐스틱 골든크로스", "bull", 2,
                            f"과매도권에서 %K가 %D를 {when} 상향 돌파 — 반등 신호."))
        elif dirn == "down" and d_at is not None and d_at > 65:
            out.append(_sig("stoch_cross", "스토캐스틱 데드크로스", "bear", 2,
                            f"과매수권에서 %K가 %D를 {when} 하향 돌파 — 조정 신호."))


def _rule_52w(s, out, cav):
    close = [v for v in (s.get("close") or []) if v is not None]
    if len(close) < 60:
        return
    win = close[-252:]
    c = close[-1]
    hi, lo = max(win), min(win)
    if hi and c >= hi * (1 - _NEAR_52W):
        out.append(_sig("range52w", "52주 고가권", "bull", 1,
                        f"52주 최고가의 {_pct((c / hi - 1) * 100)} 이내 — 신고가 근접, 강한 상승 추세."))
    elif lo and c <= lo * (1 + _NEAR_52W):
        out.append(_sig("range52w", "52주 저가권", "bear", 1,
                        f"52주 최저가의 {_pct((c / lo - 1) * 100)} 이내 — 신저가 근접, 약세 지속."))


_RULES = (
    _rule_ma_alignment, _rule_ma_cross, _rule_price_vs_ma, _rule_rsi,
    _rule_macd, _rule_bollinger, _rule_volume, _rule_stochastic, _rule_52w,
)


# ── 집계 ────────────────────────────────────────────────────────────────
def evaluate(series: dict) -> dict:
    """indicators.build_price_series() 형태의 dict → 종합 신호 판정."""
    signals: list[dict] = []
    caveats: list[str] = []
    for rule in _RULES:
        try:
            rule(series, signals, caveats)
        except Exception as e:  # noqa: BLE001 — 규칙 하나가 죽어도 나머지는 낸다
            print(f"[warn] signal rule {rule.__name__} 실패: {e!r}")

    score = sum(sg["strength"] * (1 if sg["dir"] == "bull" else -1 if sg["dir"] == "bear" else 0)
                for sg in signals)
    n_bull = sum(1 for sg in signals if sg["dir"] == "bull")
    n_bear = sum(1 for sg in signals if sg["dir"] == "bear")

    if not signals:
        stance, base = "neutral", "뚜렷한 기술적 신호 없음"
    elif score >= 3:
        stance, base = "bull", "상승 신호 우위"
    elif score <= -3:
        stance, base = "bear", "하락 신호 우위"
    else:
        stance, base = "mixed", "신호 혼조 (방향성 불명확)"
    read = base + (f" · {caveats[0]}" if caveats else "")

    return {
        "as_of": series.get("last_date") or (series.get("dates") or [None])[-1],
        "stance": stance,
        "score": score,
        "n_bull": n_bull,
        "n_bear": n_bear,
        "read": read,
        "caveats": caveats,
        "signals": signals,
    }


def attach(series: dict) -> dict:
    """series 에 'signals' 블록을 얹고 그대로 반환 (price_collector 용)."""
    series["signals"] = evaluate(series)
    return series
