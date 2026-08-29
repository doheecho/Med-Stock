"""AI Advisor 코멘트 생성 (Gemini API).

환경변수:
  GEMINI_API_KEY  (필수 - 없으면 기존 data/advisor.json 유지하고 종료)
  GEMINI_MODEL    (선택, 미지정 시 gemini-flash-lite-latest → 3.5-flash-lite → flash-latest 순 폴백)

입력: data/snapshot.json, data/indices.json, data/targets/*.json, data/news/*.json
출력: data/advisor.json  { updated_at, comment, model, source }
"""
from __future__ import annotations

import json
import os
import sys

import requests

from common import DATA, now_iso, write_json


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


def _gemini_call(key: str, model: str, prompt: str) -> tuple[str | None, int, str]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.9, "maxOutputTokens": 700},
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


def main() -> int:
    try:
        comment, model = build_comment()
    except Exception as e:  # noqa: BLE001
        print(f"[warn] Gemini 호출 예외: {e!r} - advisor.json 유지")
        return 0
    if not comment:
        return 0
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
