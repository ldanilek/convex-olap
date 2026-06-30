import { describe, expect, test } from "vitest";
import { SQL } from "../src/index.js";

const sql = new SQL({ tables: {} });

describe("SQL parser", () => {
  test("parses aggregate query with where, group by, having, order, and limit", () => {
    const ast = sql.parse(`
      SELECT status, COUNT(*) AS count, AVG(age) avg_age
      FROM users
      WHERE email LIKE '%@gmail.com' AND age >= 18
      GROUP BY status
      HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT 10 OFFSET 5
    `);

    expect(ast.type).toBe("select");
    if (ast.type !== "select") throw new Error("expected select");
    expect(ast.projections).toHaveLength(3);
    expect(ast.projections[1]?.alias).toBe("count");
    expect(ast.groupBy).toHaveLength(1);
    expect(ast.orderBy[0]?.direction).toBe("desc");
    expect(ast.limit).toBe(10);
    expect(ast.offset).toBe(5);
  });

  test("parses joins and qualified identifiers", () => {
    const ast = sql.parse(`
      SELECT u.email, o.total
      FROM users AS u
      LEFT JOIN orders o ON u._id = o.userId
      WHERE o.total BETWEEN 10 AND 100
    `);

    expect(ast.type).toBe("select");
    if (ast.type !== "select") throw new Error("expected select");
    expect(ast.from?.type).toBe("join");
    if (ast.from?.type !== "join") throw new Error("expected join");
    expect(ast.from.joinType).toBe("left");
    expect(ast.from.on?.type).toBe("binary");
    expect(ast.where?.type).toBe("between");
  });

  test("parses distinct, in, is null, and quoted identifiers", () => {
    const ast = sql.parse(`
      SELECT DISTINCT "user".email AS email
      FROM "user"
      WHERE deletedAt IS NULL OR status IN ('active', 'trial')
    `);

    expect(ast.type).toBe("select");
    if (ast.type !== "select") throw new Error("expected select");
    expect(ast.distinct).toBe(true);
    expect(ast.projections[0]?.alias).toBe("email");
    expect(ast.where?.type).toBe("binary");
  });

  test("parses with clauses, union, subqueries, exists, and quantified predicates", () => {
    const ast = sql.parse(`
      WITH active_users AS (
        SELECT email, age FROM users WHERE status = 'active'
      )
      SELECT email FROM active_users
      WHERE EXISTS (SELECT email FROM orders WHERE orders.userEmail = active_users.email)
        AND age >= ALL (SELECT age FROM users WHERE status = 'inactive')
      UNION
      SELECT email FROM users WHERE age = ANY (SELECT age FROM active_users)
    `);

    expect(ast.type).toBe("setOperation");
    if (ast.type !== "setOperation") throw new Error("expected set operation");
    expect(ast.operator).toBe("UNION");
    expect(ast.with[0]?.name).toBe("active_users");
    expect(ast.left.type).toBe("select");
    expect(ast.right.type).toBe("select");
  });

  test("parses subquery relations and IN subqueries", () => {
    const ast = sql.parse(`
      SELECT recent.email
      FROM (SELECT email FROM users WHERE age > 20) AS recent
      WHERE recent.email IN (SELECT userEmail FROM orders)
    `);

    expect(ast.type).toBe("select");
    if (ast.type !== "select") throw new Error("expected select");
    expect(ast.from?.type).toBe("subquery");
    expect(ast.where?.type).toBe("in");
  });
});
