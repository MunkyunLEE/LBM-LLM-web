# LBM-LLM-web — 자연어 지시(규칙 · LLM) 설계

FEM-LLM-web과 같은 3-pane UI와 조작 방식을 따르되, 서버 없이 정적 페이지(GitHub Pages)에서 동작하도록 만든 구조입니다.

## 1. 호스팅 결정: A안 (현재)

| | A안 (채택) | B안 (전환 후보) |
|---|---|---|
| 구조 | 정적 페이지, 브라우저가 LLM API 직접 호출 | Python 서버가 LLM 호출 · 규칙 파싱 담당 (FEM-LLM-web 방식) |
| 배포 | GitHub Pages 링크 하나 | 서버 실행 필요 |
| API 키 | 사용자 브라우저에만 (기본: 탭 닫으면 삭제) | 서버 환경변수 |
| 규칙 파서 | `js/agent/rules.js` | Python (Simweb-Core 공유 가능) |

### B안으로 전환을 검토할 조건

1. 사내 LLM 게이트웨이가 브라우저 호출(CORS)을 막음 → 먼저 `tools/llm_proxy.py`(선택형 로컬 프록시)로 해결, 운영이 번거로우면 B안
2. API 키를 브라우저에 두는 것이 보안 정책상 불가
3. 규칙 파서를 FEM · SPH와 Python으로 공유하는 편이 나을 때 (Simweb-Core 통합)
4. 대용량 형상 · 결과 처리를 서버 측 솔버로 옮길 때

전환해도 유지할 계약: **ops JSON 스키마**, **LLM 방식 4종**, **UI 레이아웃**. 프런트엔드는 `js/simweb/llm.js`의 `complete()`만 `/api/chat` 호출로 바꾸면 됩니다.

## 2. 파일 구성

| 파일 | 역할 | 공통화 후보 |
|---|---|---|
| `css/simweb.css` | FEM-LLM-web 색 · 3-pane 레이아웃 · 채팅 스타일 | ✓ |
| `js/simweb/llm.js` | 설정 저장, OpenAI 호환 / Anthropic 호출, JSON 추출, 응답 테스트 | ✓ |
| `js/simweb/panel.js` | 우측 패널(LLM 설정 · 채팅 · 되돌리기), 방식별 흐름, 하단 패널 접기 | ✓ |
| `js/agent/rules.js` | 한국어/영어 규칙 파서 (2D · 3D 공용) | |
| `js/agent/prompts.js` | LLM 시스템 프롬프트 (2D · 3D ops 문법) | |
| `js/agent/agent3d.js` | 3D ops 검증 · 적용 · 스냅샷 | |
| `js/agent2d.js` | 2D ops 검증 · 적용 · 스냅샷 | |
| `tools/llm_proxy.py` | CORS를 막는 게이트웨이용 선택형 로컬 프록시 (표준 라이브러리만) | ✓ |

`simweb/`는 나중에 Simweb-Core로 옮길 수 있게 앱 코드에 의존하지 않습니다. 앱은 어댑터(`rules`, `apply`, `snapshot`, `restore`, `context`, `run`, `system`, `chips`)만 넘깁니다.

## 3. 처리 흐름

```
문장 → rules.parse() → {ops, ask, unknown, run, undo}
  규칙 우선: unknown/ask 없음 → 바로 적용
             남은 말 있음 → LLM(SPEC + PARAMS + 최근 대화 6턴 + 문장) → ops
  적용: snapshot → apply(ops) → 실패하면 restore 후 오류를 붙여 LLM 1회 재요청
  되돌리기: 적용마다 스냅샷을 쌓고 "되돌려" 또는 버튼으로 복원
```

LLM에 보내는 것: 현재 조건 요약(JSON), 격자 파라미터 요약, 예제 목록, 입력 문장. 형상 메쉬 · 결과 필드는 보내지 않습니다.

## 4. ops 스키마 요약

공통: 길이 · 위치 mm(월드 좌표), 속도 m/s(면 안쪽 방향), 압력 Pa(게이지), 시간 s, 각도 °.

| op | 3D | 2D |
|---|---|---|
| `set_domain` | size, Lx/Ly/Lz, dx, origin, refine | Lx, Ly, Nx, dx, origin, refine |
| `set_fluid` | preset air/water, nu, rho, les | preset demo/air/water, nu, rho, les, cs |
| `set_face` / `set_edge` | face xmin…zmax, type, speed/u, p, profile(uniform/power/log) | edge left/right/bottom/top, type, speed/u, p |
| `add_patch` | face, shape rect/circle, center, size/r, type, speed, p | edge, range [s0,s1], type, speed, p |
| `add_object` | sphere/box/rotor/plate | (`add_samples`) |
| `update_object` | pos, move, rot, rot_add, scale, scale_mul, on_floor, center, role, kin | pos, move, rot, rot_add, scale, scale_mul, role, kin |
| `remove_object`, `duplicate_object`, `clear` | ✓ | ✓ (복제 제외) |
| `set_run` | duration, ramp, frames, u_lat_max, sponge, avg_start, particles, backend | duration, ramp, frames, u_lat_max, sponge |
| `add_probe` | pos [x,y,z] | – |
| `set_view` | mode, field, slices, vectors, streams, stream_density, particles, mean, range, camera | mode, field, vectors, streams, particles, mask, grid |
| `analyze` | stream / qiso / vtk | – |
| `plot` | load fx…rpm / probe umag…p | load fx, fy, m, theta, rpm |
| `load_example`, `run`, `stop` | ✓ | ✓ |

전체 문법은 `js/agent/prompts.js`에 있습니다.

## 5. 규칙 파서 확장 방법

- 절 분리: `splitClauses()` — 쉼표, 줄바꿈, “그리고”, “~하고/~주고/~불고” 등
- 각 절은 `Clause.take()`로 이해한 부분을 지우고, 남은 말(`leftover()`)에서 조사 · 어미(FILLER)를 뺀 뒤에도 의미 있는 말이 남으면 `unknown`으로 표시 → 규칙 우선 모드에서 LLM으로 넘어감
- 새 표현은 해당 처리 함수(`facesOf`, `bcTypeOf`, `objectOps`, `viewOps` 등)에 정규식을 추가하고, 의미 없는 어미는 `FILLER`에 추가

## 6. 사용법 (API 연결)

1. 오른쪽 LLM 칸에서 제공자 프리셋을 고르거나 엔드포인트를 직접 입력
   - OpenAI `https://api.openai.com/v1` · Anthropic `https://api.anthropic.com/v1` · Gemini `https://generativelanguage.googleapis.com/v1beta/openai` · OpenRouter `https://openrouter.ai/api/v1`
   - 그 밖의 OpenAI 호환 서버도 같은 형식으로 입력 (`…/v1`)
2. 모델 이름과 API 키 입력 → **실제 응답 테스트**
3. 사내 게이트웨이가 CORS로 막히면:
   ```
   python3 tools/llm_proxy.py https://사내-게이트웨이/v1 --port 8790
   ```
   후 엔드포인트에 `http://127.0.0.1:8790` 입력 (키를 서버 쪽에 두려면 `--key`)
