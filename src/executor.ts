import { type Expression, expressionToSQL } from "./ast.js";
import { aggregateValue, compareValues, evaluateExpression, projectRow, type Row, truthy } from "./evaluate.js";
import { type AggregatePlan, type IndexUse, type PlanNode, type QueryPlan } from "./planner.js";

export type { Row } from "./evaluate.js";

export type ScanPage = {
  page: Record<string, unknown>[];
  isDone?: boolean;
  continueCursor?: string | null;
};

export type ScanArgs = {
  tableName: string;
  index?: IndexUse;
  cursor?: string | null;
  numItems?: number;
};

export type ScanFunction = (args: ScanArgs) => Promise<Record<string, unknown>[] | ScanPage>;
export type ScanAdapter = ScanFunction;

export type ExecuteOptions = {
  scan?: ScanFunction;
  scanQuery?: unknown;
  pageSize?: number;
};

export type ConvexLikeContext = {
  db?: {
    query(tableName: string): {
      withIndex?: (indexName: string, callback?: (q: DynamicIndexBuilder) => unknown) => unknown;
      collect?: () => Promise<Record<string, unknown>[]>;
      paginate?: (options: { cursor: string | null; numItems: number }) => Promise<ScanPage>;
    };
  };
  runQuery?: (query: unknown, args: ScanArgs) => Promise<Record<string, unknown>[] | ScanPage>;
};

export type DynamicIndexBuilder = {
  eq(fieldName: string, value: unknown): unknown;
};

export class PlanExecutor {
  async execute(ctx: ConvexLikeContext, plan: QueryPlan, options: ExecuteOptions = {}): Promise<Row[]> {
    return this.executeNode(ctx, plan.root, options);
  }

  private async executeNode(ctx: ConvexLikeContext, node: PlanNode, options: ExecuteOptions): Promise<Row[]> {
    switch (node.type) {
      case "empty":
        return [{}];
      case "scan":
        return (await this.scan(ctx, node.tableName, node.alias, node.index, options)).map((doc) =>
          documentToRow(doc, node.alias),
        );
      case "filter":
        return (await this.executeNode(ctx, node.input, options)).filter((row) => truthy(evaluateExpression(node.predicate, row)));
      case "join":
        return this.executeJoin(ctx, node, options);
      case "aggregate":
        return this.executeAggregate(ctx, node.input, node.groupBy, node.aggregates, node.having, options);
      case "project": {
        const rows = (await this.executeNode(ctx, node.input, options)).map((row) => projectRow(row, node.projections));
        return node.distinct ? distinctRows(rows) : rows;
      }
      case "sort": {
        const rows = await this.executeNode(ctx, node.input, options);
        return rows.sort((left, right) => {
          for (const order of node.orderBy) {
            const comparison = compareValues(evaluateExpression(order.expression, left), evaluateExpression(order.expression, right));
            if (comparison !== 0) return order.direction === "desc" ? -comparison : comparison;
          }
          return 0;
        });
      }
      case "limit": {
        const rows = await this.executeNode(ctx, node.input, options);
        const offset = node.offset ?? 0;
        return rows.slice(offset, node.limit === undefined ? undefined : offset + node.limit);
      }
    }
  }

  private async executeJoin(
    ctx: ConvexLikeContext,
    node: Extract<PlanNode, { type: "join" }>,
    options: ExecuteOptions,
  ): Promise<Row[]> {
    const leftRows = await this.executeNode(ctx, node.left, options);
    const rightRows = await this.executeNode(ctx, node.right, options);
    const joined: Row[] = [];
    const matchedRight = new Set<number>();

    for (const left of leftRows) {
      let matched = false;
      for (const [rightIndex, right] of rightRows.entries()) {
        const row = { ...left, ...right };
        if (!node.on || truthy(evaluateExpression(node.on, row))) {
          joined.push(row);
          matched = true;
          matchedRight.add(rightIndex);
        }
      }
      if (!matched && (node.joinType === "left" || node.joinType === "full")) {
        joined.push(left);
      }
    }

    if (node.joinType === "right" || node.joinType === "full") {
      for (const [rightIndex, right] of rightRows.entries()) {
        if (!matchedRight.has(rightIndex)) joined.push(right);
      }
    }

    return joined;
  }

