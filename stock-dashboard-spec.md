# 개인 주식 포트폴리오 대시보드 — 구현 스펙

## 목표

보유 종목(국내주식 중심 + 미국 Micron 1종목)의 매수가/수량/현재가/평가손익을 한눈에 보고, 기본 재무지표·수급(외인/기관)·거래량·RSI·이동평균선·증권사 목표주가 컨센서스·주요 뉴스를 함께 보여주는 개인용 대시보드. 정적 사이트 + GitHub Actions 배치 파이프라인을 기본으로 하되, 현재가/평가손익만 페이지 조회 시점에 실시간에 가깝게 갱신한다(방법 B). 공개 리포지토리로 운영해도 무방.

## 전체 구조

```
[holdings.yaml] ──┐
                   ├─▶ [collectors (Python)] ─▶ [/data/*.json] ─▶ [정적 대시보드]
[GitHub Actions   ─┘        (매일 1회, 종가 후)                        │
 스케줄러]                                                              │
                                                          [페이지 로드 시]
                                                                │
                                                    [CORS 프록시 (Cloudflare Worker)]
                                                                │
                                                        [현재가 실시간 조회]
```

핵심 원칙: 외인/기관 수급, 재무지표, RSI, 이동평균, 뉴스는 어차피 종가 확정 이후에나 의미 있는 데이터이므로 GitHub Actions 배치(하루 1회)로 충분하다. 오직 "현재가 → 평가손익" 이 두 값만 조회 시점 실시간성이 의미가 있으므로, 이 부분만 별도의 클라이언트 사이드 fetch + 프록시로 처리한다.

## 리포지토리 구조

```
stock-dashboard/
├── holdings.yaml                   # 매수가/수량/매수일
├── scenarios.yaml                  # (선택) 종목별 커스텀 목표가 시나리오
├── data/
│   ├── prices/{ticker}.json        # 일봉 + 이동평균(5/20/60/120) + RSI
│   ├── fundamentals/{ticker}.json  # PER, PBR, ROE, 부채비율 등
│   ├── flows/{ticker}.json         # 외인/기관/개인 순매수, 거래량·거래대금
│   ├── targets/{ticker}.json       # 증권사 목표주가 컨센서스(최고/평균/최저), 투자의견
│   ├── news/{ticker}.json          # 종목별 최근 뉴스 헤드라인+링크
│   └── snapshot.json               # 포트폴리오 요약(매수가/수량 기준 평가손익)
├── collectors/
│   ├── price_collector.py          # pykrx/FinanceDataReader(KRX), yfinance(MU)
│   ├── flow_collector.py           # pykrx 투자자별 매매동향
│   ├── fundamental_collector.py    # pykrx 기본지표 + dart-fss 보강
│   ├── target_price_collector.py   # 네이버금융 목표주가/투자의견 스크래핑
│   ├── news_collector.py           # 네이버금융 뉴스탭 or RSS
│   └── indicators.py               # RSI, 이동평균 등 공통 계산 로직
├── proxy/
│   └── worker.js                   # Cloudflare Worker: 실시간 시세 CORS 프록시
├── site/
│   ├── index.html
│   ├── dashboard.js                 # JSON 로드 + 차트 렌더 + 실시간 현재가 fetch
│   └── style.css
└── .github/workflows/update.yml     # 배치 파이프라인 cron
```

## holdings.yaml 포맷

```yaml
- ticker: "005930"
  name: "삼성전자"
  market: KRX
  buy_price: 68000
  quantity: 30
  buy_date: 2025-11-03
- ticker: "MU"
  name: "Micron Technology"
  market: US
  buy_price: 95.2
  quantity: 10
  buy_date: 2025-08-15
```

## scenarios.yaml 포맷 (선택, 커스텀 목표가)

```yaml
"005930":
  - label: "내 목표가(상승)"
    target_price: 95000
    horizon_months: 6
  - label: "내 목표가(보수적)"
    target_price: 75000
    horizon_months: 6
```

## 데이터 수집기 (collectors)

- `price_collector.py`: KRX 종목은 `pykrx`/`FinanceDataReader`, MU는 `yfinance`로 일봉 수집. `indicators.py`로 RSI(14일 기준), 이동평균(5/20/60/120일) 계산 후 `data/prices/{ticker}.json`에 저장.
- `flow_collector.py`: `pykrx.stock.get_market_trading_value_by_date` 등으로 외국인/기관/개인 순매수 금액, 거래량·거래대금 저장. (MU는 해당 지표 없음 — 스킵 처리)
- `fundamental_collector.py`: `pykrx`의 PER/PBR/배당수익률 + 필요 시 `dart-fss`(DART Open API 래퍼)로 ROE/부채비율 등 보강. MU는 `yfinance`의 `info` 딕셔너리 활용.
- `target_price_collector.py`: 네이버페이 증권 종목 페이지의 투자의견/목표주가 섹션 스크래핑 → 최고/평균/최저 목표가, 컨센서스 투자의견 저장. MU는 `yfinance`의 analyst target price 필드 사용.
- `news_collector.py`: 네이버 금융 종목 뉴스탭 스크래핑 또는 언론사 RSS를 종목명으로 필터링 → 헤드라인+링크+날짜 최근 N건 저장.

