import { z } from "zod";

// 서버의 손잡이(DESIGN 6.8). 부하 측정이 풀 크기를 바꿔 보고, 로그를 줄이고, 1초 지표를 켠다. 주지 않으면 지금까지의 값이다.
// 수는 숫자 글자만 받는다. z.coerce.number()는 "0x10"을 16, "1e1"을 10, ""를 0으로 받는다(seat-booking과 같은 까닭).
const PositiveInt = z
  .string()
  .regex(/^\d+$/, "숫자만 씁니다")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));

const ServerEnv = z.object({
  // 수집·저장한 리포트·/health가 쓰는 풀
  DB_POOL_MAX: PositiveInt.default(10),
  // 리포트·퍼널·리텐션이 쓰는 풀(DESIGN 10장 35)
  REPORT_POOL_MAX: PositiveInt.default(4),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // 1초 지표를 쓸 폴더. 주면 켠다(빈 값·공백은 끔).
  LOAD_STATS: z.string().optional(),
});

export type ServerConfig = { poolMax: number; reportPoolMax: number; logLevel: string; loadStatsDir: string | null };

export function loadServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const parsed = ServerEnv.safeParse(env);
  if (!parsed.success) throw new Error(`서버 설정이 틀렸습니다: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(", ")}`);
  const { DB_POOL_MAX, REPORT_POOL_MAX, LOG_LEVEL, LOAD_STATS } = parsed.data;
  return { poolMax: DB_POOL_MAX, reportPoolMax: REPORT_POOL_MAX, logLevel: LOG_LEVEL, loadStatsDir: LOAD_STATS?.trim() || null };
}
