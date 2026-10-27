import { buildApp } from "./app.js";

// seat-booking(3001)과 함께 띄울 수 있게 기본값을 3002로 둔다.
const port = Number(process.env.PORT ?? 3002);
const host = process.env.HOST ?? "127.0.0.1";

const app = buildApp({ logger: true });

const shutdown = () => {
  void app.close().then(() => process.exit(0));
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);

await app.listen({ port, host });
