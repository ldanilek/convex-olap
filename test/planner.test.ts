import { describe, expect, test } from "vitest";
import { SQL } from "../src/index.js";

const schema = {
  tables: {
    users: {
      columns: {
        email: "string",
        status: "string",
        age: "number",
      },
      indexes: {
        by_status_email: ["status", "email"],
        by_email: ["email"],
      },
    },
    orders: {
      columns: {
        userId: "id",
        total: "number",
      },
      indexes: {
        by_user: ["userId"],
      },
    },
  },
};

describe("SQL planner", () => {
  test("selects longest equality-prefix index from schema metadata", () => {
    const sql = new SQL(schema);
    const plan = sql.plan(`
      SELECT email
      FROM users
      WHERE status = 'active' AND email = 'a@example.com'
    `);

    expect(plan.tables[0]?.index).toEqual({
      name: "by_status_email",
      fields: ["status", "email"],
      equalities: { status: "active", email: "a@example.com" },
    });
    expect(plan.executionMode).toBe("singleQuery");
  });

  test("plans joins and aggregates as action loop work", () => {
    const sql = new SQL(schema);
    const plan = sql.plan(`
      SELECT users.status, SUM(orders.total) AS revenue
      FROM users
      JOIN orders ON users._id = orders.userId
      GROUP BY users.status
    `);

    expect(plan.tables.map((table) => table.tableName)).toEqual(["users", "orders"]);
    expect(plan.aggregates.map((aggregate) => aggregate.functionName)).toEqual(["SUM"]);
    expect(plan.executionMode).toBe("actionLoop");
    expect(plan.root.type).toBe("project");
  });

  test("warns when schema metadata is missing", () => {
    const sql = new SQL({ tables: {} });
    const plan = sql.plan("SELECT * FROM missing");

    expect(plan.warnings).toContain('Table "missing" was not found in the provided schema metadata.');
  });
});
