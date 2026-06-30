import { type QueryStatement } from "./ast.js";
import { type ConvexLikeContext, type ExecuteOptions, PlanExecutor, type Row } from "./executor.js";
import { parseSQL } from "./parser.js";
import { type QueryPlan, SQLPlanner } from "./planner.js";
import { type SchemaSpec } from "./schema.js";

export type SQLOptions = ExecuteOptions;

export type SQLCallable = {
  (ctx: ConvexLikeContext, source: string, options?: ExecuteOptions): Promise<Row[]>;
  parse(source: string): QueryStatement;
  plan(sourceOrAst: string | QueryStatement): QueryPlan;
  execute(ctx: ConvexLikeContext, sourceOrPlan: string | QueryPlan, options?: ExecuteOptions): Promise<Row[]>;
};

class SQLRuntime {
  private readonly planner: SQLPlanner;
  private readonly executor: PlanExecutor;

  constructor(
    schema: SchemaSpec,
    private readonly defaults: SQLOptions = {},
  ) {
    this.planner = new SQLPlanner(schema);
    this.executor = new PlanExecutor(this.planner);
  }

  parse(source: string): QueryStatement {
    return parseSQL(source);
  }

  plan(sourceOrAst: string | QueryStatement): QueryPlan {
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
  CommonTableExpression,
  Expression,
  IdentifierExpression,
  JoinRelation,
  JoinType,
  LiteralExpression,
  OrderBy,
  Projection,
  QueryStatement,
  Relation,
  SelectStatement,
  SetOperationStatement,
  SubqueryRelation,
  TableRelation,
} from "./ast.js";
export { scanHandler, scanQuery } from "./convex.js";
export type { ConvexScanContext } from "./convex.js";
export type { ConvexLikeContext, ExecuteOptions, Row, ScanArgs, ScanPage } from "./executor.js";
export type {
  AggregateNode,
  AggregatePlan,
  AggregatePushdown,
  CtePlan,
  FilterNode,
  IndexUse,
  JoinNode,
  JoinPushdown,
  LimitNode,
  PlanNode,
  PlannedTable,
  ProjectNode,
  PushdownPlan,
  QueryPlan,
  ScanNode,
  SortNode,
  SortPushdown,
  StoragePlan,
  SubqueryScanNode,
  UnionNode,
} from "./planner.js";
export { SQLPlanner } from "./planner.js";
export type { ColumnSpec, IndexSpec, NormalizedSchema, SchemaSpec, TableSpec } from "./schema.js";
export { normalizeSchema } from "./schema.js";
