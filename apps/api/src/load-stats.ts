import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import type { RollupResult } from "./rollup.js";
import type { ServerConfig } from "./server-config.js";

// 부하 측정의 API 지표(DESIGN 6.8 "증거"). LOAD_STATS를 준 main.ts만 쓴다. seat-booking 6단계의 것을 가져왔다.
// 1초마다 그 1초 동안의 값을 api-stats.jsonl에 JSON 한 줄로 덧붙인다. 동기로 쓰므로 프로세스가 강제로 끝나도
// 끝난 줄은 남는다(Windows의 TerminateProcess는 onClose를 돌리지 않는다). 그래서 끝에 한 번 쓰는 값에 기대지 않는다.

type RouteWindow = { times: number[]; statuses: Record<number, number>; codes: Record<string, number>; aborted: number };
type PoolWindow = { connectWaits: number[]; connectErrors: number; newConnections: number };
type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, release: (release?: unknown) => void) => void;

const round = (value: number) => Math.round(value * 100) / 100;

// 가장 가까운 순위로 p50·p95와 최대를 구한다. 값이 없으면 null.
export function summarize(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil((p / 100) * sorted.length) - 1]!;
  return { count: sorted.length, p50: round(at(50)), p95: round(at(95)), max: round(sorted.at(-1)!) };
}

// monitorEventLoopDelay는 타이머가 울린 간격 전체를 적는다. 쉬어도 값이 이 간격만큼 나오므로 빼서 쓴다.
// setImmediate 뒤에 막힌 것은 잡히지 않을 때가 있어(seat-booking의 실험) 포화는 이벤트 루프 사용률(ELU)과 함께 본다.
const LOOP_DELAY_RESOLUTION_MS = 10;
export const loopDelayMs = (ns: number) => round(Math.max(0, ns / 1e6 - LOOP_DELAY_RESOLUTION_MS));

// 요청마다 풀에서 연결을 받기까지 기다린 시간. 응답 머리 Server-Timing(pool;dur=…)으로 알려, k6가 리포트 종류별 요청 시간을
// 풀 대기와 실행으로 나눈다(DESIGN 6.8 "지표"). 요청 하나가 연결을 여러 번 받으면 더한다.
type RequestTiming = { poolWaitMs: number; connects: number };
const requestTiming = new AsyncLocalStorage<RequestTiming>();

const routeKey = (request: FastifyRequest) => `${request.method} ${request.routeOptions.url ?? "(없는 경로)"}`;

