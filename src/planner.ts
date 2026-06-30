import {
  aggregateFunctions,
  type BinaryExpression,
  type Expression,
  expressionToSQL,
  isAggregateExpression,
  type JoinType,
  type OrderBy,
  type Projection,
  type Relation,
  type SelectStatement,
} from "./ast.js";
import { type NormalizedIndex, type NormalizedSchema, normalizeSchema, type SchemaSpec } from "./schema.js";

export type QueryPlan = {
  type: "query";
  ast: SelectStatement;
  root: PlanNode;
  tables: PlannedTable[];
  aggregates: AggregatePlan[];
  executionMode: "singleQuery" | "actionLoop" | "materialize";
  warnings: string[];
};

export type PlannedTable = {
  tableName: string;
  alias: string;
  index?: IndexUse;
};

export type IndexUse = {
  name: string;
  fields: string[];
  equalities: Record<string, unknown>;
};

export type AggregatePlan = {
  key: string;
  functionName: string;
  expression: Expression;
  distinct: boolean;
};

export type PlanNode =
  | ScanNode
  | JoinNode
  | FilterNode
  | AggregateNode
  | ProjectNode
  | SortNode
  | LimitNode
  | EmptyNode;

export type EmptyNode = {
  type: "empty";
};

export type ScanNode = {
  type: "scan";
  tableName: string;
  alias: string;
  index?: IndexUse;
};

export type JoinNode = {
  type: "join";
  joinType: JoinType;
  algorithm: "nestedLoop" | "indexedNestedLoop";
  left: PlanNode;
  right: PlanNode;
  on?: Expression;
};

export type FilterNode = {
  type: "filter";
  input: PlanNode;
  predicate: Expression;
};

export type AggregateNode = {
  type: "aggregate";
  input: PlanNode;
  groupBy: Expression[];
  aggregates: AggregatePlan[];
  having?: Expression;
};

export type ProjectNode = {
  type: "project";
  input: PlanNode;
  projections: Projection[];
  distinct: boolean;
};

export type SortNode = {
  type: "sort";
  input: PlanNode;
  orderBy: OrderBy[];
};

export type LimitNode = {
  type: "limit";
  input: PlanNode;
  limit?: number;
  offset?: number;
};

export class SQLPlanner {
  readonly schema: NormalizedSchema;

  constructor(schema: SchemaSpec) {
    this.schema = normalizeSchema(schema);
  }

  plan(ast: SelectStatement): QueryPlan {
    const warnings: string[] = [];
    const tables: PlannedTable[] = [];
    const aggregates = collectAggregates(ast);
    let root = ast.from ? this.planRelation(ast.from, ast.where, tables, warnings) : ({ type: "empty" } satisfies EmptyNode);

    if (ast.where) {
      root = { type: "filter", input: root, predicate: ast.where };
    }

    const requiresAggregate = ast.groupBy.length > 0 || aggregates.length > 0 || Boolean(ast.having);
    if (requiresAggregate) {
      root = { type: "aggregate", input: root, groupBy: ast.groupBy, aggregates, having: ast.having };
    }

    root = { type: "project", input: root, projections: ast.projections, distinct: ast.distinct };

    if (ast.orderBy.length > 0) {
      root = { type: "sort", input: root, orderBy: ast.orderBy };
    }

    if (ast.limit !== undefined || ast.offset !== undefined) {
      root = { type: "limit", input: root, limit: ast.limit, offset: ast.offset };
    }

    return {
      type: "query",
      ast,
      root,
      tables,
      aggregates,
      executionMode: chooseExecutionMode(ast, tables),
      warnings,
    };
  }

  private planRelation(
    relation: Relation,
    where: Expression | undefined,
    tables: PlannedTable[],
    warnings: string[],
  ): PlanNode {
    if (relation.type === "join") {
      const left = this.planRelation(relation.left, where, tables, warnings);
      const right = this.planRelation(relation.right, where, tables, warnings);
      return {
        type: "join",
        joinType: relation.joinType,
        algorithm: relation.on && hasEqualityPredicate(relation.on) ? "indexedNestedLoop" : "nestedLoop",
        left,
        right,
        on: relation.on,
      };
    }

    const alias = relation.alias ?? relation.name;
    const tableSchema = this.schema.tables[relation.name];
    if (!tableSchema) {
      warnings.push(`Table "${relation.name}" was not found in the provided schema metadata.`);
    }
    const index = tableSchema ? chooseIndex(tableSchema.indexes, alias, relation.name, where) : undefined;
    const plannedTable = { tableName: relation.name, alias, index };
    tables.push(plannedTable);
    return { type: "scan", ...plannedTable };
  }
}

