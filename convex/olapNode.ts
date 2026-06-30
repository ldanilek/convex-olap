"use node";

import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { SQL } from "../src/index";
import schema from "./schema";

export const runInAction = actionGeneric({
  args: {
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const sql = new SQL(schema, {
      scanQuery: makeFunctionReference<"query">("olap:scan"),
      pageSize: 2,
    });
    return sql(ctx as any, args.source);
  },
});
