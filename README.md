# 메-Stock — 개인 주식 포트폴리오 대시보드

보유 종목(국내주식 + 미국 Micron)의 매수가/수량/현재가/평가손익에 더해
재무지표·수급(외인/기관)·거래량·RSI·이동평균선·증권사 목표주가 컨센서스·주요 뉴스를
한 화면에서 보는 개인용 정적 대시보드.

- **배치 데이터** (재무·수급·RSI·이평·뉴스·목표주가): GitHub Actions 가 평일 장마감 후 하루 1회 수집 → `data/*.json` 커밋
- **실시간 현재가/평가손익**: 페이지 로드 시 브라우저가 Cloudflare Worker 프록시로 직접 조회

전체 설계는 [`stock-dashboard-spec.md`](./stock-dashboard-spec.md) 참고.

---

## 리포지토리 구조

```
Med-Stock/
├── holdings.yaml                 # 매수가/수량/매수일
├── scenarios.yaml               # (선택) 종목별 커스텀 목표가 시나리오
├── requirements.txt
├── data/                        # ← GitHub Actions 산출물 (자동 커밋)
│   ├── holdings.json  scenarios.json  snapshot.json
│   ├── prices/{ticker}.json      # 일봉 + MA(5/20/60/120) + RSI(14)
│   ├── fundamentals/{ticker}.json
│   ├── flows/{ticker}.json       # 외인/기관/개인 순매수 + 거래량·거래대금
│   ├── targets/{ticker}.json     # 목표주가 최고/평균/최저 + 투자의견
│   └── news/{ticker}.json
├── collectors/
│   ├── common.py                 # 경로·로딩·저장 공통
│   ├── indicators.py             # RSI / 이동평균
│   ├── price_collector.py        # FinanceDataReader/pykrx(KRX), yfinance(MU)
│   ├── flow_collector.py         # pykrx 투자자별 매매동향
│   ├── fundamental_collector.py  # pykrx 기본지표 (+ 선택: dart-fss)
│   ├── target_price_collector.py # 네이버 금융 스크래핑 / yfinance analyst target
│   ├── news_collector.py         # 네이버 금융 뉴스탭 / Google News RSS / yfinance
│   └── snapshot_builder.py       # yaml→json 변환 + 포트폴리오 요약
├── proxy/worker.js               # Cloudflare Worker: 실시간 시세 CORS 프록시
├── site/                         # index.html / dashboard.js / style.css
└── .github/workflows/
    ├── holdings.yml              # holdings.yaml 변경 시 data/*.json 재생성 (스크래핑 없음, 수초)
    ├── update.yml                # 배치 파이프라인 — 시세·재무·수급·뉴스·목표주가 (cron + 수동)
    └── pages.yml                 # site/ + data/ → GitHub Pages 배포
```

---

## 1. 보유 종목 설정 (단방향: GitHub → 대시보드)

보유종목은 **`holdings.yaml` 하나만** 내가 직접 수정한다. 기기간 동기화나
브라우저 안에서의 편집·저장은 없다. 대시보드는 GitHub 에 올라온 JSON 을
읽기만 한다.

```
holdings.yaml 수정 (GitHub 웹 에디터 또는 로컬 커밋)
  → main 에 push
  → "Rebuild holdings" 워크플로가 data/holdings.json · scenarios.json · snapshot.json 재생성·커밋 (수초)
  → "Deploy dashboard to GitHub Pages" 가 data/** 변경을 받아 자동 재배포 (1~2분)
  → https://doheecho.github.io/Med-Stock/ 에 반영
```

github.com 에서 `holdings.yaml` 을 열고 연필 아이콘으로 바로 편집 → *Commit changes*
하면 끝. 나머지(시세·재무·수급·뉴스·목표주가)는 `update.yml` 이 평일 장마감 후
알아서 채운다.

```yaml
- ticker: "005930"      # KRX: 6자리 코드(문자열), 미국: 야후 심볼(MU 등)
  name: "삼성전자"
  market: KRX            # KRX | US
  buy_price: 68000       # 평균 매수 단가 (KRX=원, US=USD)
  quantity: 30
  buy_date: 2025-11-03
```

`scenarios.yaml` 는 선택. 없어도 증권사 컨센서스(최고/평균/최저) 점선은 자동 표시된다.
(`scenarios.yaml` 을 고쳐도 같은 "Rebuild holdings" 워크플로가 돈다.)

---

