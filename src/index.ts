import { type SelectStatement } from "./ast.js";
import { type ConvexLikeContext, type ExecuteOptions, PlanExecutor, type Row } from "./executor.js";
import { parseSQL } from "./parser.js";
import { type QueryPlan, SQLPlanner } from "./planner.js";
import { type SchemaSpec } from "./schema.js";

export type SQLOptions = ExecuteOptions;

export type SQLCallable = {
  (ctx: ConvexLikeContext, source: string, options?: ExecuteOptions): Promise<Row[]>;
  parse(source: string): SelectStatement;
  plan(sourceOrAst: string | SelectStatement): QueryPlan;
  execute(ctx: ConvexLikeContext, sourceOrPlan: string | QueryPlan, options?: ExecuteOptions): Promise<Row[]>;
};

class SQLRuntime {
  private readonly planner: SQLPlanner;
  private readonly executor = new PlanExecutor();

  constructor(
    schema: SchemaSpec,
    private readonly defaults: SQLOptions = {},
  ) {
    this.planner = new SQLPlanner(schema);
  }

  parse(source: string): SelectStatement {
    return parseSQL(source);
  }

  plan(sourceOrAst: string | SelectStatement): QueryPlan {
    return this.planner.plan(typeof sourceOrAst === "string" ? this.parse(sourceOrAst) : sourceOrAst);
  }

  execute(ctx: ConvexLikeContext, sourceOrPlan: string | QueryPlan, options: ExecuteOptions = {}): Promise<Row[]> {
    const plan = typeof sourceOrPlan === "string" ? this.plan(sourceOrPlan) : sourceOrPlan;
    return this.executor.execute(ctx, plan, { ...this.defaults, ...options });
  }
}

function createSQL(schema: SchemaSpec, options: SQLOptions = {}): SQLCallable {
  const runtime = new SQLRuntime(schema, options);
  const callable = ((ctx: ConvexLikeContext, source: string, executeOptions?: ExecuteOptions) =>
    runtime.execute(ctx, source, executeOptions)) as SQLCallable;
  callable.parse = runtime.parse.bind(runtime);
  callable.plan = runtime.plan.bind(runtime);
  callable.execute = runtime.execute.bind(runtime);
  return callable;
}

export const SQL = createSQL as unknown as new (schema: SchemaSpec, options?: SQLOptions) => SQLCallable;

export { expressionToSQL, isAggregateExpression } from "./ast.js";
export type {
  BinaryExpression,
  CallExpression,
  Expression,
  IdentifierExpression,
  JoinRelation,
  JoinType,
  LiteralExpression,
  OrderBy,
  Projection,
  Relation,
  SelectStatement,
  TableRelation,
} from "./ast.js";
export { scanHandler, scanQuery } from "./convex.js";
export type { ConvexScanContext } from "./convex.js";
export type { ConvexLikeContext, ExecuteOptions, Row, ScanAdapter, ScanArgs, ScanFunction, ScanPage } from "./executor.js";
export type {
  AggregateNode,
  AggregatePlan,
  FilterNode,
  IndexUse,
  JoinNode,
  LimitNode,
  PlanNode,
  PlannedTable,
  ProjectNode,
  QueryPlan,
  ScanNode,
  SortNode,
} from "./planner.js";
export { SQLPlanner } from "./planner.js";
export type { ColumnSpec, IndexSpec, NormalizedSchema, SchemaSpec, TableSpec } from "./schema.js";
export { normalizeSchema } from "./schema.js";
