"""자산추이 그래프에 겹쳐 그릴 벤치마크 지수(코스피) 일별 종가 이력.

equity_curve.py 의 포트폴리오 곡선과 같은 축(날짜)에서 "코스피에 넣었으면
어땠을까"를 비교하기 위한 데이터. FinanceDataReader 로 KOSPI 지수(KS11)
전체 이력을 받아온다.

출력: data/benchmark.json
  { updated_at, series: { "KOSPI": {"2014-01-02": 1946.34, ...} } }
"""
from __future__ import annotations

import datetime as dt
import json

from common import DATA, ROOT, now_iso

START = "2014-01-01"  # equity_curve 곡선이 잡을 수 있는 가장 이른 시점보다 넉넉히 이르게
TODAY = dt.date.today().isoformat()

# FDR 코드 → 프론트에 노출할 키
INDEXES = {"KS11": "KOSPI"}


def _close_series(code: str) -> dict[str, float]:
    import FinanceDataReader as fdr

    df = fdr.DataReader(code, START, TODAY)
    if df is None or df.empty:
        return {}
    col = "Close" if "Close" in df.columns else df.columns[0]
    out: dict[str, float] = {}
    for idx, v in df[col].items():
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f == f and f > 0:
            out[idx.strftime("%Y-%m-%d")] = round(f, 2)
    return out


def main() -> int:
    series: dict[str, dict] = {}
    for code, key in INDEXES.items():
        try:
            got = _close_series(code)
        except Exception as e:  # noqa: BLE001
            print(f"[bench] {key}({code}) 실패: {e!r}")
            continue
        if got:
            series[key] = got
            print(f"[bench] {key} {len(got)}일  {min(got)}~{max(got)}")
        else:
            print(f"[bench] {key} 데이터 없음")

    doc = {"updated_at": now_iso(), "series": series}
    out = DATA / "benchmark.json"
    out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[write] {out.relative_to(ROOT)}  ({out.stat().st_size/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
