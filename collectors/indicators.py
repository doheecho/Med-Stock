"""RSI / 이동평균 등 공통 기술적 지표 계산.

pandas Series 입력을 기본으로 하고, `ta` 패키지가 있으면 활용하되
없어도 순수 pandas 로 동작하도록 폴백을 둔다.
"""
from __future__ import annotations

import pandas as pd

MA_WINDOWS = (5, 20, 60, 120)
RSI_PERIOD = 14


def moving_averages(close: pd.Series, windows=MA_WINDOWS) -> dict[str, list]:
    out: dict[str, list] = {}
    for w in windows:
        ma = close.rolling(window=w, min_periods=w).mean()
        out[f"ma{w}"] = [_round(v) for v in ma.tolist()]
    return out


def bollinger(close: pd.Series, window: int = 20, mult: float = 2.0) -> dict[str, list]:
    mid = close.rolling(window=window, min_periods=window).mean()
    sd = close.rolling(window=window, min_periods=window).std(ddof=0)
    return {
        "mid": [_round(v) for v in mid.tolist()],
        "upper": [_round(v) for v in (mid + mult * sd).tolist()],
        "lower": [_round(v) for v in (mid - mult * sd).tolist()],
    }


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> dict[str, list]:
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    line = ema_fast - ema_slow
    sig = line.ewm(span=signal, adjust=False).mean()
    return {
        "macd": [_round(v, 3) for v in line.tolist()],
        "signal": [_round(v, 3) for v in sig.tolist()],
        "hist": [_round(v, 3) for v in (line - sig).tolist()],
    }


def rsi(close: pd.Series, period: int = RSI_PERIOD) -> list:
    try:
        from ta.momentum import RSIIndicator

        series = RSIIndicator(close=close, window=period, fillna=False).rsi()
    except Exception:  # noqa: BLE001
        series = _rsi_wilder(close, period)
    return [_round(v, 2) for v in series.tolist()]


def _rsi_wilder(close: pd.Series, period: int) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def build_price_series(df: pd.DataFrame) -> dict:
    """df: index=날짜(DatetimeIndex), columns=[open, high, low, close, volume].

    반환: 대시보드가 바로 쓰는 캔들 + 지표 묶음.
    """
    df = df.sort_index()
    close = df["close"].astype(float)

    dates = [d.strftime("%Y-%m-%d") for d in df.index]
    candles = [
        {
            "t": dates[i],
            "o": _round(df["open"].iloc[i]),
            "h": _round(df["high"].iloc[i]),
            "l": _round(df["low"].iloc[i]),
            "c": _round(df["close"].iloc[i]),
            "v": _int(df["volume"].iloc[i]) if "volume" in df else None,
        }
        for i in range(len(df))
    ]

    volume = (
        [_int(v) for v in df["volume"].tolist()] if "volume" in df else [None] * len(df)
    )
    _valid = close.dropna()

    return {
        "dates": dates,
        "candles": candles,
        "close": [_round(v) for v in close.tolist()],
        "volume": volume,
        "ma": moving_averages(close),
        "bbands": bollinger(close),
        "macd": macd(close),
        "rsi": rsi(close),
        # 마지막 봉이 NaN 인 경우가 있어 유효값 기준으로
        "last_close": _round(_valid.iloc[-1]) if len(_valid) else None,
        "prev_close": _round(_valid.iloc[-2]) if len(_valid) > 1 else None,
        "last_date": dates[-1] if dates else None,
    }


def _round(v, ndigits: int = 4):
    try:
        if v is None or pd.isna(v):
            return None
        f = float(v)
        return round(f, ndigits) if abs(f) < 1000 else round(f, 2)
    except (TypeError, ValueError):
        return None


def _int(v):
    try:
        if v is None or pd.isna(v):
            return None
        return int(v)
    except (TypeError, ValueError):
        return None
