"""증권사 목표주가 컨센서스 / 투자의견.

KRX  : 네이버페이 증권 종목 페이지의 '투자의견·목표주가' 섹션 스크래핑
US   : yfinance analyst price target 필드
출력 : data/targets/{ticker}.json  (최고/평균/최저 목표가 + 투자의견)
"""
from __future__ import annotations

import datetime as _dt
import re
import sys

import requests
from bs4 import BeautifulSoup

from common import TARGETS_DIR, krx_holdings, safe, today_kst, us_holdings, write_json

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


# ------------------------------------------------------------- KRX (네이버 모바일 API)
_NAVER_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}


def _opinion_text(mean):
    """네이버 recommMean(1~5, 클수록 매수) → 한글 투자의견."""
    if mean is None:
        return None
    if mean >= 4.5:
        return "적극매수"
    if mean >= 3.5:
        return "매수"
    if mean >= 2.5:
        return "중립"
    return "매도"


_TGT_WORD = r"(?:목표주가|목표가|목표\s*주가|적정주가|적정\s*주가|적정가치|T\.?P)"


def _parse_target(txt: str):
    """리포트 텍스트에서 목표가 추출. 'XX만원' / 'XXX,XXX원' / '→ 32만원' 등."""
    if not txt:
        return None
    for pat, mul in (
        (_TGT_WORD + r"[^0-9]{0,14}([0-9][0-9,\.]*)\s*만", 10000),
        (_TGT_WORD + r"[^0-9]{0,16}([0-9]{2,3},[0-9]{3})\s*원?", 1),
        (r"([0-9][0-9,\.]*)\s*만\s*원?\s*(?:으로|로)?\s*(?:상향|하향|유지|제시|조정|상승)", 10000),
        (_TGT_WORD + r"[^0-9]{0,10}([0-9]{5,7})\s*원", 1),
        (r"(?:→|->)\s*([0-9][0-9,\.]*)\s*만\s*원?", 10000),
    ):
        m = re.search(pat, txt)
        if m:
            try:
                return int(round(float(m.group(1).replace(",", "")) * mul))
            except ValueError:
                pass
    return None


def _report_content(rid) -> str:
    try:
        d = requests.get(
            f"https://m.stock.naver.com/api/research/company/{rid}",
            headers=_NAVER_HEADERS, timeout=8,
        ).json()
        return (d.get("researchContent") or {}).get("content", "") or ""
    except Exception:  # noqa: BLE001
        return ""


def _last_close(ticker: str):
    from common import PRICES_DIR
    import json

    p = PRICES_DIR / f"{ticker}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8")).get("last_close")
    except Exception:  # noqa: BLE001
        return None


_RECENT_DAYS = 31  # 주가전망: 최근 1개월 내 리포트만


def _analyst_targets(ticker: str) -> list[dict]:
    """네이버 리서치 리포트에서 (증권사, 목표가, 리포트링크) 추출.
    증권사별 '가장 최신 일자에 목표가가 파싱된 1건'만. 최근 1개월 + 현재가의
    0.7~4배 범위만 채택(오래된/이상치 제외). 목표가 내림차순."""
    rows = []
    for pg in (1,):  # 1개월 필터라 1페이지면 충분
        try:
            r = requests.get(
                f"https://m.stock.naver.com/api/research/stock/{ticker}?page={pg}&pageSize=50",
                headers=_NAVER_HEADERS, timeout=12,
            ).json()
            if isinstance(r, list):
                rows.extend(r)
        except Exception:  # noqa: BLE001
            break
    if not rows:
        return []

    cur = _last_close(ticker)
    # 현재가보다 30% 넘게 낮은 목표가는 갱신 안 된 옛 리포트로 보고 제외
    lo = cur * 0.7 if cur else None
    hi = cur * 4 if cur else None
    cutoff = (today_kst() - _dt.timedelta(days=_RECENT_DAYS)).isoformat()

    by_firm: dict[str, dict] = {}
    detail_budget = 6
    for x in rows:                                    # 목록은 최신순
        firm = (x.get("brokerName") or "").strip() or "(미상)"
        if firm in by_firm:
            continue
        date = str(x.get("writeDate") or "")
        if date and date < cutoff:                    # 1개월 넘은 리포트 제외
            continue
        rid = x.get("researchId")
        tgt = _parse_target(f"{x.get('title', '')} {x.get('previewContent', '')}")
        if tgt is None and detail_budget > 0 and rid:
            detail_budget -= 1
            tgt = _parse_target(_report_content(rid))
        if not tgt:
            continue
        if lo and (tgt < lo or tgt > hi):             # 현재가 대비 이상치 제외
            continue
        by_firm[firm] = {
            "firm": None if firm == "(미상)" else firm,
            "target": tgt,
            "date": x.get("writeDate"),
            "url": f"https://finance.naver.com/research/company_read.naver?nid={rid}" if rid else None,
        }
    out = list(by_firm.values())
    out.sort(key=lambda v: -v["target"])
    return out[:12]


