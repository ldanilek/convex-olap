import { queryGeneric } from "convex/server";
import { v } from "convex/values";
import { type ScanArgs, type ScanPage } from "./executor.js";

export type ConvexScanContext = {
  db: {
    query(tableName: string): {
      withIndex?: (indexName: string, callback?: (q: DynamicIndexBuilder) => unknown) => unknown;
      paginate: (options: { cursor: string | null; numItems: number }) => Promise<ScanPage>;
    };
  };
};

export type DynamicIndexBuilder = {
  eq(fieldName: string, value: unknown): unknown;
};

export async function scanHandler(ctx: ConvexScanContext, args: ScanArgs): Promise<ScanPage> {
  const query = ctx.db.query(args.tableName);
  const numItems = args.numItems ?? 256;
  const cursor = args.cursor ?? null;

  if (args.index && query.withIndex) {
    const indexed = query.withIndex(args.index.name, (q) => {
      let builder: any = q;
      for (const field of args.index!.fields) builder = builder.eq(field, args.index!.equalities[field]);
      return builder;
    }) as { paginate?: (options: { cursor: string | null; numItems: number }) => Promise<ScanPage> };
    if (indexed.paginate) return indexed.paginate({ cursor, numItems });
  }

  return query.paginate({ cursor, numItems });
}

export function scanQuery() {
  return queryGeneric({
    args: {
      tableName: v.string(),
      cursor: v.optional(v.union(v.string(), v.null())),
      numItems: v.optional(v.number()),
      index: v.optional(
        v.object({
          name: v.string(),
          fields: v.array(v.string()),
          equalities: v.any(),
        }),
      ),
    },
    handler: async (ctx, args) => scanHandler(ctx as any, args),
  });
}
