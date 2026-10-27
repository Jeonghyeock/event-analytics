import pg from "pg";

// 테스트가 소유자 role(CREATEDB만, 슈퍼유저 아님)로 DB를 만들고 지울 때 쓴다(README 로컬 준비).

// 새 DB를 만들 때 붙인다(DESIGN 10장 13). 정렬과 글자 분류를 OS에 맡기지 않아, 로컬(Windows, Korean_Korea.949)과
// CI(Linux, en_US.utf8)에서 차원 값의 정렬 순서가 같다. builtin C.UTF-8은 코드 포인트 순서로 정렬하고 대소문자는 유니코드로 바꾼다.
// 복제(TEMPLATE 다른 DB)로 만드는 DB는 원본의 설정을 이어받아 붙이지 않는다. README와 CI의 DB 만들기도 같다.
export const NEW_DATABASE_OPTIONS =
  "TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'";

// 같은 서버·같은 계정으로 다른 DB를 가리키는 주소.
export function withDatabase(url: string, database: string) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// 그 서버의 postgres DB에 붙어 work를 한다(지우고 만들 DB에는 붙어 있을 수 없다).
export async function withAdminClient(baseUrl: string, work: (client: pg.Client) => Promise<unknown>) {
  const client = new pg.Client({ connectionString: withDatabase(baseUrl, "postgres") });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}

// FORCE는 남은 연결을 끊지만, autovacuum 작업자는 소유자 role이 끊을 권한이 없어(42501) 실패할 수 있다. 끝나길 잠시 기다려 다시 한다.
// 앱 role의 연결은 끊을 수 있다(GRANT event_analytics_app TO event_analytics, README).
export async function dropDatabase(client: pg.Client, db: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== "42501" || attempt === 10) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