## 2. 로컬에서 데이터 생성 (선택 — Actions 만 써도 됨)

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
cd collectors
..\.venv\Scripts\python.exe price_collector.py
..\.venv\Scripts\python.exe flow_collector.py
..\.venv\Scripts\python.exe fundamental_collector.py
..\.venv\Scripts\python.exe target_price_collector.py
..\.venv\Scripts\python.exe news_collector.py
..\.venv\Scripts\python.exe snapshot_builder.py
```

각 수집기는 **부분 실패해도 나머지는 계속** 진행하도록 되어 있다(`common.safe`).
`snapshot_builder.py` 는 항상 마지막에 실행 — `holdings.yaml`/`scenarios.yaml` 을
`data/*.json` 으로 변환하고 종가 기준 포트폴리오 요약을 만든다.

### DART 보강 (선택)

`fundamental_collector.py` 는 환경변수 `DART_API_KEY` 가 있으면 `dart-fss` 로
ROE·부채비율을 보강한다. 없으면 pykrx 기본지표(PER/PBR/EPS/BPS/배당)만 저장.
Actions 에서 쓰려면 리포지토리 Secrets 에 `DART_API_KEY` 를 추가한다.

---

## 3. GitHub Actions 배치

- `update.yml`: `cron: "30 7 * * 1-5"` (UTC) = **KST 16:30 평일**. `workflow_dispatch` 로 수동 실행 가능.
  실행 후 변경분이 있으면 `data/` 를 자동 커밋·푸시한다.
- 리포지토리 **Settings → Actions → General → Workflow permissions** 를
  *Read and write permissions* 로 설정해야 커밋이 푸시된다. (워크플로에 `permissions: contents: write` 도 명시돼 있음)

---

## 4. 실시간 현재가 프록시 (Cloudflare Worker)

무료 시세 소스는 브라우저 직접 fetch 시 CORS 에 막히므로 경량 프록시를 둔다.
Cloudflare Workers 무료 티어(하루 10만 요청)로 충분.

```powershell
npm i -g wrangler
wrangler login
wrangler deploy proxy/worker.js --name med-stock-proxy --compatibility-date 2024-11-01
```

배포 후 나온 URL(`https://med-stock-proxy.<subdomain>.workers.dev`)을
`site/dashboard.js` 상단 `PROXY_BASE` 에 넣고 커밋한다.

> `PROXY_BASE` 가 비어 있으면 대시보드는 실시간 조회를 건너뛰고
> 배치 종가(`last_close`)로 현재가/평가손익을 표시한다.

응답은 `{ ticker, price, prevClose, changePct, currency, source, raw }` 로 정규화된다.

### 4-1. (선택) 버튼으로 워크플로 트리거

상단 **↻ AI Advisor** 버튼이 GitHub 의 "Refresh AI Advisor" 워크플로를 바로 실행하게 하려면
워커에 시크릿 2개를 넣는다 (`PROXY_BASE` 설정 전제):

```powershell
wrangler secret put GH_DISPATCH_TOKEN   # fine-grained PAT, 이 리포 Actions: Read and write
wrangler secret put GH_REPO             # 예: doheecho/Med-Stock
```

- 워커 라우트: `GET {PROXY_BASE}/dispatch?wf=advisor` (또는 `wf=update`) → `workflow_dispatch`
- 시크릿이 없으면 501 을 돌려주고, 대시보드는 그냥 `advisor.json` 을 다시 불러온다.
- 토큰은 워커 시크릿에만 있고 정적 사이트/코드에는 없다.

---

## 5. GitHub Pages 배포

`pages.yml` 이 `site/*` 와 `data/` 를 합쳐 `_site` 아티팩트로 배포한다.

1. 리포지토리 **Settings → Pages → Build and deployment → Source = GitHub Actions**
2. `main` 에 `site/**` 또는 `data/**` 변경이 푸시되면 자동 배포.
   `update.yml` 완료 후에도 (`workflow_run`) 자동 재배포.
3. 공개 URL: `https://doheecho.github.io/Med-Stock/`

로컬 미리보기:

```powershell
python -m http.server 8000
# http://localhost:8000/site/  (dashboard.js 가 ../data 를 자동 탐색)
```

---

## 화면 구성

- **상단 요약**: 통화별 총 매수금액 / 평가금액 / 평가손익 / 수익률 (현재가는 프록시로 갱신),
  종목 비중 도넛, 포지션 표
- **종목 탭**: 가격(캔들 또는 라인) + 이동평균 + 시나리오 점선,
  RSI(14) 서브차트, 수급 막대(외인/기관), 기본지표 표, 목표주가 갭 바, 최근 뉴스

### 시나리오 점선

`data/targets/{ticker}.json` 의 컨센서스를 앵커로:

| 시나리오 | 앵커 |
|---|---|
| 낙관 | 최고 목표가 |
| 중립 | 평균 목표가(컨센서스) |
| 비관 | 최저 목표가 |

`scenarios.yaml` 항목이 있으면 동일 방식으로 추가 오버레이. 각 점선은
`오늘 → 목표시점` 2점짜리 데이터셋(`borderDash: [5,5]`).

---

## 데이터 소스 & 한계

| 데이터 | KRX | US(MU) |
|---|---|---|
| 일봉/이평/RSI | FinanceDataReader → pykrx | yfinance |
| 수급(외인/기관) | pykrx | — (미제공) |
| 재무지표 | pykrx (+dart-fss) | yfinance `.info` |
| 목표주가 | 네이버 금융 스크래핑 | yfinance analyst target |
| 뉴스 | 네이버 금융 뉴스탭 → Google News RSS | yfinance → Google News RSS |
| 실시간가 | 네이버 polling API (프록시 경유) | Yahoo chart API (프록시 경유) |

- 스크래핑 소스(네이버)는 마크업이 바뀌면 깨질 수 있음 — `target_price_collector` 는
  상세 미제공 시 평균가 ±15% 근사 밴드로 폴백.
- 통화가 다른 종목(₩/$)은 환율 환산 없이 **통화별로 따로 합산**해서 표시.
