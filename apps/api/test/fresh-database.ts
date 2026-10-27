import { inject, onTestFinished } from "vitest";
import { dropDatabase, NEW_DATABASE_OPTIONS, withAdminClient, withDatabase } from "../src/db/databases.js";
import { runMigrations } from "../src/db/migrate.js";

let created = 0;

// 그 테스트만 쓰는 새 DB를 만들어 마이그레이션하고, 테스트가 끝나면 실패해도 지운다.
// 파티션을 만들고 떼거나 데이터를 많이 넣는 테스트가 다른 파일과 겹치지 않게 쓴다. 소유자·앱 role 주소를 함께 준다.
export async function freshDatabase(prefix: string) {
  const ownerUrl = inject("ownerDatabaseUrl");
  const name = `event_analytics_${prefix}_${process.pid}_${++created}`;
  await withAdminClient(ownerUrl, async (client) => {
    await dropDatabase(client, name);
    await client.query(`CREATE DATABASE ${name} ${NEW_DATABASE_OPTIONS}`);
  });
  onTestFinished(() => withAdminClient(ownerUrl, (client) => dropDatabase(client, name)));
  const owner = withDatabase(ownerUrl, name);
  await runMigrations(owner);
  return { owner, app: withDatabase(inject("databaseUrl"), name) };
}
