import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { SQL, scanQuery } from "../src/index";
import schema from "./schema";

export const seed = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    await clearTables(ctx);
    await ctx.db.insert("users", { email: "a@gmail.com", status: "active", age: 34 });
    await ctx.db.insert("users", { email: "b@example.com", status: "inactive", age: 17 });
    await ctx.db.insert("users", { email: "c@gmail.com", status: "active", age: 28 });
    await ctx.db.insert("orders", { userEmail: "a@gmail.com", total: 10 });
    await ctx.db.insert("orders", { userEmail: "a@gmail.com", total: 15 });
    await ctx.db.insert("orders", { userEmail: "c@gmail.com", total: 20 });
  },
});

export const clear = mutationGeneric({
  args: {},
  handler: clearTables,
});

export const scan = scanQuery();

export const runInQuery = queryGeneric({
  args: {
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const sql = new SQL(schema);
    return sql(ctx as any, args.source);
  },
});

async function clearTables(ctx: { db: any }) {
  for (const tableName of ["users", "orders"]) {
    const docs = await ctx.db.query(tableName).collect();
    await Promise.all(docs.map((doc: { _id: string }) => ctx.db.delete(doc._id)));
  }
}
