import { describe, expect, test } from "vitest";
import { SQL } from "../src/index.js";

const schema = {
  tables: {
    users: {
      columns: {
        _id: "id",
        email: "string",
        status: "string",
        age: "number",
      },
      indexes: {
        by_status: ["status"],
      },
    },
    orders: {
      columns: {
        _id: "id",
        userId: "id",
        total: "number",
      },
      indexes: {
        by_user: ["userId"],
      },
    },
  },
};

const data: Record<string, Record<string, unknown>[]> = {
  users: [
    { _id: "u1", email: "a@gmail.com", status: "active", age: 34 },
    { _id: "u2", email: "b@example.com", status: "inactive", age: 17 },
    { _id: "u3", email: "c@gmail.com", status: "active", age: 28 },
  ],
  orders: [
    { _id: "o1", userId: "u1", total: 10 },
    { _id: "o2", userId: "u1", total: 15 },
    { _id: "o3", userId: "u3", total: 20 },
  ],
};

const ctx = {
  db: {
    query(tableName: string) {
      return {
        withIndex(_indexName: string, callback?: (q: any) => unknown) {
          const equalities: Record<string, unknown> = {};
          const builder = {
            eq(field: string, value: unknown) {
              equalities[field] = value;
              return builder;
            },
          };
          callback?.(builder);
          return {
            async collect() {
              return (data[tableName] ?? []).filter((row) =>
                Object.entries(equalities).every(([field, expected]) => row[field] === expected),
              );
            },
          };
        },
        async collect() {
          return data[tableName] ?? [];
        },
      };
    },
  },
};

describe("SQL executor", () => {
  test("executes count with like predicate", async () => {
    const sql = new SQL(schema);
    const rows = await sql(ctx, "SELECT COUNT(*) AS count FROM users WHERE email LIKE '%@gmail.com'");

    expect(rows).toEqual([{ count: 2 }]);
  });

  test("executes group by with aggregate and having", async () => {
    const sql = new SQL(schema);
    const rows = await sql(
      ctx,
      `
        SELECT status, COUNT(*) AS count, AVG(age) AS avgAge
        FROM users
        GROUP BY status
        HAVING COUNT(*) >= 1
        ORDER BY count DESC
      `,
    );

    expect(rows).toEqual([
      { status: "active", count: 2, avgAge: 31 },
      { status: "inactive", count: 1, avgAge: 17 },
    ]);
  });

  test("executes joins and ordering", async () => {
    const sql = new SQL(schema);
    const rows = await sql(
      ctx,
      `
        SELECT u.email AS email, SUM(o.total) AS revenue
        FROM users u
        JOIN orders o ON u._id = o.userId
        GROUP BY u.email
        ORDER BY revenue DESC
        LIMIT 2
      `,
    );

    expect(rows).toEqual([
      { email: "a@gmail.com", revenue: 25 },
      { email: "c@gmail.com", revenue: 20 },
    ]);
  });

  test("uses index metadata when the query context supports withIndex", async () => {
    const sql = new SQL(schema);
    const rows = await sql(ctx, "SELECT COUNT(*) AS count FROM users WHERE status = 'active'");
    expect(rows).toEqual([{ count: 2 }]);
  });
});
