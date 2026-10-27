import pg from "pg";

// PostgreSQL의 bigint(int8)는 node-postgres가 기본으로 문자열로 돌려준다(JS number가 2^53을 넘으면 정확하지 않아서).
// count(*)가 int8이라, 안전한 범위 안에서는 number로 바꾼다(seat-booking과 같은 규칙).
// 범위를 넘는 값은 조용히 틀리게 하지 않고 오류를 낸다. 이 설정은 pg 모듈 전체에 적용되므로 풀을 만드는 이 파일에만 둔다.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 값(${value})이 number의 안전한 범위를 넘습니다`);
  return n;
});

// 앱 연결의 세션 시간대를 UTC로 고정한다(DESIGN 10장 14). 서버 기본값은 로컬이 Asia/Seoul, CI가 UTC라,
// 시간대 없는 시각 글자나 timestamptz → date 변환이 어디서 도느냐에 따라 다른 날이 된다. 파티션과 시간 집계는 UTC 기준이다.
// 리포트의 시간대(Asia/Seoul 등)는 세션 설정이 아니라 쿼리의 인자로 준다.
// pg는 주소의 ?options=가 있으면 config.options를 통째로 덮어쓴다. 그래서 주소의 것을 꺼내 호출한 쪽의 것과 합치고, 고정을 맨 뒤에 둔다
// (같은 설정이 여럿이면 뒤의 것이 이긴다). options를 늘 넘기므로 PGOPTIONS 환경 변수는 읽지 않는다.
export function createPool(config: pg.PoolConfig): pg.Pool {
  let { connectionString } = config;
  let fromUrl: string | null = null;
  if (connectionString) {
    const url = new URL(connectionString);
    fromUrl = url.searchParams.get("options");
    url.searchParams.delete("options");
    connectionString = url.toString();
  }
  const options = [fromUrl, config.options, "-c TimeZone=UTC"].filter(Boolean).join(" ");
  return new pg.Pool({ ...config, connectionString, options });
}
