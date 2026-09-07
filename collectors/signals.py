"""보조지표 종합 신호 엔진 (규칙 기반, 순수 함수).

`indicators.build_price_series()` 가 만든 지표 시계열(ma·bbands·macd·rsi·candles·volume)을
입력받아 "지금 이 종목에 나타나는" 기술적 신호를 규칙으로 판정한다.

- 외부 호출/API 없음. `price_collector` 가 배치에서 `attach()` 로
  `data/prices/{ticker}.json` 에 `"signals"` 블록을 얹고,
  `advisor_collector` 가 그 목록을 Gemini 에 넘겨 종목별 한국어 서술을 만든다.
- 프론트(`dashboard.js`)는 보유목록 밖 종목을 동일 규칙(JS 포팅)으로 계산한다.

신호 1건 = {key, label, dir("bull"|"bear"|"neutral"), strength(1~3), detail, tier, guide}
  tier  : "core" = 종합 점수 반영 / "ref" = 참고용(점수 미반영, 패널에 따로 표시)
  guide : 지표가 무슨 의미인지 설명하는 문장 (패널에서 마우스오버·터치로 펼침)
결과      = {as_of, signals[], score, stance, read, caveats[], n_bull, n_bear, n_ref}
  stance : core 신호만으로 score>=+3 "bull" / score<=-3 "bear" / 그 사이 "mixed" / 없음 "neutral"
"""
from __future__ import annotations

from typing import Any, Optional

_CROSS_MA = 10      # 골든/데드크로스 인정 범위(거래일)
_CROSS_MACD = 5     # MACD 교차 인정 범위
_CROSS_STOCH = 3    # 스토캐스틱 교차 인정 범위
_VOL_SPIKE = 2.0    # 20일 평균 대비 거래량 급증 배수
_SQUEEZE_LB = 60    # 볼린저 밴드폭 최저 판정 구간
_NEAR_52W = 0.03    # 52주 고/저 근접 임계(±3%)

# ── 참고(ref) 지표 파라미터 ─────────────────────────────────────────────
# tier="ref" 신호는 종합 판정(score/stance)에 넣지 않고 패널에 따로 모아 보여준다.
_DISPARITY_HOT = 110   # 이격도 과열
_DISPARITY_COLD = 90   # 이격도 침체
_CCI_HOT = 100         # CCI 과열
_CCI_COLD = -100       # CCI 침체
_STREAK_MIN = 4        # 연속 양/음봉 최소 일수
_DIV_WIN = 40          # 다이버전스 관찰 구간(거래일)
_DIV_PRICE_MARGIN = 0.01   # 다이버전스 가격 고저 최소 차이(1%)
_DIV_RSI_MARGIN = 3.0      # 다이버전스 RSI 최소 차이


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


def _sig(key, label, direction, strength, detail, tier: str = "core") -> dict:
    return {"key": key, "label": label, "dir": direction,
            "strength": int(strength), "detail": detail, "tier": tier}


def _typical(candles) -> list:
    """(고가+저가+종가)/3 — CCI·다이버전스용 대표가격."""
    out = []
    for c in candles:
        if c and None not in (c.get("h"), c.get("l"), c.get("c")):
            out.append((c["h"] + c["l"] + c["c"]) / 3)
        else:
            out.append(None)
    return out


def _hl_extremes(candles, period: int, end: int):
    """candles[end-period+1 .. end] 구간의 (최고 고가, 최저 저가). 부족하면 None."""
    if end + 1 < period:
        return None, None
    hi, lo = -1e18, 1e18
    for j in range(end - period + 1, end + 1):
        c = candles[j]
        if not c or c.get("h") is None or c.get("l") is None:
            return None, None
        hi = max(hi, c["h"])
        lo = min(lo, c["l"])
    return hi, lo


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


