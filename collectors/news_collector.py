"""종목별 최근 뉴스 헤드라인 + 링크 + 날짜.

KRX  : 네이버 금융 종목 뉴스탭 (news_news.naver)
US   : yfinance .news  (실패 시 Google News RSS 폴백)
공통 폴백 : 종목명으로 Google News RSS 검색
출력 : data/news/{ticker}.json  (최근 N건)
"""
from __future__ import annotations

import html
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET

import requests
from bs4 import BeautifulSoup

from common import NEWS_DIR, load_holdings, safe, write_json

_UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
_MAX = 15


# --------------------------------------------------------- 네이버 금융 뉴스탭
def _naver_news(ticker: str) -> list[dict]:
    url = (
        "https://finance.naver.com/item/news_news.naver"
        f"?code={ticker}&page=1&sm=title_entity_id.basic&clusterId="
    )
    html_txt = requests.get(url, headers=_UA, timeout=10).content.decode("euc-kr", "replace")
    soup = BeautifulSoup(html_txt, "lxml")
    items: list[dict] = []
    for tr in soup.select("table.type5 tr"):
        a = tr.select_one("td.title a")
        if not a:
            continue
        info = tr.select_one("td.info")
        date = tr.select_one("td.date")
        link = a.get("href", "")
        if link.startswith("/"):
            link = "https://finance.naver.com" + link
        items.append(
            {
                "title": a.get_text(strip=True),
                "url": link,
                "source": info.get_text(strip=True) if info else None,
                "date": date.get_text(strip=True) if date else None,
            }
        )
        if len(items) >= _MAX:
            break
    return items


# --------------------------------------------------------- Google News RSS
def _google_news_rss(query: str, hl: str = "ko", gl: str = "KR") -> list[dict]:
    q = urllib.parse.quote(query)
    url = f"https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={gl}:{hl}"
    xml = requests.get(url, headers=_UA, timeout=10).text
    root = ET.fromstring(xml)
    out: list[dict] = []
    for item in root.iter("item"):
        title = item.findtext("title") or ""
        link = item.findtext("link") or ""
        pub = item.findtext("pubDate") or ""
        src_el = item.find("source")
        out.append(
            {
                "title": html.unescape(re.sub(r"\s+-\s+[^-]+$", "", title)).strip(),
                "url": link,
                "source": src_el.text if src_el is not None else None,
                "date": pub,
            }
        )
        if len(out) >= _MAX:
            break
    return out


# --------------------------------------------------------- yfinance
def _yf_news(ticker: str) -> list[dict]:
    import datetime as dt

    import yfinance as yf

    raw = yf.Ticker(ticker).news or []
    out: list[dict] = []
    for n in raw:
        c = n.get("content", n)
        title = c.get("title")
        link = (
            c.get("canonicalUrl", {}).get("url")
            or c.get("clickThroughUrl", {}).get("url")
            or n.get("link")
        )
        ts = n.get("providerPublishTime")
        date = (
            dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat()
            if ts
            else c.get("pubDate")
        )
        prov = c.get("provider", {})
        if title and link:
            out.append(
                {
                    "title": title,
                    "url": link,
                    "source": prov.get("displayName") if isinstance(prov, dict) else None,
                    "date": date,
                }
            )
        if len(out) >= _MAX:
            break
    return out


def collect(h: dict) -> None:
    ticker = h["ticker"]
    name = h.get("name") or ticker
    market = h.get("market", "KRX").upper()

    items: list[dict] = []
    if market == "KRX":
        items = safe(lambda: _naver_news(ticker), default=[], label=f"naver news {ticker}") or []
        if not items:
            items = safe(
                lambda: _google_news_rss(name), default=[], label=f"gnews {ticker}"
            ) or []
    else:
        items = safe(lambda: _yf_news(ticker), default=[], label=f"yf news {ticker}") or []
        if not items:
            items = safe(
                lambda: _google_news_rss(f"{name} stock", hl="en", gl="US"),
                default=[],
                label=f"gnews {ticker}",
            ) or []

    if not items:
        print(f"[skip] {ticker}: 뉴스 없음")
        return
    write_json(
        NEWS_DIR / f"{ticker}.json",
        {"ticker": ticker, "name": h.get("name"), "market": market, "items": items[:_MAX]},
    )


def main() -> int:
    for h in load_holdings():
        safe(lambda h=h: collect(h), label=f"news {h['ticker']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
