// drizzle-kit이 마이그레이션을 만들 때 읽는 표 정의.
// 파티션 표(events)는 drizzle-kit이 DDL(PARTITION BY, PARTITION OF)을 내지 못해 손으로 쓴 마이그레이션에만 있고 여기에 두지 않는다(DESIGN 5장).
// 그래서 drizzle-kit generate는 여기 있는 표만 다룬다. events는 쿼리도 직접 쓴 SQL로 한다.
export {};