# ── 참고 지표(tier="ref") — 종합 점수 미반영 ────────────────────────────
def _rule_ma_cross_short(s, out, cav):
    ma = s.get("ma") or {}
    c = _cross(ma.get("ma5") or [], ma.get("ma20") or [], _CROSS_MA)
    if not c:
        return
    d, ago = c
    when = "오늘" if ago == 0 else f"{ago}거래일 전"
    if d == "up":
        out.append(_sig("ma_cross_s", "단기 골든크로스", "bull", 1,
                        f"MA5가 MA20을 {when} 상향 돌파 — 단기 흐름이 위로.", "ref"))
    else:
        out.append(_sig("ma_cross_s", "단기 데드크로스", "bear", 1,
                        f"MA5가 MA20을 {when} 하향 이탈 — 단기 흐름이 아래로.", "ref"))


def _rule_disparity(s, out, cav):
    ma = s.get("ma") or {}
    _, close = _last_valid(s.get("close") or [])
    _, m20 = _last_valid(ma.get("ma20") or [])
    if None in (close, m20) or not m20:
        return
    disp = close / m20 * 100
    if disp >= _DISPARITY_HOT:
        out.append(_sig("disparity", "이격도 과열", "bear", 1,
                        f"20일 이격도 {disp:.0f} — 종가가 MA20보다 {disp - 100:.0f}% 위. 단기 되돌림 소지.", "ref"))
    elif disp <= _DISPARITY_COLD:
        out.append(_sig("disparity", "이격도 침체", "bull", 1,
                        f"20일 이격도 {disp:.0f} — 종가가 MA20보다 {100 - disp:.0f}% 아래. 단기 반등 소지.", "ref"))


def _rule_cci(s, out, cav):
    candles = s.get("candles") or []
    tp = _typical(candles)
    vals = [v for v in tp if v is not None]
    if len(vals) < 20:
        return
    window = vals[-20:]
    sma = sum(window) / 20
    mad = sum(abs(v - sma) for v in window) / 20
    if mad == 0:
        return
    cci = (window[-1] - sma) / (0.015 * mad)
    if cci >= _CCI_HOT:
        out.append(_sig("cci", "CCI 과열", "bear", 1,
                        f"CCI(20) {cci:+.0f} — +100 위 과열권. 상승 탄력은 강하나 과열 부담.", "ref"))
    elif cci <= _CCI_COLD:
        out.append(_sig("cci", "CCI 침체", "bull", 1,
                        f"CCI(20) {cci:+.0f} — −100 아래 침체권. 낙폭과대 반등 소지.", "ref"))


def _rule_ichimoku(s, out, cav):
    candles = s.get("candles") or []
    n = len(candles)
    if n < 78:  # 26(전환) + 26(선행 이동) + 여유
        return
    last = n - 1
    th, tl = _hl_extremes(candles, 9, last)
    kh, kl = _hl_extremes(candles, 26, last)
    if None in (th, tl, kh, kl):
        return
    tenkan = (th + tl) / 2
    kijun = (kh + kl) / 2
    # 현재가 아래 놓인 구름 = 26거래일 전 데이터로 만든 선행스팬
    base = last - 26
    a_h, a_l = _hl_extremes(candles, 9, base)
    b_h, b_l = _hl_extremes(candles, 26, base)
    bb_h, bb_l = _hl_extremes(candles, 52, base)
    if None in (a_h, a_l, b_h, b_l, bb_h, bb_l):
        return
    span_a = ((a_h + a_l) / 2 + (b_h + b_l) / 2) / 2
    span_b = (bb_h + bb_l) / 2
    cloud_top, cloud_bot = max(span_a, span_b), min(span_a, span_b)
    _, close = _last_valid(s.get("close") or [])
    if close is None:
        return
    if close > cloud_top and tenkan > kijun:
        out.append(_sig("ichimoku", "일목 호전", "bull", 2,
                        "종가가 일목 구름 위 + 전환선 > 기준선 — 추세·모멘텀 모두 상방.", "ref"))
    elif close < cloud_bot and tenkan < kijun:
        out.append(_sig("ichimoku", "일목 악화", "bear", 2,
                        "종가가 일목 구름 아래 + 전환선 < 기준선 — 추세·모멘텀 모두 하방.", "ref"))


