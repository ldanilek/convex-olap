import {
  aggregateFunctions,
  type BinaryExpression,
  type Expression,
  expressionToSQL,
  isAggregateExpression,
  type JoinType,
  type OrderBy,
  type Projection,
  type QueryStatement,
  type Relation,
  type SelectStatement,
} from "./ast.js";
import { type NormalizedIndex, type NormalizedSchema, normalizeSchema, type SchemaSpec } from "./schema.js";

export type QueryPlan = {
  type: "query";
  ast: QueryStatement;
  root: PlanNode;
  ctes: CtePlan[];
  tables: PlannedTable[];
  aggregates: AggregatePlan[];
  executionMode: "singleQuery" | "actionLoop" | "inMemory";
  pushdown: PushdownPlan;
  storage: StoragePlan;
  warnings: string[];
};

export type CtePlan = {
  name: string;
  plan: QueryPlan;
};

export type PlannedTable = {
  tableName: string;
  alias: string;
  index?: IndexUse;
  availableIndexes?: NormalizedIndex[];
  source: "table" | "cte" | "subquery";
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
  | SubqueryScanNode
  | JoinNode
  | FilterNode
  | AggregateNode
  | ProjectNode
  | SortNode
  | LimitNode
  | UnionNode
  | EmptyNode;

export type EmptyNode = {
  type: "empty";
};

export type ScanNode = {
  type: "scan";
  tableName: string;
  alias: string;
  index?: IndexUse;
  source: "table" | "cte";
};

export type SubqueryScanNode = {
  type: "subqueryScan";
  alias: string;
  plan: QueryPlan;
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

export type UnionNode = {
  type: "union";
  left: PlanNode;
  right: PlanNode;
  all: boolean;
};

export type PushdownPlan = {
  joins: JoinPushdown[];
  aggregates: AggregatePushdown[];
  sorts: SortPushdown[];
};

export type StoragePlan = {
  requiresDisk: boolean;
  reasons: string[];
};

export type JoinPushdown = {
  tableName: string;
  alias: string;
  indexName: string;
  fields: string[];
};

export type AggregatePushdown = {
  tableName: string;
  alias: string;
  kind: "orderedGroupBy";
  indexName: string;
  fields: string[];
};

export type SortPushdown = {
  tableName: string;
  alias: string;
  indexName: string;
  fields: string[];
};

export class SQLPlanner {
  readonly schema: NormalizedSchema;

  constructor(schema: SchemaSpec) {
    this.schema = normalizeSchema(schema);
  }

  plan(ast: QueryStatement): QueryPlan {
    const warnings: string[] = [];
    const tables: PlannedTable[] = [];
    const ctes = ast.with.map((cte) => ({ name: cte.name, plan: this.plan(cte.query) }));
    const cteNames = new Set(ctes.map((cte) => cte.name));

    if (ast.type === "setOperation") {
      const left = this.plan(ast.left);
      const right = this.plan(ast.right);
      return {
        type: "query",
        ast,
        root: { type: "union", left: left.root, right: right.root, all: ast.all },
        ctes,
        tables: [...left.tables, ...right.tables],
        aggregates: [...left.aggregates, ...right.aggregates],
        executionMode: "inMemory",
        pushdown: mergePushdown(left.pushdown, right.pushdown),
        storage: mergeStorage({ requiresDisk: true, reasons: ["UNION buffers branch results"] }, left.storage, right.storage),
        warnings: [...warnings, ...left.warnings, ...right.warnings],
      };
    }

    const aggregates = collectAggregates(ast);
    let root = ast.from
      ? this.planRelation(ast.from, ast.where, tables, warnings, cteNames)
      : ({ type: "empty" } satisfies EmptyNode);

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

    const pushdown = planPushdown(ast, tables);
    return {
      type: "query",
      ast,
      root,
      ctes,
      tables,
      aggregates,
      executionMode: chooseExecutionMode(ast, tables),
      pushdown,
      storage: planStorage(ast, root, pushdown, ctes.map((cte) => cte.plan.storage)),
      warnings,
    };
  }

  private planRelation(
    relation: Relation,
    where: Expression | undefined,
    tables: PlannedTable[],
    warnings: string[],
    cteNames: Set<string>,
  ): PlanNode {
    if (relation.type === "join") {
      const left = this.planRelation(relation.left, where, tables, warnings, cteNames);
      const right = this.planRelation(relation.right, where, tables, warnings, cteNames);
      return {
        type: "join",
        joinType: relation.joinType,
        algorithm: relation.on && hasEqualityPredicate(relation.on) ? "indexedNestedLoop" : "nestedLoop",
        left,
        right,
        on: relation.on,
      };
    }

    if (relation.type === "subquery") {
      const plan = this.plan(relation.query);
      tables.push({ tableName: relation.alias, alias: relation.alias, source: "subquery" });
      warnings.push(...plan.warnings);
      return { type: "subqueryScan", alias: relation.alias, plan };
    }

    const alias = relation.alias ?? relation.name;
    if (cteNames.has(relation.name)) {
      const plannedTable = { tableName: relation.name, alias, source: "cte" as const };
      tables.push(plannedTable);
      return { type: "scan", ...plannedTable };
    }
    const tableSchema = this.schema.tables[relation.name];
    if (!tableSchema) {
      warnings.push(`Table "${relation.name}" was not found in the provided schema metadata.`);
    }
    const index = tableSchema ? chooseIndex(tableSchema.indexes, alias, relation.name, where) : undefined;
    const plannedTable = { tableName: relation.name, alias, index, availableIndexes: tableSchema?.indexes, source: "table" as const };
    tables.push(plannedTable);
    return { type: "scan", ...plannedTable };
  }
}

function chooseExecutionMode(ast: SelectStatement, tables: PlannedTable[]): QueryPlan["executionMode"] {
  if (tables.length <= 1 && ast.orderBy.length === 0) return "singleQuery";
  if (tables.length <= 2 && !ast.distinct) return "actionLoop";
  return "inMemory";
}

function mergePushdown(left: PushdownPlan, right: PushdownPlan): PushdownPlan {
  return {
    joins: [...left.joins, ...right.joins],
    aggregates: [...left.aggregates, ...right.aggregates],
    sorts: [...left.sorts, ...right.sorts],
  };
}

function mergeStorage(...plans: StoragePlan[]): StoragePlan {
  const reasons = [...new Set(plans.flatMap((plan) => plan.reasons))];
  return { requiresDisk: reasons.length > 0 || plans.some((plan) => plan.requiresDisk), reasons };
}

function planStorage(
  ast: SelectStatement,
  root: PlanNode,
  pushdown: PushdownPlan,
  cteStorage: StoragePlan[],
): StoragePlan {
  const reasons: string[] = [];
  if (containsNode(root, "subqueryScan")) reasons.push("derived table subquery buffers rows");
  if (containsNode(root, "join") && pushdown.joins.length === 0) reasons.push("join is not backed by an index pushdown");
  if (ast.groupBy.length > 0 && pushdown.aggregates.length === 0) reasons.push("GROUP BY is not backed by index ordering");
  if (ast.orderBy.length > 0 && pushdown.sorts.length === 0) reasons.push("ORDER BY is not backed by index ordering");
  return mergeStorage({ requiresDisk: reasons.length > 0, reasons }, ...cteStorage);
}

function containsNode(root: PlanNode, type: PlanNode["type"]): boolean {
  if (root.type === type) return true;
  if ("input" in root) return containsNode(root.input, type);
  if (root.type === "join") return containsNode(root.left, type) || containsNode(root.right, type);
  if (root.type === "union") return containsNode(root.left, type) || containsNode(root.right, type);
  return false;
}

function planPushdown(ast: SelectStatement, tables: PlannedTable[]): PushdownPlan {
  const base: PushdownPlan = { joins: [], aggregates: [], sorts: [] };
  const tableByAlias = new Map(tables.map((table) => [table.alias, table]));

  if (ast.from?.type === "join" && ast.from.on) {
    for (const equality of collectIdentifierEqualities(ast.from.on)) {
      for (const side of [equality.left, equality.right]) {
        if (!side.table) continue;
        const table = tableByAlias.get(side.table);
        const index = table?.availableIndexes?.find((candidate) => candidate.fields[0] === side.name);
        if (table && index) {
          base.joins.push({
            tableName: table.tableName,
            alias: table.alias,
            indexName: index.name,
            fields: index.fields,
          });
        }
      }
    }
  }

  for (const table of tables) {
    const indexes = table.availableIndexes ?? [];
    const groupFields = ast.groupBy.map((expression) => identifierForTable(expression, table.alias, table.tableName));
    const groupIndex = indexes.find((index) => groupFields.length > 0 && groupFields.every(Boolean) && isPrefix(groupFields as string[], index.fields));
    if (groupIndex) {
      base.aggregates.push({
        tableName: table.tableName,
        alias: table.alias,
        kind: "orderedGroupBy",
        indexName: groupIndex.name,
        fields: groupIndex.fields,
      });
    }

    const sortFields = ast.orderBy.map((order) => identifierForTable(order.expression, table.alias, table.tableName));
    const sortIndex = indexes.find((index) => sortFields.length > 0 && sortFields.every(Boolean) && isPrefix(sortFields as string[], index.fields));
    if (sortIndex) {
      base.sorts.push({
        tableName: table.tableName,
        alias: table.alias,
        indexName: sortIndex.name,
        fields: sortIndex.fields,
      });
    }
  }

  return base;
}

function collectIdentifierEqualities(expression: Expression): Array<{
  left: { table?: string; name: string };
  right: { table?: string; name: string };
}> {
  if (expression.type === "binary" && expression.operator === "AND") {
    return [...collectIdentifierEqualities(expression.left), ...collectIdentifierEqualities(expression.right)];
  }
  if (
    expression.type === "binary" &&
    expression.operator === "=" &&
    expression.left.type === "identifier" &&
    expression.right.type === "identifier"
  ) {
    return [
      {
        left: { table: expression.left.table, name: expression.left.name },
        right: { table: expression.right.table, name: expression.right.name },
      },
    ];
  }
  return [];
}

function isPrefix(fields: string[], indexFields: string[]): boolean {
  return fields.every((field, index) => indexFields[index] === field);
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
        if (Array.isArray(expression.values)) expression.values.forEach(visit);
        break;
      case "isNull":
        visit(expression.expression);
        break;
      case "exists":
      case "subquery":
        break;
      case "quantifiedComparison":
        visit(expression.left);
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