function chooseExecutionMode(ast: SelectStatement, tables: PlannedTable[]): QueryPlan["executionMode"] {
  if (tables.length <= 1 && ast.orderBy.length === 0) return "singleQuery";
  if (tables.length <= 2 && !ast.distinct) return "actionLoop";
  return "materialize";
}

function chooseIndex(
  indexes: NormalizedIndex[],
  alias: string,
  tableName: string,
  where: Expression | undefined,
): IndexUse | undefined {
  if (!where) return undefined;
  const equalities = collectLiteralEqualities(where, alias, tableName);
  let best: IndexUse | undefined;

  for (const index of indexes) {
    const usableFields: string[] = [];
    const usableEqualities: Record<string, unknown> = {};
    for (const field of index.fields) {
      if (!equalities.has(field)) break;
      usableFields.push(field);
      usableEqualities[field] = equalities.get(field);
    }
    if (usableFields.length > 0 && (!best || usableFields.length > best.fields.length)) {
      best = { name: index.name, fields: usableFields, equalities: usableEqualities };
    }
  }

  return best;
}

function collectLiteralEqualities(expression: Expression, alias: string, tableName: string): Map<string, unknown> {
  const equalities = new Map<string, unknown>();

  function visit(current: Expression): void {
    if (current.type === "binary" && current.operator === "AND") {
      visit(current.left);
      visit(current.right);
      return;
    }
    if (current.type !== "binary" || current.operator !== "=") return;
    const equality = literalEquality(current, alias, tableName);
    if (equality) equalities.set(equality.field, equality.value);
  }

  visit(expression);
  return equalities;
}

function literalEquality(
  expression: BinaryExpression,
  alias: string,
  tableName: string,
): { field: string; value: unknown } | undefined {
  const left = identifierForTable(expression.left, alias, tableName);
  if (left && expression.right.type === "literal") return { field: left, value: expression.right.value };
  const right = identifierForTable(expression.right, alias, tableName);
  if (right && expression.left.type === "literal") return { field: right, value: expression.left.value };
  return undefined;
}

function identifierForTable(expression: Expression, alias: string, tableName: string): string | undefined {
  if (expression.type !== "identifier") return undefined;
  if (!expression.table) return expression.name;
  if (expression.table === alias || expression.table === tableName) return expression.name;
  return undefined;
}

function hasEqualityPredicate(expression: Expression): boolean {
  if (expression.type === "binary" && expression.operator === "=") return true;
  if (expression.type === "binary" && (expression.operator === "AND" || expression.operator === "OR")) {
    return hasEqualityPredicate(expression.left) || hasEqualityPredicate(expression.right);
  }
  return false;
}

function collectAggregates(ast: SelectStatement): AggregatePlan[] {
  const seen = new Map<string, AggregatePlan>();
  const visit = (expression: Expression): void => {
    if (expression.type === "call" && aggregateFunctions.has(expression.name.toUpperCase())) {
      const key = expressionToSQL(expression);
      seen.set(key, {
        key,
        functionName: expression.name.toUpperCase(),
        expression,
        distinct: expression.distinct,
      });
      return;
    }
    switch (expression.type) {
      case "binary":
        visit(expression.left);
        visit(expression.right);
        break;
      case "unary":
        visit(expression.expression);
        break;
      case "like":
        visit(expression.expression);
        visit(expression.pattern);
        break;
      case "between":
        visit(expression.expression);
        visit(expression.lower);
        visit(expression.upper);
        break;
      case "in":
        visit(expression.expression);
        expression.values.forEach(visit);
        break;
      case "isNull":
        visit(expression.expression);
        break;
      default:
        break;
    }
  };

  ast.projections.forEach((projection) => visit(projection.expression));
  ast.having && visit(ast.having);
  ast.orderBy.forEach((order) => visit(order.expression));

  if (ast.groupBy.length === 0) {
    for (const projection of ast.projections) {
      if (projection.expression.type !== "star" && !isAggregateExpression(projection.expression)) {
        break;
      }
    }
  }

  return [...seen.values()];
}