## GitHub Actions (`update.yml`)

```yaml
name: Update dashboard data
on:
  schedule:
    - cron: "30 7 * * 1-5"   # KST 16:30 (장마감 후), 평일만 — UTC 기준
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install -r requirements.txt
      - run: python collectors/price_collector.py
      - run: python collectors/flow_collector.py
      - run: python collectors/fundamental_collector.py
      - run: python collectors/target_price_collector.py
      - run: python collectors/news_collector.py
      - run: |
          git config user.name "github-actions"
          git config user.email "actions@github.com"
          git add data/
          git commit -m "chore: update dashboard data" || echo "no changes"
          git push
```

공개 리포지토리는 GitHub Actions 무료 사용량이 사실상 무제한이므로, 필요하면 장중 배치 주기를 늘려도 무방하지만 위에서 설명한 이유로 하루 1회로 충분함.

## 실시간 현재가 — 방법 B (Cloudflare Worker 프록시)

네이버금융/야후파이낸스 등 무료 시세 소스는 브라우저에서 직접 fetch 시 CORS에 막히는 경우가 대부분이라, 서버 사이드에서 시세를 받아와 CORS 헤더만 붙여 돌려주는 경량 프록시가 필요함. Cloudflare Workers 무료 티어(하루 10만 요청)로 충분.

```js
// proxy/worker.js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const ticker = url.searchParams.get("ticker");
    if (!ticker) return new Response("ticker required", { status: 400 });

    // 국내: 네이버 polling API / 해외(MU): 별도 분기
    const upstream = ticker.match(/^\d+$/)
      ? `https://polling.finance.naver.com/api/realtime/domestic/stock/${ticker}`
      : `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`;

    const res = await fetch(upstream, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const body = await res.text();

    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
```

프론트엔드(`dashboard.js`)는 페이지 로드 시 각 보유 종목에 대해 이 프록시를 호출해서 현재가를 받아오고, `holdings.yaml`(빌드 시 JSON으로 변환된 것)의 매수가/수량과 즉시 계산해 평가손익을 표시. 나머지 지표(RSI, 수급 등)는 `data/*.json`에서 그대로 로드.

## 시나리오별 전망치 점선 오버레이

증권사 목표주가 컨센서스(`data/targets/{ticker}.json`)를 그대로 시나리오 앵커로 사용:

- 낙관: 최고 목표가
- 중립: 평균 목표가(컨센서스)
- 비관: 최저 목표가

각 시나리오는 "오늘 좌표 → 목표 시점(기본 12개월 후) 좌표" 2점짜리 데이터셋으로, Chart.js 기준 `borderDash: [5, 5]` 옵션으로 점선 렌더링. `scenarios.yaml`에 사용자 정의 시나리오가 있으면 같은 방식으로 추가 오버레이.

```js
{
  label: "낙관(최고 목표가)",
  data: [{x: today, y: currentPrice}, {x: horizonDate, y: targetHigh}],
  borderDash: [5, 5],
  borderColor: "green",
}
```

## 프론트엔드 화면 구성

- 상단: 포트폴리오 요약 카드(총 평가금액, 총 손익률, 종목별 비중 파이차트) — 현재가는 방법 B로 실시간 갱신
- 종목별 탭/카드: 가격 캔들차트 + 이동평균선 오버레이 + 시나리오 점선, RSI 서브차트, 수급 막대그래프, 기본지표 표, 목표주가 갭, 최근 뉴스 리스트

## 구현 순서 제안 (Claude Code CLI에 요청 시)

1. 리포지토리 초기화, `requirements.txt`(pykrx, FinanceDataReader, dart-fss, yfinance, ta, requests, beautifulsoup4, pyyaml)
2. `collectors/indicators.py` (RSI/이동평균 공통 로직) → `price_collector.py`
3. `flow_collector.py`, `fundamental_collector.py`, `target_price_collector.py`, `news_collector.py`
4. `.github/workflows/update.yml` 작성 및 로컬 테스트
5. `proxy/worker.js` 작성 + Cloudflare Workers 배포
6. `site/` 프론트엔드(Chart.js 기반) — 배치 JSON 로드 + 실시간 현재가 fetch + 시나리오 점선 오버레이
7. GitHub Pages 배포 설정
