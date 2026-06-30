import { describe, expect, test } from "vitest";
import { SQL, type ScanArgs, type ScanPage } from "../../src/index.js";

const users = [
  { _id: "u1", email: "a@gmail.com", status: "active", age: 34 },
  { _id: "u2", email: "b@example.com", status: "inactive", age: 17 },
  { _id: "u3", email: "c@gmail.com", status: "active", age: 28 },
];

describe("action-style SQL execution", () => {
  test("collects pages via ctx.runQuery and applies the compiled plan", async () => {
    const scanQuery = Symbol("scanQuery");
    const calls: ScanArgs[] = [];
    const ctx = {
      async runQuery(query: unknown, args: ScanArgs): Promise<ScanPage> {
        expect(query).toBe(scanQuery);
        calls.push(args);
        const start = args.cursor ? Number(args.cursor) : 0;
        const end = start + (args.numItems ?? 2);
        let page = users.slice(start, end);
        if (args.index) {
          page = page.filter((row) =>
            Object.entries(args.index!.equalities).every(([field, expected]) => row[field as keyof typeof row] === expected),
          );
        }
        return {
          page,
          isDone: end >= users.length,
          continueCursor: String(end),
        };
      },
    };
    const sql = new SQL(
      {
        tables: {
          users: {
            columns: { email: "string", status: "string", age: "number" },
            indexes: { by_status: ["status"] },
          },
        },
      },
      { scanQuery, pageSize: 2 },
    );

    const rows = await sql(ctx, "SELECT COUNT(*) AS count FROM users WHERE status = 'active'");

    expect(rows).toEqual([{ count: 2 }]);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]?.index?.name).toBe("by_status");
  });
});