# ------------------------------------------------------------- 투자의견 컨센서스 (증권사별)
# 네이버 증권 종목분석(coinfo.naver)의 "제공처별 투자의견/목표주가" 표.
# 실제 소스는 wisereport c1010001.aspx (table#cTB24). Referer 를 finance.naver 로 줘야 나온다.
_WISE_HDR = {
    "제공처": "firm", "최종일자": "date",
    "목표가": "target", "직전목표가": "prev_target",
    "변동률(%)": "chg", "변동율(%)": "chg", "변동률": "chg", "변동율": "chg",
    "투자의견": "opinion", "직전투자의견": "prev_opinion",
}


def _wise_num(s):
    s = re.sub(r"[^0-9.\-]", "", str(s or ""))
    if s in ("", "-", ".", "-.", "--"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _wise_date(s):
    m = re.search(r"(\d{2})[./\-](\d{1,2})[./\-](\d{1,2})", str(s or ""))
    if not m:
        return None
    y, mo, d = (int(x) for x in m.groups())
    return f"20{y:02d}-{mo:02d}-{d:02d}"


def _consensus_rows(ticker: str) -> list[dict]:
    """제공처별 투자의견 컨센서스 — 최근 1개월(최종일자 기준), 날짜 내림차순.
    컬럼: 제공처·최종일자·목표가·직전목표가·변동률(%)·투자의견·직전투자의견."""
    u = f"https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd={ticker}"
    try:
        r = requests.get(
            u,
            headers={**_UA, "Referer": f"https://finance.naver.com/item/coinfo.naver?code={ticker}"},
            timeout=15,
        )
        r.encoding = r.apparent_encoding or "utf-8"
    except Exception:  # noqa: BLE001
        return []

    soup = BeautifulSoup(r.text, "html.parser")
    tbl = soup.find("table", id="cTB24")
    if tbl is None:
        for t in soup.find_all("table"):
            if "직전목표가" in (t.get("summary") or "") or "직전투자의견" in t.get_text():
                tbl = t
                break
    if tbl is None:
        return []

    thead = tbl.find("thead")
    heads = [re.sub(r"\s+", "", th.get_text()) for th in (thead.find_all("th") if thead else [])]
    cols = [_WISE_HDR.get(h) for h in heads]
    if "firm" not in cols or "opinion" not in cols:
        return []

    body = tbl.find("tbody") or tbl
    cutoff = (today_kst() - _dt.timedelta(days=31)).isoformat()
    _clean_op = lambda s: (re.sub(r"\s*(펼치기|접기)\s*$", "", s or "").strip() or None)

    out = []
    for tr in body.find_all("tr"):
        if tr.find("th"):
            continue
        tds = tr.find_all("td")
        if len(tds) < len(cols):
            continue
        rec = {cols[i]: tds[i].get_text(" ", strip=True) for i in range(len(cols)) if cols[i]}
        d = _wise_date(rec.get("date"))
        if not d or d < cutoff:
            continue
        tp, ptp = _wise_num(rec.get("target")), _wise_num(rec.get("prev_target"))
        chg = _wise_num(rec.get("chg"))
        if chg is None and tp and ptp:
            chg = round((tp - ptp) / ptp * 100, 2)
        out.append({
            "firm": (rec.get("firm") or "").strip() or None,
            "date": d,
            "target": int(tp) if tp else None,
            "prev_target": int(ptp) if ptp else None,
            "chg": chg,
            "opinion": _clean_op(rec.get("opinion")),
            "prev_opinion": _clean_op(rec.get("prev_opinion")),
        })
    out.sort(key=lambda x: x["date"], reverse=True)
    return out[:30]


def _yf_krx_targets(ticker: str) -> list[dict]:
    """국내 종목의 야후 파이낸스 애널리스트 목표가(상단/중간/하단). .KS → .KQ 순 시도."""
    try:
        import yfinance as yf
    except Exception:  # noqa: BLE001
        return []
    for suf in (".KS", ".KQ"):
        try:
            info = yf.Ticker(ticker + suf).info or {}
        except Exception:  # noqa: BLE001
            continue
        hi, mid, lo = (
            _n(info.get("targetHighPrice")),
            _n(info.get("targetMeanPrice")),
            _n(info.get("targetLowPrice")),
        )
        if not mid:
            continue
        yurl = f"https://finance.yahoo.com/quote/{ticker}{suf}/analysis"
        return [
            {"firm": name, "target": int(round(v)), "url": yurl, "src": "yahoo"}
            for name, v in (("야후 상단", hi), ("야후 평균", mid), ("야후 하단", lo))
            if v
        ]
    return []


def _naver_target(ticker: str) -> dict:
    url = f"https://m.stock.naver.com/api/stock/{ticker}/integration"
    d = requests.get(url, headers=_NAVER_HEADERS, timeout=10).json()
    c = d.get("consensusInfo") or {}
    avg = _to_num(c.get("priceTargetMean"))
    if not avg:
        return {}
    mean = _to_num(c.get("recommMean"))
    at = safe(lambda: _analyst_targets(ticker), default=[], label=f"analyst {ticker}") or []

    # 야후 파이낸스 애널리스트 목표가(상단/중간/하단)도 병기
    for y in safe(lambda: _yf_krx_targets(ticker), default=[], label=f"yf krx {ticker}") or []:
        if not any(x.get("firm") == y["firm"] for x in at):
            at.append(y)

    # 컨센서스 평균을 항상 한 줄 포함(개별 리포트가 적어도 상/중/하 구성되도록)
    consensus_url = f"https://finance.naver.com/item/coinfo.naver?code={ticker}"
    if avg and not any(abs(x["target"] - avg) < avg * 0.01 for x in at):
        at.append({
            "firm": "컨센서스 평균",
            "target": int(round(avg)),
            "date": c.get("createDate"),
            "url": consensus_url,
        })
    at.sort(key=lambda v: -v["target"])

    # 차트 시나리오 점선용 최고/평균/최저 — 낙관>중립(평균)>비관 이 항상 뚜렷이 벌어지게.
    # (컨센서스 평균 / 야후 병기 항목은 밴드 계산에서 제외 — 국내 리포트 목표가 기준)
    firm_t = [
        x["target"] for x in at
        if x.get("firm") != "컨센서스 평균" and x.get("src") != "yahoo"
    ]
    hi = max(firm_t) if firm_t else None
    lo = min(firm_t) if firm_t else None
    target_high = hi if (hi and hi > avg * 1.03) else round(avg * 1.15)
    target_low = lo if (lo and lo < avg * 0.97) else round(avg * 0.85)

    return {
        "source": "naver(consensus)",
        "url": f"https://m.stock.naver.com/domestic/stock/{ticker}/total",
        "target_avg": avg,
        "target_high": target_high,
        "target_low": target_low,
        "approx_band": not firm_t,
        "opinion": _opinion_text(mean),
        "opinion_score": mean,
        "as_of": c.get("createDate"),
        "analyst_targets": at,  # [{firm, target, date, url}] 내림차순
        "consensus_rows": safe(
            lambda: _consensus_rows(ticker), default=[], label=f"consensus {ticker}"
        ) or [],
    }


def collect_krx(h: dict) -> None:
    ticker = h["ticker"]
    data = safe(lambda: _naver_target(ticker), default={}, label=f"naver target {ticker}") or {}
    if not data.get("target_avg"):
        print(f"[skip] {ticker}: 목표주가 컨센서스 없음 (ETF 등)")
        return
    data.update(ticker=ticker, name=h.get("name"), market="KRX")
    write_json(TARGETS_DIR / f"{ticker}.json", data)


# ------------------------------------------------------------- US (yfinance)
def _yf_target(ticker: str) -> dict:
    import yfinance as yf

    t = yf.Ticker(ticker)
    info = t.info or {}
    hi = _n(info.get("targetHighPrice"))
    lo = _n(info.get("targetLowPrice"))
    avg = _n(info.get("targetMeanPrice"))
    med = _n(info.get("targetMedianPrice"))
    yurl = f"https://finance.yahoo.com/quote/{ticker}/analysis"
    # 개별 애널리스트 목표가는 무료로 안 나오므로 최고/평균/중앙값/최저를 전망치로
    analyst = [
        {"firm": name, "target": v, "url": yurl}
        for name, v in (("최고", hi), ("평균", avg), ("중앙값", med), ("최저", lo))
        if v is not None
    ]
    out = {
        "source": "yfinance",
        "target_high": hi,
        "target_low": lo,
        "target_avg": avg,
        "target_median": med,
        "num_analysts": info.get("numberOfAnalystOpinions"),
        "opinion": info.get("recommendationKey"),
        "opinion_score": _n(info.get("recommendationMean")),
        "current_price": _n(info.get("currentPrice")),
        "analyst_targets": analyst,
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
