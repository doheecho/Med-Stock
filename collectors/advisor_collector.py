"""AI Advisor 코멘트 + 종목별 보조지표 신호 서술 생성 (Gemini API).

환경변수:
  GEMINI_API_KEY  (선택 - 없으면 포트폴리오 코멘트는 건너뛰고, 종목별 신호는
                   규칙 엔진 결과만으로 data/signals/*.json 을 쓴다)
  GEMINI_MODEL    (선택, 미지정 시 gemini-flash-lite-latest → 3.5-flash-lite → flash-latest 순 폴백)

입력: data/snapshot.json, data/indices.json, data/prices/*.json, data/news/*.json
출력:
  data/advisor.json        { updated_at, comment, model, source }   — 포트폴리오 종합
  data/signals/{ticker}.json { as_of, stance, score, read, signals[], narrative, model, source }
                             — 종목별. narrative 는 규칙 신호 목록만 근거로 한 2~3문장 서술.
"""
from __future__ import annotations

import json
import os
import sys

import requests

from common import DATA, SIGNALS_DIR, now_iso, write_json


def _load(path):
    try:
        return json.loads((DATA / path).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def _positions_summary(snap: dict) -> str:
    lines = []
    for p in (snap or {}).get("positions", []):
        cur = p.get("last_close")
        buy = p.get("buy_price")
        pl_pct = p.get("pl_pct_close")
        lines.append(
            f"- {p.get('name')} ({p.get('ticker')}): 평단 {buy}, 종가 {cur}, "
            f"수익률 {pl_pct}%, 수량 {p.get('quantity')}"
            + (f", 컨센 목표 {p.get('target_avg')}" if p.get("target_avg") else "")
        )
    return "\n".join(lines)


def _indices_summary(idx: dict) -> str:
    out = []
    for x in (idx or {}).get("items", []):
        out.append(f"- {x['name']}: {x['price']} ({x.get('change_pct')}%)")
    return "\n".join(out)


def _news_summary(tickers: list[str], per: int = 3) -> str:
    out = []
    for t in tickers:
        d = _load(f"news/{t}.json") or {}
        heads = [n.get("title", "") for n in (d.get("items") or [])[:per]]
        if heads:
            out.append(f"[{t}] " + " / ".join(heads))
    return "\n".join(out)


_PROMPT = """당신은 한국 개인투자자를 돕는 애널리스트다. 아래 포트폴리오와 시장 데이터를 바탕으로
한국어 종합 분석을 작성하라. 6~9문장, 3~4개 문단, 불릿 없이 평서문.

포함할 내용:
1) 보유종목 현황 - 수익/손실 기여가 큰 종목과 그 이유(업황·수급·실적 등 추정)
2) 연관 시장 움직임 - 지수·환율·원자재·금리·반도체 업황 중 포트폴리오와 관련된 흐름
3) 지금 주시해야 할 사항 (이벤트, 지표, 리스크)
4) 향후 대응 방향과 시장 전망 (비중 조절/헤지/관망 등 일반적 관점)

투자 권유가 아닌 참고용 분석임을 마지막에 짧게 명시. 숫자는 데이터 범위 내에서만 사용.

## 포트폴리오(종가 기준)
{positions}

## 주요 지수/환율/원자재/코인
{indices}

## 최근 뉴스 헤드라인
{news}
"""


# 지정 모델 실패 시 순서대로 폴백. -lite 우선(토큰 최소화).
_MODEL_FALLBACKS = ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-flash-latest"]


def _gemini_call(key: str, model: str, prompt: str, max_tokens: int = 700) -> tuple[str | None, int, str]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.9, "maxOutputTokens": max_tokens},
    }
    r = requests.post(
        url, params={"key": key}, json=body,
        headers={"Content-Type": "application/json"}, timeout=60,
    )
    if r.status_code != 200:
        return None, r.status_code, r.text[:400]
    data = r.json()
    cand = (data.get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", [])).strip()
    if not text:
        return None, 200, f"빈 응답 finishReason={cand.get('finishReason')}"
    return text, 200, ""


def build_comment() -> tuple[str | None, str | None]:
    """(comment, used_model) 반환."""
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        print("[skip] GEMINI_API_KEY 없음 - advisor.json 유지")
        return None, None

    snap = _load("snapshot.json") or {}
    idx = _load("indices.json") or {}
    tickers = [p["ticker"] for p in snap.get("positions", [])]
    prompt = _PROMPT.format(
        positions=_positions_summary(snap) or "(데이터 없음)",
        indices=_indices_summary(idx) or "(데이터 없음)",
        news=_news_summary(tickers) or "(데이터 없음)",
    )

    tried = []
    want = os.getenv("GEMINI_MODEL", "").strip()
    for model in ([want] if want else []) + [m for m in _MODEL_FALLBACKS if m != want]:
        print(f"[gemini] model={model} key={key[:6]}… prompt {len(prompt)}자")
        text, code, err = _gemini_call(key, model, prompt)
        if text:
            print(f"[gemini] OK ({model}, {len(text)}자)")
            return text, model
        print(f"[gemini] 실패 {model}: HTTP {code} {err}")
        tried.append(model)
    print(f"[gemini] 모든 모델 실패: {tried} - advisor.json 유지")
    return None, None


_DIR_KO = {"bull": "상승", "bear": "하락", "neutral": "중립"}

_SIGNAL_PROMPT = """당신은 한국 주식 기술적 분석가다. 아래는 규칙 엔진이 '{name}({ticker})' 에서
지금 감지한 보조지표 신호 목록이다. 이 신호들만 근거로 현재 국면을 개인투자자에게
2~3문장 한국어 평서문으로 설명하라.

- 목록에 없는 내용(실적·뉴스·목표주가·거시)은 지어내지 말 것.
- 상승·하락 신호가 섞이면 어느 쪽이 우세한지와 지켜볼 지점을 짚을 것.
- 마지막에 기술적 참고용이라는 점을 한 구절로 덧붙일 것. 불릿 없이.

종합 판정: {read}
현재가(종가): {close}
감지된 신호:
{lines}
"""


def _signal_lines(sg: dict) -> str:
    return "\n".join(
        f"- [{_DIR_KO.get(s['dir'], s['dir'])}/강도{s['strength']}] {s['detail']}"
        for s in sg.get("signals", [])
    )


def _eval_signals(price_doc: dict) -> dict | None:
    """prices/{t}.json 에 signals 블록이 있으면 그대로, 없으면 직접 계산."""
    sg = price_doc.get("signals")
    if sg and sg.get("signals") is not None:
        return sg
    try:
        from signals import evaluate

        return evaluate(price_doc)
    except Exception as e:  # noqa: BLE001
        print(f"[warn] signals.evaluate 실패: {e!r}")
        return None


def build_ticker_signals(key: str | None) -> int:
    """보유 종목마다 data/signals/{ticker}.json 생성.

    규칙 신호는 항상 저장하고, GEMINI_API_KEY 가 있으면 신호 목록만 근거로 한
    2~3문장 서술(narrative)을 함께 넣는다. 한 번 성공한 모델을 이후 종목에 재사용.
    """
    snap = _load("snapshot.json") or {}
    positions = snap.get("positions", [])
    if not positions:
        print("[skip] snapshot.json positions 없음 - signals 생략")
        return 0

    want = os.getenv("GEMINI_MODEL", "").strip()
    models = ([want] if want else []) + [m for m in _MODEL_FALLBACKS if m != want]
    picked = None
    n_written = 0

    for p in positions:
        t = p["ticker"]
        price_doc = _load(f"prices/{t}.json")
        if not price_doc:
            print(f"[skip] {t}: prices json 없음")
            continue
        sg = _eval_signals(price_doc)
        if not sg:
            continue

        narrative, used = None, None
        if key and sg.get("signals"):
            prompt = _SIGNAL_PROMPT.format(
                name=p.get("name"), ticker=t, close=p.get("last_close"),
                read=sg.get("read"), lines=_signal_lines(sg),
            )
            for m in ([picked] if picked else models):
                text, code, err = _gemini_call(key, m, prompt, max_tokens=360)
                if text:
                    narrative, used, picked = text, m, m
                    break
                print(f"[gemini-sig] {t} 실패 {m}: HTTP {code} {err}")

        write_json(
            SIGNALS_DIR / f"{t}.json",
            {
                "ticker": t,
                "name": p.get("name"),
                "as_of": sg.get("as_of"),
                "stance": sg.get("stance"),
                "score": sg.get("score"),
                "read": sg.get("read"),
                "caveats": sg.get("caveats", []),
                "signals": sg.get("signals", []),
                "narrative": narrative,
                "model": used,
                "source": "gemini" if narrative else "rule",
            },
        )
        n_written += 1
        print(f"[write] signals/{t}.json ({sg.get('stance')}, 신호 {len(sg.get('signals', []))}건"
              + (f", 서술 {len(narrative)}자" if narrative else ", 서술 없음") + ")")

    return n_written


def main() -> int:
    key = os.getenv("GEMINI_API_KEY")

    try:
        comment, model = build_comment()
    except Exception as e:  # noqa: BLE001
        print(f"[warn] Gemini 호출 예외: {e!r} - advisor.json 유지")
        comment, model = None, None
    if comment:
        write_json(
            DATA / "advisor.json",
            {
                "updated_at": now_iso(),
                "comment": comment,
                "model": model,
                "source": "gemini",
            },
        )
        print(f"[write] advisor.json ({len(comment)}자, {model})")

    try:
        build_ticker_signals(key)
    except Exception as e:  # noqa: BLE001
        print(f"[warn] 종목별 신호 생성 예외: {e!r} - 기존 signals/*.json 유지")

    return 0


if __name__ == "__main__":
    sys.exit(main())
