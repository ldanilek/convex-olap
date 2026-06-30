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

    expect(ast.distinct).toBe(true);
    expect(ast.projections[0]?.alias).toBe("email");
    expect(ast.where?.type).toBe("binary");
  });
});