def _rule_obv(s, out, cav):
    close = s.get("close") or []
    vol = s.get("volume") or []
    pairs = [(close[i], vol[i]) for i in range(min(len(close), len(vol)))
             if close[i] is not None and vol[i] is not None]
    if len(pairs) < 25:
        return
    obv = [0.0]
    for i in range(1, len(pairs)):
        ch = pairs[i][0] - pairs[i - 1][0]
        obv.append(obv[-1] + (pairs[i][1] if ch > 0 else -pairs[i][1] if ch < 0 else 0.0))
    look = 20
    d_obv = obv[-1] - obv[-1 - look]
    d_px = pairs[-1][0] - pairs[-1 - look][0]
    if d_px < 0 and d_obv > 0:
        out.append(_sig("obv", "OBV 강세 다이버전스", "bull", 2,
                        "주가는 20일 전보다 낮은데 OBV(누적 거래량)는 오름 — 저가 매집 가능성.", "ref"))
    elif d_px > 0 and d_obv < 0:
        out.append(_sig("obv", "OBV 약세 다이버전스", "bear", 2,
                        "주가는 20일 전보다 높은데 OBV는 내림 — 상승에 거래량 뒷받침 부족.", "ref"))
    elif d_px > 0 and d_obv > 0:
        out.append(_sig("obv", "OBV 매집 우위", "bull", 1,
                        "최근 20거래일 OBV 상승 — 거래량이 매수 쪽에 실림.", "ref"))
    elif d_px < 0 and d_obv < 0:
        out.append(_sig("obv", "OBV 분산 우위", "bear", 1,
                        "최근 20거래일 OBV 하락 — 거래량이 매도 쪽에 실림.", "ref"))


def _rule_streak(s, out, cav):
    candles = s.get("candles") or []
    if len(candles) < _STREAK_MIN:
        return
    last = candles[-1]
    if not last or None in (last.get("o"), last.get("c")) or last["o"] == last["c"]:
        return
    up = last["c"] > last["o"]
    run = 0
    for c in reversed(candles):
        if not c or None in (c.get("o"), c.get("c")):
            break
        if (c["c"] > c["o"]) == up and c["c"] != c["o"]:
            run += 1
        else:
            break
    if run < _STREAK_MIN:
        return
    if up:
        out.append(_sig("streak", f"{run}일 연속 양봉", "bull", 1,
                        f"{run}거래일 연속 양봉 — 매수 우위가 이어지는 중(단기 과열 여부는 함께 확인).", "ref"))
    else:
        out.append(_sig("streak", f"{run}일 연속 음봉", "bear", 1,
                        f"{run}거래일 연속 음봉 — 매도 우위가 이어지는 중(낙폭과대 여부는 함께 확인).", "ref"))


def _rule_rsi_divergence(s, out, cav):
    rsi = s.get("rsi") or []
    close = s.get("close") or []
    idx = [i for i in range(min(len(rsi), len(close)))
           if rsi[i] is not None and close[i] is not None]
    if len(idx) < _DIV_WIN:
        return
    win = idx[-_DIV_WIN:]
    half = len(win) // 2
    prior, recent = win[:half], win[half:]

    def _hi(seg):
        return max(seg, key=lambda i: close[i])

    def _lo(seg):
        return min(seg, key=lambda i: close[i])

    ph, rh = _hi(prior), _hi(recent)
    if close[rh] > close[ph] * (1 + _DIV_PRICE_MARGIN) and rsi[rh] < rsi[ph] - _DIV_RSI_MARGIN:
        out.append(_sig("rsi_div", "RSI 약세 다이버전스", "bear", 2,
                        "주가는 고점을 높였지만 RSI 고점은 낮아짐 — 상승 모멘텀 둔화 경고.", "ref"))
        return
    pl, rl = _lo(prior), _lo(recent)
    if close[rl] < close[pl] * (1 - _DIV_PRICE_MARGIN) and rsi[rl] > rsi[pl] + _DIV_RSI_MARGIN:
        out.append(_sig("rsi_div", "RSI 강세 다이버전스", "bull", 2,
                        "주가는 저점을 낮췄지만 RSI 저점은 높아짐 — 하락 모멘텀 둔화 신호.", "ref"))


