# convex-olap

SQL-style OLAP helpers for Convex apps.

This package parses a SQL subset, compiles it into an inspectable query plan using schema and index metadata, and executes the plan against a potentially stale Convex view by scanning tables from a query or action.

```ts
import { SQL } from "convex-olap";

const convexSQL = new SQL({
  tables: {
    users: {
      columns: { email: "string", status: "string" },
      indexes: { by_status: ["status"] },
    },
  },
});

const results = await convexSQL(
  ctx,
  "SELECT COUNT(*) AS count FROM users WHERE email LIKE '%@gmail.com'",
);
```

## Supported SQL shape

The initial parser and planner support:

- `SELECT`, `DISTINCT`, aliases, `*`, and qualified `table.*`
- `FROM`
- `INNER`, `LEFT`, `RIGHT`, `FULL`, and `CROSS` joins with `ON`
- `WHERE` with `AND`, `OR`, `NOT`, comparison operators, `LIKE`, `BETWEEN`, `IN`, and `IS NULL`
- arithmetic expressions
- aggregate calls: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`
- `GROUP BY` and `HAVING`
- `ORDER BY`, `LIMIT`, and `OFFSET`

The planner does not use table sizes or stats. It only uses the provided schema/index metadata to annotate scans with usable equality-prefix indexes.

## Running from Convex actions

Convex actions do not expose `ctx.db`, so action execution needs a scan query reference or adapter. Register a query in your Convex app that delegates to the package scan handler:

```ts
// convex/olap.ts
import { v } from "convex/values";
import { query } from "./_generated/server";
import { scanHandler } from "convex-olap";

export const scan = query({
  args: {
    tableName: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.optional(v.number()),
    index: v.optional(
      v.object({
        name: v.string(),
        fields: v.array(v.string()),
        equalities: v.record(v.string(), v.any()),
      }),
    ),
  },
  handler: scanHandler,
});
```

Then configure the SQL runner with that function reference:

```ts
import { api } from "./_generated/api";
import { SQL } from "convex-olap";

const convexSQL = new SQL(schemaMetadata, { scanQuery: api.olap.scan });

export const report = action({
  args: {},
  handler: async (ctx) => {
    return convexSQL(ctx, "SELECT status, COUNT(*) AS count FROM users GROUP BY status");
  },
});
```

In tests or non-Convex contexts, pass `scan` as an adapter that returns rows or paginated pages.

## Inspecting plans

```ts
const plan = convexSQL.plan(`
  SELECT status, COUNT(*) AS count
  FROM users
  WHERE status = 'active'
  GROUP BY status
`);

console.log(plan.tables[0]?.index);
```

## Materializing from node actions

Node actions can write materialized results to the filesystem:

```ts
import { materializePlanToFile } from "convex-olap/node";

const plan = convexSQL.plan("SELECT * FROM users");
await materializePlanToFile(ctx, plan, "/tmp/users.json", {
  scanQuery: api.olap.scan,
});
```

## Development

```sh
npm ci
npm run typecheck
npm run test
npm run test:local-backend
npm run build
```

`npm run test:local-backend` starts an anonymous Convex OSS backend on
`http://127.0.0.1:3210`, deploys the `convex/` test app, and runs the HTTP
e2e tests against that local backend.