// 4xx·5xx 응답 본문의 code(busy, report_timeout, out_of_retention, partition_missing …). 이 API는 실패를 이유와 함께 답한다.
function replyCode(payload: unknown): string | undefined {
  if (typeof payload !== "string") return undefined;
  try {
    const body = JSON.parse(payload) as { code?: unknown };
    return typeof body.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

export function createLoadStats(options: { dir: string; pools: Record<string, pg.Pool>; config: ServerConfig; intervalMs?: number }) {
  const { dir, pools, config, intervalMs = 1000 } = options;
  mkdirSync(dir, { recursive: true });
  const statsFile = path.join(dir, "api-stats.jsonl");

  let routes = new Map<string, RouteWindow>();
  const poolWindows = new Map<string, PoolWindow>();
  const emptyPoolWindow = (): PoolWindow => ({ connectWaits: [], connectErrors: 0, newConnections: 0 });
  let rollupRounds: ((RollupResult | { failed: true }) & { ms: number })[] = [];
  // onSend에서 읽은 본문의 code를 onResponse가 상태와 함께 센다(끊긴 요청은 상태도 code도 세지 않고 aborted로만 센다)
  const replyCodes = new WeakMap<FastifyRequest, string>();
  let gcMs = 0;
  let gcCount = 0;
  const routeWindow = (key: string) => {
    let window = routes.get(key);
    if (!window) {
      window = { times: [], statuses: {}, codes: {}, aborted: 0 };
      routes.set(key, window);
    }
    return window;
  };

  // 풀마다 연결을 받기까지 기다린 시간. 기다리는 연결 수(waitingCount)는 그 순간의 줄 길이일 뿐이라 따로 잰다.
  // pg-pool의 query도 안에서 this.connect를 부르므로, 이 하나로 트랜잭션과 단일 질의를 모두 잰다.
  for (const [name, pool] of Object.entries(pools)) {
    poolWindows.set(name, emptyPoolWindow());
    // 쉬는 연결이 없어 새로 맺은 연결. 그 TCP·인증 시간도 연결 대기 시간에 들어가므로 함께 적는다.
    pool.on("connect", () => {
      poolWindows.get(name)!.newConnections++;
    });
    const connect = pool.connect.bind(pool) as unknown as (callback?: ConnectCallback) => Promise<pg.PoolClient> | undefined;
    const timedConnect = (callback?: ConnectCallback) => {
      const started = performance.now();
      const record = (failed: boolean) => {
        const waited = performance.now() - started;
        const window = poolWindows.get(name)!;
        window.connectWaits.push(waited);
        if (failed) window.connectErrors++;
        const timing = requestTiming.getStore();
        if (timing) {
          timing.poolWaitMs += waited;
          timing.connects++;
        }
      };
      if (callback) {
        return connect((err, client, release) => {
          record(err !== undefined);
          callback(err, client, release);
        });
      }
      return connect()!.then(
        (client) => {
          record(false);
          return client;
        },
        (err: unknown) => {
          record(true);
          throw err;
        },
      );
    };
    pool.connect = timedConnect as unknown as typeof pool.connect;
  }

  const loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS });
  const gc = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcMs += entry.duration;
      gcCount++;
    }
  });

  let lastAt = performance.now();
  let lastElu = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let timer: NodeJS.Timeout | undefined;

  // 지난 줄 뒤의 값을 한 줄로 쓰고 비운다. 누적 값(CPU, ELU)은 지난 줄과의 차이를 쓴다.
  // 기준점은 처음에 한 번 잡아 다음 줄의 기준으로도 쓴다(쓰는 데 든 시간이 어느 줄에서도 빠지지 않게).
  function flush() {
    const now = performance.now();
    const eluNow = performance.eventLoopUtilization();
    const cpuNow = process.cpuUsage();
    const elapsedMs = now - lastAt;
    const elu = performance.eventLoopUtilization(eluNow, lastElu);
    const cpu = { user: cpuNow.user - lastCpu.user, system: cpuNow.system - lastCpu.system };
    const line = {
      type: "tick",
      at: new Date().toISOString(),
      ms: round(elapsedMs),
      pools: Object.fromEntries(
        Object.entries(pools).map(([name, pool]) => {
          const window = poolWindows.get(name)!;
          return [
            name,
            {
              total: pool.totalCount,
              idle: pool.idleCount,
              waiting: pool.waitingCount,
              connectWait: summarize(window.connectWaits),
              connectErrors: window.connectErrors,
              newConnections: window.newConnections,
            },
          ];
        }),
      ),
      node: {
        elu: Math.round(elu.utilization * 1000) / 1000,
        // 한 코어를 100으로 본 CPU 사용률(사용자 + 시스템)
        cpuPct: round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 100),
        loopDelayMs: {
          p50: loopDelayMs(loopDelay.percentile(50)),
          p99: loopDelayMs(loopDelay.percentile(99)),
          max: loopDelayMs(loopDelay.max),
        },
        gcMs: round(gcMs),
        gcCount,
        heapMb: round(process.memoryUsage().heapUsed / 2 ** 20),
      },
      routes: Object.fromEntries(
        [...routes].map(([key, window]) => [
          key,
          {
            ...summarize(window.times),
            statuses: window.statuses,
            ...(Object.keys(window.codes).length > 0 ? { codes: window.codes } : {}),
            ...(window.aborted > 0 ? { aborted: window.aborted } : {}),
          },
        ]),
      ),
      rollup: rollupRounds,
    };
    appendFileSync(statsFile, `${JSON.stringify(line)}\n`);

    lastAt = now;
    lastElu = eluNow;
    lastCpu = cpuNow;
    routes = new Map();
    for (const name of poolWindows.keys()) poolWindows.set(name, emptyPoolWindow());
    rollupRounds = [];
    gcMs = 0;
    gcCount = 0;
    loopDelay.reset();
  }

  return {
    // 집계 작업 한 바퀴(startRollupLoop의 onRound). 리포트와 겨루는지 보려고 그 시각과 걸린 시간을 남긴다. 실패한 바퀴도 남긴다.
    recordRollup: (result: RollupResult | { failed: true }, ms: number) => {
      rollupRounds.push({ ...result, ms: round(ms) });
    },
    // 앱이 준비되기 전에 부른다. 클라이언트가 응답 전에 끊은 요청(k6의 시간 한도)은 onResponse가 불리지 않으므로
    // aborted로 따로 센다. 가장 느린 요청이 처리 시간에서 빠지므로, aborted가 있으면 그 경로의 p95는 실제보다 작다.
    // 끊김은 응답 소켓의 close로 가린다: Fastify의 onRequestAbort는 본문을 다 읽은 POST(재는 경로 모두)에서는 불리지 않는다(코드 리뷰).
    attach(app: FastifyInstance) {
      app.addHook("onRequest", (request, reply, done) => {
        reply.raw.once("close", () => {
          if (!reply.raw.writableFinished) routeWindow(routeKey(request)).aborted++;
        });
        // 이 요청의 나머지(처리기와 그 안의 연결 받기)가 이 저장소를 본다
        requestTiming.run({ poolWaitMs: 0, connects: 0 }, done);
      });
      app.addHook("onSend", (request, reply, payload, done) => {
        const timing = requestTiming.getStore();
        if (timing && timing.connects > 0) reply.header("server-timing", `pool;dur=${timing.poolWaitMs.toFixed(1)}`);
        if (reply.statusCode >= 400) {
          const code = replyCode(payload);
          if (code) replyCodes.set(request, code);
        }
        done(null, payload);
      });
      app.addHook("onResponse", (request, reply, done) => {
        const window = routeWindow(routeKey(request));
        window.times.push(reply.elapsedTime);
        window.statuses[reply.statusCode] = (window.statuses[reply.statusCode] ?? 0) + 1;
        const code = replyCodes.get(request);
        if (code) window.codes[code] = (window.codes[code] ?? 0) + 1;
        done();
      });
    },
    start() {
      appendFileSync(statsFile, `${JSON.stringify({ type: "start", at: new Date().toISOString(), pid: process.pid, config })}\n`);
      loopDelay.enable();
      gc.observe({ entryTypes: ["gc"] });
      lastAt = performance.now();
      lastElu = performance.eventLoopUtilization();
      lastCpu = process.cpuUsage();
      timer = setInterval(flush, intervalMs);
      timer.unref();
    },
    flush,
    stop() {
      clearInterval(timer);
      flush();
      loopDelay.disable();
      gc.disconnect();
    },
  };
}