_RULES = (
    _rule_ma_alignment, _rule_ma_cross, _rule_price_vs_ma, _rule_rsi,
    _rule_macd, _rule_bollinger, _rule_volume, _rule_stochastic, _rule_52w,
    # 참고 지표 (score 미반영)
    _rule_ma_cross_short, _rule_disparity, _rule_cci, _rule_ichimoku,
    _rule_obv, _rule_streak, _rule_rsi_divergence,
)


# ── 신호별 상세 설명 (패널에서 마우스오버/터치로 펼침) ──────────────────
_SIG_GUIDE = {
    "ma_align":
        "이동평균선이 단기>중기>장기 순으로 정렬(정배열)이면 상승 추세, 반대(역배열)면 하락 추세다. "
        "정배열에서는 눌림목이 매수 기회로, 역배열에서는 반등이 매도 기회로 자주 쓰인다. "
        "이평선은 후행 지표라 전환점을 늦게 알려준다.",
    "ma_cross":
        "MA20이 MA60을 위로 뚫으면 골든크로스(중기 추세가 상승으로), 아래로 뚫으면 데드크로스(하락으로)다. "
        "추세장에서는 신뢰도가 높지만 횡보장에서는 자주 뒤집히니 거래량·가격 위치와 함께 본다.",
    "ma_cross_s":
        "MA5가 MA20을 교차하는 단기 신호다. 방향을 빠르게 알려주는 대신 잦게 뒤바뀐다. "
        "핵심 신호(정배열·MA20×60)와 같은 방향일 때 참고 가치가 커진다.",
    "price_ma":
        "종가가 MA20·MA60 위에 있으면 그 기간 매수자가 평균적으로 이익 구간이라 매물 부담이 적다. "
        "아래에 있으면 반대로 매물벽이 위에 쌓여 있다는 뜻이다.",
    "rsi":
        "RSI는 0~100으로 상승·하락 압력의 균형을 본다. 70 위는 과매수(되돌림 확률↑), 30 아래는 과매도(반등 확률↑)지만 "
        "즉시 방향 전환을 뜻하진 않는다. 강한 추세에서는 한쪽에 오래 머문다. 50선 돌파는 모멘텀 전환 신호.",
    "macd":
        "MACD선이 시그널선을 위로 교차하면 매수, 아래로 교차하면 매도 쪽 신호다. "
        "MACD선이 0선 위면 중기 상승 우위, 아래면 하락 우위. 급등락 직후에는 교차가 연달아 나올 수 있다.",
    "bb_edge":
        "종가가 볼린저 상단(+2σ)에 닿으면 단기 과열이거나 강한 추세, 하단(−2σ)에 닿으면 낙폭과대다. "
        "추세가 강하면 밴드를 타고 계속 갈 수 있으니 단독으로 역방향 베팅하지 않는다.",
    "bb_squeeze":
        "밴드 폭이 최근 60거래일 최저라는 것은 변동성이 바짝 수축했다는 뜻이다. "
        "곧 큰 방향성 움직임이 나올 확률이 높다는 '경고'일 뿐, 위아래 방향은 알려주지 않는다(중립).",
    "volume":
        "거래량이 20일 평균의 2배 이상 터지며 주가가 오르면 매수세 유입, 내리면 매도 출회로 본다. "
        "거래량 없는 등락은 신뢰도가 낮다. 지수 편입·배당락·만기 같은 이벤트성 급증은 방향 의미가 약하다.",
    "stoch":
        "스토캐스틱은 최근 14일 고저 범위에서 종가 위치를 본다. %K·%D가 모두 80 위면 과매수, 20 아래면 과매도. "
        "과매도권에서 %K가 %D를 상향 교차하면 반등 신호로 쓴다. RSI보다 민감해 신호가 잦다.",
    "stoch_cross":
        "과매도(또는 과매수) 구간에서 %K와 %D가 교차하는 순간을 잡는 신호다. "
        "짧은 반등·조정을 노리는 단기 관점이며, 추세장에서는 속임수가 많다.",
    "range52w":
        "종가가 52주 최고가에 근접하면 강한 상승 추세(신고가 돌파 시도), 최저가에 근접하면 약세 지속으로 읽는다. "
        "신고가는 매물 부담이 적고, 신저가는 지지선 붕괴 위험이 있다. 단독 판단은 금물.",
    "disparity":
        "이격도는 종가가 MA20에서 몇 % 떨어져 있는지 본다(100 = 이평선과 일치). "
        "110 이상은 단기 과열, 90 이하는 단기 침체로 보고 평균 회귀(이평선으로 되돌림)를 기대하는 지표다. 참고용.",
    "cci":
        "CCI는 대표가격이 평균에서 얼마나 벗어났는지를 본다. +100 위는 과열, −100 아래는 침체권. "
        "추세 진입 초기에는 +100 돌파가 상승 가속 신호로도 쓰이니 방향과 함께 해석한다. 참고용.",
    "ichimoku":
        "일목균형표는 전환선(9)·기준선(26)과 '구름대'로 추세를 한눈에 본다. "
        "종가가 구름 위 + 전환선>기준선이면 상방 정렬, 그 반대면 하방 정렬이다. 구름 안이면 방향 불명확. 참고용.",
    "obv":
        "OBV는 상승일 거래량은 더하고 하락일 거래량은 빼서 누적한 값으로, 돈이 들어오는지 나가는지를 본다. "
        "주가와 OBV가 반대로 움직이면(다이버전스) 추세 힘이 빠지고 있다는 신호다. 참고용.",
    "streak":
        "양봉/음봉이 연속으로 며칠 이어졌는지 본다. 추세가 살아있다는 뜻이면서, 너무 길면 단기 과열·과매도로 "
        "되돌림이 나오기도 한다. 다른 신호와 함께 '지금 추세가 어느 국면인지' 가늠하는 용도. 참고용.",
    "rsi_div":
        "주가 고점은 높아지는데 RSI 고점은 낮아지면(약세 다이버전스) 상승 힘이 빠지는 것, "
        "주가 저점은 낮아지는데 RSI 저점은 높아지면(강세 다이버전스) 하락 힘이 빠지는 것이다. "
        "전환을 미리 암시하지만 타이밍은 늦거나 빗나갈 수 있다. 참고용.",
}


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

    for sg in signals:
        sg.setdefault("tier", "core")
        sg["guide"] = _SIG_GUIDE.get(sg["key"], "")

    # 종합 판정은 핵심(core) 신호만 반영한다. 참고(ref) 신호는 패널에만 노출.
    core = [sg for sg in signals if sg["tier"] == "core"]
    score = sum(sg["strength"] * (1 if sg["dir"] == "bull" else -1 if sg["dir"] == "bear" else 0)
                for sg in core)
    n_bull = sum(1 for sg in core if sg["dir"] == "bull")
    n_bear = sum(1 for sg in core if sg["dir"] == "bear")
    n_ref = len(signals) - len(core)

    if not core:
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
        "n_ref": n_ref,
        "read": read,
        "caveats": caveats,
        "signals": signals,
    }


def attach(series: dict) -> dict:
    """series 에 'signals' 블록을 얹고 그대로 반환 (price_collector 용)."""
    series["signals"] = evaluate(series)
    return series
