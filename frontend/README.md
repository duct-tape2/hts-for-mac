# Moa Desk 프런트엔드

React/Next.js 기반 국내·미국주식 조회·분석 화면입니다. 주문·잔고·개인 거래내역 UI는 없습니다. 브라우저는 로컬 FastAPI를 통해 시세를 조회합니다.

저장소 루트에서 `./scripts/setup.sh`와 `./dev.sh`로 실행하세요. 직접 화면만 개발할 때는 이 폴더에서 `npm ci`, `npm run dev`를 사용합니다. 로컬 API 서버가 별도로 필요합니다.

검증: `npm test`, `npm run typecheck`, `npm run build`.

전체 설치·실서버 등록·기능 제한은 [루트 안내](../README.md)를 따릅니다.
