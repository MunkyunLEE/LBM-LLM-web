# LBM-LLM-web

브라우저에서 바로 실행되는 2D·3D 격자 볼츠만(Lattice Boltzmann Method) 유동 시뮬레이터에, 문장으로 해석 조건과 결과 표시를 지시하는 기능(규칙 + LLM)을 붙인 웹 앱입니다. 화면 구성과 조작 방식은 FEM-LLM-web과 같습니다.

- **2D** (`index.html`): D2Q9, DXF 형상, IBM 기반 간이 FSI
- **3D** (`3d.html`): D3Q19, WebGPU 병렬 계산(미지원 시 CPU), STL/OBJ 형상, 회전 강체 FSI
- **Theory** (`theory.html`): 이론식, 구현, 문헌 벤치마크 검증, 자연어 지시 구조

설치 없이 링크만 열면 형상을 배치하고, 경계조건과 유입·유출 영역을 지정하고, 유동과 물체 하중을 계산하고, 바람에 움직이는 구조물(간이 FSI)까지 볼 수 있습니다.

- 계산은 모두 브라우저(Web Worker / WebGPU) 안에서 이루어지며, 불러온 형상 파일은 어디에도 전송되지 않습니다.
- 서버나 빌드 과정이 없는 정적 페이지라 GitHub Pages에 그대로 올라갑니다. 경로는 모두 상대경로라 저장소 이름이 바뀌어도 그대로 동작합니다.

## 화면 구성

| 영역 | 내용 |
|---|---|
| 왼쪽 | 케이스(예제 · 저장 · 열기), 도메인·격자, 유체, 객체, 경계조건, 해석 설정, 실행 |
| 가운데 | 뷰어(좌표축 · 범례 · 표시 도구) + 하단 결과·그래프(결과 표시, 3D 분석·GIF, 프로브, 물체 하중) |
| 오른쪽 | 2D/3D 전환, Theory, LLM 설정, 조건 · 결과 지시 채팅 |

## 자연어 지시 (규칙 · LLM)

오른쪽 채팅에 “x 방향으로 5 m/s, 출구는 대기압, 바닥은 벽으로 하고 해석 실행”처럼 입력하면 왼쪽 설정에 바로 반영됩니다.

- **규칙 우선(기본)**: 규칙 파서가 이해한 문장은 LLM 없이 처리하고, 남은 말만 LLM으로 보냅니다. LLM을 연결하지 않아도 규칙만으로 쓸 수 있습니다.
- **LLM 연결**: 엔드포인트 · 모델 · 키는 비어 있으며 누구나 자기 API(OpenAI 호환, Anthropic, Gemini, OpenRouter, 사내 게이트웨이)를 넣어 씁니다. 키는 기본적으로 탭을 닫으면 지워집니다.
- LLM에는 현재 조건 요약과 입력 문장만 보내며, 형상 파일과 결과 데이터는 보내지 않습니다.
- 모든 지시는 되돌리기가 됩니다.
- 사내 게이트웨이가 브라우저 호출(CORS)을 막으면 `tools/llm_proxy.py`를 쓰거나 B안(서버 방식)으로 전환합니다. 자세한 구조와 ops 스키마는 [`docs/LLM.md`](docs/LLM.md)에 있습니다.

## 기능

| 단계 | 내용 |
|---|---|
| 격자판 | 가로 Lx × 세로 Ly [mm], 가로 분할 수 Nx (셀 상한 100만) |
| 유체 | 데모(층류) / 공기 / 물 / 사용자 정의 ν, ρ, Smagorinsky LES |
| 객체 | DXF 불러오기, 선택·이동·회전·배율·삭제, 복셀 미리보기 |
| 객체 역할 | 고체 / 유입 영역(방사형·균일 벡터) / 유출 영역(압력) |
| Kinematics (FSI) | 객체별 OFF(고정) / 자유 회전 / 힌지(스프링) / 강제 회전(rpm), 회전축 캔버스 지정, 물성 프리셋 + 고급 설정 |
| 경계조건 | 변별 속도 / 압력 / 유출 / 벽 / 미끄럼벽, 테두리 드래그로 구간(patch) 지정 |
| 결과 | 속도 크기, 와도, 압력 + 속도 벡터, 유선, 입자(유맥선) |
| 물체 하중 | Fx, Fy, M, Cd, Cl 표와 시계열 그래프 (각도·회전수 포함) |
| GIF | 필드 + 벡터·입자·움직이는 객체 윤곽, 범례 포함 |
| 테마 | 다크 / 라이트 / 시스템 설정 (기본 다크) |
| 예제 | 바람에 도는 로터, 힌지 판, 실내 급·배기, 90° 곡관, 2중 곡관 |