  private async executeAggregate(
    ctx: ConvexLikeContext,
    input: PlanNode,
    groupBy: Expression[],
    aggregates: AggregatePlan[],
    having: Expression | undefined,
    options: ExecuteOptions,
  ): Promise<Row[]> {
    const rows = await this.executeNode(ctx, input, options);
    const groups = new Map<string, { keys: unknown[]; rows: Row[] }>();

    for (const row of rows) {
      const keys = groupBy.map((expression) => evaluateExpression(expression, row));
      const key = JSON.stringify(keys);
      const group = groups.get(key);
      if (group) group.rows.push(row);
      else groups.set(key, { keys, rows: [row] });
    }

    if (groups.size === 0 && groupBy.length === 0) {
      groups.set("[]", { keys: [], rows: [] });
    }

    const output: Row[] = [];
    for (const group of groups.values()) {
      const row: Row = group.rows[0] ? { ...group.rows[0] } : {};
      groupBy.forEach((expression, index) => {
        row[expressionToSQL(expression)] = group.keys[index];
        if (expression.type === "identifier") row[expression.name] = group.keys[index];
      });
      for (const aggregate of aggregates) {
        row[aggregate.key] = aggregateValue(aggregate.expression as Extract<Expression, { type: "call" }>, group.rows);
      }
      if (!having || truthy(evaluateExpression(having, row))) output.push(row);
    }

    return output;
  }

  private async scan(
    ctx: ConvexLikeContext,
    tableName: string,
    alias: string,
    index: IndexUse | undefined,
    options: ExecuteOptions,
  ): Promise<Record<string, unknown>[]> {
    const scan = options.scan ?? (options.scanQuery ? scanViaFunction(ctx, options.scanQuery) : undefined);
    if (scan) return collectPages(scan, { tableName, index }, options.pageSize);
    if (ctx.db) return scanViaDb(ctx, tableName, index);
    throw new Error(
      `Cannot scan table "${tableName}" for alias "${alias}". Provide a query context, custom scan function, or scanQuery function reference.`,
    );
  }
}

function documentToRow(doc: Record<string, unknown>, alias: string): Row {
  const row: Row = {};
  for (const [key, value] of Object.entries(doc)) {
    row[key] = value;
    row[`${alias}.${key}`] = value;
  }
  return row;
}

function distinctRows(rows: Row[]): Row[] {
  const seen = new Set<string>();
  const distinct: Row[] = [];
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(row);
  }
  return distinct;
}

function scanViaFunction(ctx: ConvexLikeContext, scanQuery: unknown): ScanFunction {
  if (!ctx.runQuery) throw new Error("scanQuery execution requires an action context with ctx.runQuery.");
  return (args) => ctx.runQuery!(scanQuery, args);
}

async function collectPages(scan: ScanFunction, args: ScanArgs, pageSize = 256): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null | undefined = args.cursor ?? null;

  while (true) {
    const result = await scan({ ...args, cursor, numItems: pageSize });
    if (Array.isArray(result)) {
      rows.push(...result);
      return rows;
    }
    rows.push(...result.page);
    if (result.isDone || !result.continueCursor) return rows;
    cursor = result.continueCursor;
  }
}

async function scanViaDb(
  ctx: ConvexLikeContext,
  tableName: string,
  index: IndexUse | undefined,
): Promise<Record<string, unknown>[]> {
  const query = ctx.db!.query(tableName);
  if (index && query.withIndex) {
    const indexed = query.withIndex(index.name, (q) => {
      let builder: any = q;
      for (const field of index.fields) builder = builder.eq(field, index.equalities[field]);
      return builder;
    }) as { collect?: () => Promise<Record<string, unknown>[]> };
    if (indexed.collect) return indexed.collect();
  }
  if (!query.collect) throw new Error(`Convex query for table "${tableName}" does not support collect().`);
  return query.collect();
}
