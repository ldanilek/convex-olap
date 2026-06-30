import { convexTest } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { describe, expect, test } from "vitest";
import { SQL, scanHandler, type ConvexLikeContext } from "../src/index.js";

const convexSchema = defineSchema({
  users: defineTable({
    email: v.string(),
    status: v.string(),
    age: v.number(),
  }).index("by_status", ["status"]),
});

const sqlSchema = {
  tables: {
    users: {
      columns: {
        email: "string",
        status: "string",
        age: "number",
      },
      indexes: {
        by_status: ["status"],
      },
    },
  },
};

describe("Convex runtime integration", () => {
  test("executes inside a Convex query context", async () => {
    const t = convexTest(convexSchema);
    await seedUsers(t);

    const rows = await t.query(async (ctx) => {
      const sql = new SQL(sqlSchema);
      return sql(ctx as ConvexLikeContext, "SELECT status, COUNT(*) AS count FROM users GROUP BY status ORDER BY count DESC");
    });

    expect(rows).toEqual([
      { status: "active", count: 2 },
      { status: "inactive", count: 1 },
    ]);
  });

  test("scanHandler pages Convex table rows for action-style execution", async () => {
    const t = convexTest(convexSchema);
    await seedUsers(t);

    const firstPage = await t.query((ctx) =>
      scanHandler(ctx, {
        tableName: "users",
        cursor: null,
        numItems: 2,
      }),
    );

    expect(firstPage.page).toHaveLength(2);
    expect(firstPage.isDone).toBe(false);
  });
});

async function seedUsers(t: ReturnType<typeof convexTest<typeof convexSchema>>): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("users", { email: "a@gmail.com", status: "active", age: 34 });
    await ctx.db.insert("users", { email: "b@example.com", status: "inactive", age: 17 });
    await ctx.db.insert("users", { email: "c@gmail.com", status: "active", age: 28 });
  });
}