### DXF 지원 요소

LINE, LWPOLYLINE(호 구간 포함), POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE(유리 NURBS 포함), INSERT(블록).
닫힌 커브는 내부가 고체(또는 유입/유출 영역), 열린 커브는 1셀 두께 벽입니다. Kinematics가 켜진 객체는 두께 0 경계(IBM)로 처리됩니다.

## 솔버

- D2Q9, 정칙화(Regularized) BGK + 선택적 Smagorinsky LES
- 벽: halfway bounce-back / 속도·압력 경계: 비평형 외삽(Guo) / 유출: zero-gradient / 미끄럼벽: 대칭 반사
- 유입·유출 영역: 영역 셀의 평형 분포를 지정 속도·압력으로 교체 (방사형 유입은 질량 생성)
- 압력·유출 변 안쪽 흡수층: 밀도와 단면 평균 유출속도만 이완해 반사 음파 제거
- 물체 하중: 운동량 교환법 / FSI: IBM 직접 강제법(3회 반복) + 강체 1축 회전(반암시적 적분)
- 단위 변환: Δt = u<sub>lat,max</sub>·Δx / U<sub>max</sub>, τ₀ = 3ν·Δt/Δx² + 0.5

### 검증

| 항목 | 결과 |
|---|---|
| Python 기준 솔버 대비 | 최대 차이 4×10⁻⁶ |
| 방사형 분출 u<sub>r</sub>·r = Q/2π | 오차 0.5% 이내 |
| 원기둥 Re 100 (막힘비 8%) | C<sub>d</sub> 1.38, C<sub>l</sub> 진폭 0.334, St 0.172 |
| IBM 토크 vs 고정벽 토크 | 부호·크기 일치 |

2D 해석이므로 실스케일 공기·물(고 Re)의 정량 해석보다는 유동 패턴과 상대 비교 용도에 적합합니다.

## 3D (v0.5)

| 단계 | 내용 |
|---|---|
| 도메인 | Lx × Ly × Lz [mm] 직육면체, 정육면체 셀 크기 Δx 직접 입력(N = L/Δx), 도메인 원점(월드 좌표) 지정, 도메인 밖 형상 숨김, 회전하는 XYZ 좌표계 |
| 계산 장치 | 자동(WebGPU 우선) / GPU / CPU. GPU 셀 상한 800만, CPU 100만 |
| 객체 | STL·OBJ 불러오기(mm/cm/m/inch), 구·상자·로터·판 기본 형상, 이동·회전·배율·복제, 바닥 놓기 |
| 스냅 | 경계상자 꼭짓점 8개 + 면 중심 6개 앵커만 격자점에 스냅, Shift+드래그로 수직 이동 |
| 객체 역할 | 고체 / 유입 영역(속도 벡터) / 유출 영역(압력) |
| Kinematics | OFF / 자유 회전 / 힌지(스프링·각도 제한) / 구동(rpm). 회전축 X·Y·Z·사용자 벡터, 축 위치는 앵커 클릭 또는 숫자, 물성 프리셋 + 고급 입력(숨김) |
| 경계조건 | 6면별 벽 / 미끄럼 / 속도 / 압력 / 자유 유출 / 주기, 대기경계층 유입(멱법칙·로그법칙), 면 위 구간(사각형·원·DXF 닫힌 곡선) |
| 결과 | X·Y·Z 단면(속도 크기·성분, 압력, 수직 와도), 단면 벡터, 단면 유선, 3D 입자, 회전하는 객체, 커서 값 읽기 |
| 분석 | 시간 평균장, 프로브 시계열(최대 64점), 3D 유선, Q-criterion 와류 등치면, VTK 내보내기(ParaView) |
| 하중 | 객체별 Fx, Fy, Fz, 축 모멘트, 각도, 회전수 표 + 시계열 (기준 압력 보정) |
| GIF | 3D 뷰 캡처(시점 그대로), FPS·폭 지정 |
| 예제 | 풍차형 로터 자유 회전, 실내 선풍기 구동, 힌지 판, 구 항력 검증, 실내 환기, 도시 빌딩 숲(24동, 대로, 대기경계층 유입) |

큰 STL(도시 전체 등)도 그대로 불러온 뒤 도메인 원점과 크기만 정하면 도메인 안에 든 부분만 해석합니다. 2D도 DXF 원래 좌표를 유지하고, 격자판 원점을 옮겨 일부만 해석할 수 있습니다.

