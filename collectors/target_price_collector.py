"""증권사 목표주가 컨센서스 / 투자의견.

KRX  : 네이버페이 증권 종목 페이지의 '투자의견·목표주가' 섹션 스크래핑
US   : yfinance analyst price target 필드
출력 : data/targets/{ticker}.json  (최고/평균/최저 목표가 + 투자의견)
"""
from __future__ import annotations

import re
import sys

import requests
from bs4 import BeautifulSoup

from common import TARGETS_DIR, krx_holdings, safe, us_holdings, write_json

_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
_NUM = re.compile(r"-?[\d,]+(?:\.\d+)?")


def _to_num(text: str):
    if not text:
        return None
    m = _NUM.search(text.replace("\xa0", " "))
    if not m:
        return None
    try:
        return float(m.group().replace(",", ""))
    except ValueError:
        return None


# ------------------------------------------------------------- KRX (네이버)
def _naver_target(ticker: str) -> dict:
    url = f"https://finance.naver.com/item/main.naver?code={ticker}"
    html = requests.get(url, headers=_UA, timeout=10).content.decode("euc-kr", "replace")
    soup = BeautifulSoup(html, "lxml")

    out: dict = {"source": "naver", "url": url}

    # '투자의견 | 목표주가' 표: em.f_up / em.f_down 안에 값이 들어있는 경우가 많음
    for th in soup.select("th"):
        label = th.get_text(strip=True)
        if "목표주가" in label:
            td = th.find_next("td")
            if td:
                out["target_consensus"] = _to_num(td.get_text(" ", strip=True))
        if "투자의견" in label:
            td = th.find_next("td")
            if td:
                txt = td.get_text(" ", strip=True)
                out["opinion"] = txt or None
                out["opinion_score"] = _to_num(txt)

    # 컨센서스 상세(최고/최저)가 있는 페이지 변형 대응: coinfo / cmp 표
    body = soup.get_text(" ", strip=True)
    hi = re.search(r"목표주가\s*최고\s*([\d,]+)", body)
    lo = re.search(r"목표주가\s*최저\s*([\d,]+)", body)
    if hi:
        out["target_high"] = _to_num(hi.group(1))
    if lo:
        out["target_low"] = _to_num(lo.group(1))

    avg = out.get("target_consensus")
    out.setdefault("target_avg", avg)
    if avg and "target_high" not in out:
        out["target_high"] = round(avg * 1.15, 2)   # 상세 미제공 시 근사 밴드
    if avg and "target_low" not in out:
        out["target_low"] = round(avg * 0.85, 2)
    return out


def collect_krx(h: dict) -> None:
    ticker = h["ticker"]
    data = safe(lambda: _naver_target(ticker), default={}, label=f"naver target {ticker}") or {}
    if not data.get("target_avg") and not data.get("target_consensus"):
        print(f"[skip] {ticker}: 목표주가 컨센서스 없음")
        return
    data.update(ticker=ticker, name=h.get("name"), market="KRX")
    write_json(TARGETS_DIR / f"{ticker}.json", data)


# ------------------------------------------------------------- US (yfinance)
def _yf_target(ticker: str) -> dict:
    import yfinance as yf

    t = yf.Ticker(ticker)
    info = t.info or {}
    out = {
        "source": "yfinance",
        "target_high": _n(info.get("targetHighPrice")),
        "target_low": _n(info.get("targetLowPrice")),
        "target_avg": _n(info.get("targetMeanPrice")),
        "target_median": _n(info.get("targetMedianPrice")),
        "num_analysts": info.get("numberOfAnalystOpinions"),
        "opinion": info.get("recommendationKey"),
        "opinion_score": _n(info.get("recommendationMean")),
        "current_price": _n(info.get("currentPrice")),
    }
    return {k: v for k, v in out.items() if v is not None}


def collect_us(h: dict) -> None:
    ticker = h["ticker"]
    data = safe(lambda: _yf_target(ticker), default={}, label=f"yf target {ticker}") or {}
    if not data.get("target_avg"):
        print(f"[skip] {ticker}: 목표주가 없음")
        return
    data.update(ticker=ticker, name=h.get("name"), market="US")
    write_json(TARGETS_DIR / f"{ticker}.json", data)


def _n(v):
    try:
        return round(float(v), 4) if v is not None else None
    except (TypeError, ValueError):
        return None


def main() -> int:
    for h in krx_holdings():
        safe(lambda h=h: collect_krx(h), label=f"target_krx {h['ticker']}")
    for h in us_holdings():
        safe(lambda h=h: collect_us(h), label=f"target_us {h['ticker']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
