import { type Expression, expressionToSQL } from "./ast.js";
import {
  aggregateValue,
  compareValues,
  evaluateExpressionAsync,
  projectRowAsync,
  type Row,
  truthy,
} from "./evaluate.js";
import { type AggregatePlan, type IndexUse, type PlanNode, type QueryPlan, type SQLPlanner } from "./planner.js";

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

export type ExecuteOptions = {
  scanQuery?: unknown;
  pageSize?: number;
  maxRowsRead?: number;
  maxRowsBuffered?: number;
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

const DEFAULT_MAX_ROWS_READ = 10_000;
const DEFAULT_MAX_ROWS_BUFFERED = 10_000;

type ExecutionState = {
  ctes: Map<string, Row[]>;
  outerRow: Row;
};

export class PlanExecutor {
  constructor(private readonly planner?: SQLPlanner) {}

  async execute(ctx: ConvexLikeContext, plan: QueryPlan, options: ExecuteOptions = {}): Promise<Row[]> {
    return this.executePlan(ctx, plan, options, { ctes: new Map(), outerRow: {} });
  }

  private async executePlan(
    ctx: ConvexLikeContext,
    plan: QueryPlan,
    options: ExecuteOptions,
    state: ExecutionState,
  ): Promise<Row[]> {
    const ctes = new Map(state.ctes);
    for (const cte of plan.ctes) {
      ctes.set(cte.name, await this.executePlan(ctx, cte.plan, options, { ctes, outerRow: state.outerRow }));
    }
    return this.executeNode(ctx, plan.root, options, { ctes, outerRow: state.outerRow });
  }

  private async executeNode(
    ctx: ConvexLikeContext,
    node: PlanNode,
    options: ExecuteOptions,
    state: ExecutionState,
  ): Promise<Row[]> {
    switch (node.type) {
      case "empty":
        return [{ ...state.outerRow }];
      case "scan":
        return (await this.scan(ctx, node.tableName, node.alias, node.index, options, state)).map((doc) =>
          ({ ...state.outerRow, ...documentToRow(doc, node.alias) }),
        );
      case "subqueryScan": {
        const rows = await this.executePlan(ctx, node.plan, options, state);
        assertRowBudget(rows.length, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "subquery relation");
        return rows.map((row) => qualifyRow(row, node.alias, state.outerRow));
      }
      case "filter":
        return filterAsync(await this.executeNode(ctx, node.input, options, state), async (row) =>
          truthy(await this.evaluateExpression(ctx, node.predicate, row, options, state)),
        );
      case "join":
        return this.executeJoin(ctx, node, options, state);
      case "aggregate":
        return this.executeAggregate(ctx, node.input, node.groupBy, node.aggregates, node.having, options, state);
      case "project": {
        const rows = await Promise.all(
          (await this.executeNode(ctx, node.input, options, state)).map((row) =>
            projectRowAsync(row, node.projections, (query, outerRow) => this.executeSubquery(ctx, query, outerRow, options, state)),
          ),
        );
        assertRowBudget(rows.length, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "projection");
        return node.distinct ? distinctRows(rows) : rows;
      }
      case "sort": {
        const rows = await this.executeNode(ctx, node.input, options, state);
        assertRowBudget(rows.length, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "ORDER BY");
        const keyed = await Promise.all(
          rows.map(async (row) => ({
            row,
            keys: await Promise.all(
              node.orderBy.map((order) => this.evaluateExpression(ctx, order.expression, row, options, state)),
            ),
          })),
        );
        keyed.sort((left, right) => {
          for (const order of node.orderBy) {
            const index = node.orderBy.indexOf(order);
            const comparison = compareValues(left.keys[index], right.keys[index]);
            if (comparison !== 0) return order.direction === "desc" ? -comparison : comparison;
          }
          return 0;
        });
        return keyed.map((entry) => entry.row);
      }
      case "limit": {
        const rows = await this.executeNode(ctx, node.input, options, state);
        const offset = node.offset ?? 0;
        return rows.slice(offset, node.limit === undefined ? undefined : offset + node.limit);
      }
      case "union": {
        const rows = [
          ...(await this.executeNode(ctx, node.left, options, state)),
          ...(await this.executeNode(ctx, node.right, options, state)),
        ];
        assertRowBudget(rows.length, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "UNION");
        return node.all ? rows : distinctRows(rows);
      }
    }
  }

  private async executeJoin(
    ctx: ConvexLikeContext,
    node: Extract<PlanNode, { type: "join" }>,
    options: ExecuteOptions,
    state: ExecutionState,
  ): Promise<Row[]> {
    const leftRows = await this.executeNode(ctx, node.left, options, state);
    const rightRows = await this.executeNode(ctx, node.right, options, state);
    assertRowBudget(leftRows.length + rightRows.length, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "JOIN inputs");
    const joined: Row[] = [];
    const matchedRight = new Set<number>();

    for (const left of leftRows) {
      let matched = false;
      for (const [rightIndex, right] of rightRows.entries()) {
        const row = { ...left, ...right };
        if (!node.on || truthy(await this.evaluateExpression(ctx, node.on, row, options, state))) {
          joined.push(row);
          assertRowBudget(joined.length, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "JOIN output");
          matched = true;
          matchedRight.add(rightIndex);
        }
      }
      if (!matched && (node.joinType === "left" || node.joinType === "full")) {
        joined.push(left);
        assertRowBudget(joined.length, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "JOIN output");
      }
    }

    if (node.joinType === "right" || node.joinType === "full") {
      for (const [rightIndex, right] of rightRows.entries()) {
        if (!matchedRight.has(rightIndex)) {
          joined.push(right);
          assertRowBudget(joined.length, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "JOIN output");
        }
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
    state: ExecutionState,
  ): Promise<Row[]> {
    const rows = await this.executeNode(ctx, input, options, state);
    assertRowBudget(rows.length, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "aggregate input");
    const groups = new Map<string, { keys: unknown[]; rows: Row[] }>();

    for (const row of rows) {
      const keys = await Promise.all(groupBy.map((expression) => this.evaluateExpression(ctx, expression, row, options, state)));
      const key = JSON.stringify(keys);
      const group = groups.get(key);
      if (group) group.rows.push(row);
      else groups.set(key, { keys, rows: [row] });
      assertRowBudget(groups.size, options.maxRowsBuffered, DEFAULT_MAX_ROWS_BUFFERED, "aggregate groups");
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
      if (!having || truthy(await this.evaluateExpression(ctx, having, row, options, state))) output.push(row);
    }

    return output;
  }

  private async scan(
    ctx: ConvexLikeContext,
    tableName: string,
    alias: string,
    index: IndexUse | undefined,
    options: ExecuteOptions,
    state: ExecutionState,
  ): Promise<Record<string, unknown>[]> {
    if (state.ctes.has(tableName)) {
      const rows = state.ctes.get(tableName)!;
      assertRowBudget(rows.length, options.maxRowsRead, DEFAULT_MAX_ROWS_READ, `CTE ${tableName}`);
      return rows;
    }
    const scan = options.scanQuery ? scanViaFunction(ctx, options.scanQuery) : undefined;
    if (scan) return collectPages(scan, { tableName, index }, options);
    if (ctx.db) {
      const rows = await scanViaDb(ctx, tableName, index);
      assertRowBudget(rows.length, options.maxRowsRead, DEFAULT_MAX_ROWS_READ, `scan of ${tableName}`);
      return rows;
    }
    throw new Error(
      `Cannot scan table "${tableName}" for alias "${alias}". Provide a query context or scanQuery function reference.`,
    );
  }

  private evaluateExpression(
    ctx: ConvexLikeContext,
    expression: Expression,
    row: Row,
    options: ExecuteOptions,
    state: ExecutionState,
  ): Promise<unknown> {
    return evaluateExpressionAsync(expression, row, (query, outerRow) =>
      this.executeSubquery(ctx, query, outerRow, options, state),
    );
  }

  private executeSubquery(
    ctx: ConvexLikeContext,
    query: import("./ast.js").QueryStatement,
    outerRow: Row,
    options: ExecuteOptions,
    state: ExecutionState,
  ): Promise<Row[]> {
    if (!this.planner) throw new Error("Subquery execution requires a SQL planner.");
    return this.executePlan(ctx, this.planner.plan(query), options, { ctes: state.ctes, outerRow });
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

function qualifyRow(row: Row, alias: string, outerRow: Row): Row {
  const qualified: Row = { ...outerRow };
  for (const [key, value] of Object.entries(row)) {
    if (Object.hasOwn(outerRow, key)) continue;
    qualified[key] = value;
    qualified[`${alias}.${key}`] = value;
  }
  return qualified;
}

async function filterAsync<T>(values: T[], predicate: (value: T) => Promise<boolean>): Promise<T[]> {
  const keep = await Promise.all(values.map(predicate));
  return values.filter((_, index) => keep[index]);
}

type PageFetcher = (args: ScanArgs) => Promise<Record<string, unknown>[] | ScanPage>;

function scanViaFunction(ctx: ConvexLikeContext, scanQuery: unknown): PageFetcher {
  if (!ctx.runQuery) throw new Error("scanQuery execution requires an action context with ctx.runQuery.");
  return (args) => ctx.runQuery!(scanQuery, args);
}

async function collectPages(scan: PageFetcher, args: ScanArgs, options: ExecuteOptions): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null | undefined = args.cursor ?? null;
  const pageSize = options.pageSize ?? 256;

  while (true) {
    const result = await scan({ ...args, cursor, numItems: pageSize });
    if (Array.isArray(result)) {
      rows.push(...result);
      assertRowBudget(rows.length, options.maxRowsRead, DEFAULT_MAX_ROWS_READ, `scan of ${args.tableName}`);
      return rows;
    }
    rows.push(...result.page);
    assertRowBudget(rows.length, options.maxRowsRead, DEFAULT_MAX_ROWS_READ, `scan of ${args.tableName}`);
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

function assertRowBudget(
  count: number,
  configuredLimit: number | undefined,
  defaultLimit: number,
  operation: string,
): void {
  const limit = configuredLimit ?? defaultLimit;
  if (count > limit) {
    throw new Error(
      `${operation} buffered ${count} rows, exceeding the configured limit of ${limit}. Add a selective predicate/index, lower page size, increase maxRowsBuffered/maxRowsRead, or run a future node spill executor for this plan.`,
    );
  }
}