## Theory 페이지

상단의 **Theory** 버튼(`theory.html`)에 사용한 이론식(LBGK, 정칙화 충돌, LES, 경계조건, 흡수층, 대기경계층, 운동량 교환, 간이 FSI, GPU 구현)과 문헌 벤치마크 비교 6종(2D 평행판·캐비티·원기둥, 3D 덕트·원관·구)의 그래프가 있습니다. 검증 스크립트는 `validation/`에 있으며 다음으로 다시 계산할 수 있습니다.

```bash
node validation/run2d.mjs poiseuille | cavity 100 | cavity 1000 | cylinder
node validation/run3d.mjs duct | pipe | sphere 100
```

3D 솔버 요약: 정칙화 BGK + LES, 면 경계(bounce-back / 대칭 반사 / Ladd 속도 / anti-bounce-back 압력 / 0구배 유출), 열린 면 흡수층(밀도 이동평균 이완), 운동량 교환 하중, 이동 경계 bounce-back + 매 스텝 재복셀화로 강체 회전, 부가질량 안정화. 자세한 설계와 검증은 [docs/PLAN_3D.md](docs/PLAN_3D.md)에 있습니다.

Rhino에서 내보낼 때는 **STL(바이너리, mm)** 을 권장합니다. 삼각형이 20만 개를 넘는 큰 메쉬는 불러올 때 셀 크기의 절반 격자로 자동 단순화되어(예: 400만 → 5만 개, 200 MB 파일 약 1초) 브라우저 메모리 부족 없이 해석할 수 있습니다. 닫힌 메쉬는 솔리드로, 열린 메쉬(판·쉘)는 두께 약 1.8셀의 쉘로 복셀화됩니다.

## 로컬 실행

모듈 Web Worker를 사용하므로 파일을 더블클릭(`file://`)하면 동작하지 않습니다. 간단한 로컬 서버로 여세요.

```bash
python -m http.server 8000
# 브라우저에서 http://localhost:8000
```

## 구조

```
index.html
css/style.css
js/api.js            /api/* 요청을 Web Worker로 전달
js/app.js            격자판 편집기 UI
js/worker.js         해석 실행 루프, 프레임·하중 기록, API 처리
js/lbm/solver.js     D2Q9 솔버, 경계·영역 필드, 하중, IBM 강제
js/lbm/ibm.js        IBM 강체(회전축, 관성, 스프링, 감쇠)
js/lbm/geometry.js   셀 중심 복셀화, 영역 법선
js/lbm/flowviz.js    유선, 입자
js/lbm/dxf.js        DXF 파서
js/lbm/render.js     컬러맵, 양자화, GIF 생성
js/vendor/gifenc     GIF 인코더 (MIT, Matt DesLauriers)
samples/             샘플 DXF, 예제 케이스 JSON
3d.html, css/style3d.css
js/app3d.js          3D 편집기·결과 UI
js/view3d.js         three.js 장면(도메인, 격자, 객체, 앵커, 단면, 입자)
js/results3d.js      단면 필드·벡터·유선·입자 변환
js/worker3d.js       3D 해석 루프(GPU/CPU 선택, 프레임 기록)
js/lbm3d/setup.js    케이스 → 격자·경계표·강체 데이터
js/lbm3d/gpu.js      WebGPU(WGSL) D3Q19 커널
js/lbm3d/cpu.js      CPU D3Q19 (같은 알고리즘)
js/lbm3d/mesh.js     STL/OBJ 파서, 복셀화(솔리드·쉘)
js/lbm3d/shapes.js   기본 형상 생성(구, 상자, 로터)
js/vendor/three      three.js r170 (MIT)
samples/3d/          3D 예제 케이스
docs/PLAN_3D.md      3D 및 간이 FSI 계획·현황
theory.html, js/theory.js, css/theory.css   이론·검증 페이지
js/lbm3d/analysis3d.js  3D 유선, Q-criterion 등치면, VTK
validation/          벤치마크 재현 스크립트와 결과(results.json)
js/vendor/katex      KaTeX 0.16 (MIT)
```

## 지원 브라우저

최신 Chrome, Edge, Firefox, Safari (모듈 Web Worker, OffscreenCanvas 필요). 3D GPU 계산은 WebGPU 지원 브라우저(Chrome·Edge 113+, Safari 26+)에서 동작하며, 지원하지 않으면 CPU로 계산합니다.
