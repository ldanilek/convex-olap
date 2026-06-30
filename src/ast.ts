export type SQLValue = string | number | boolean | null;

export type QueryStatement = SelectStatement | SetOperationStatement;

export type CommonTableExpression = {
  name: string;
  query: QueryStatement;
};

export type SelectStatement = {
  type: "select";
  with: CommonTableExpression[];
  distinct: boolean;
  projections: Projection[];
  from?: Relation;
  where?: Expression;
  groupBy: Expression[];
  having?: Expression;
  orderBy: OrderBy[];
  limit?: number;
  offset?: number;
};

export type SetOperationStatement = {
  type: "setOperation";
  with: CommonTableExpression[];
  operator: "UNION";
  all: boolean;
  left: QueryStatement;
  right: QueryStatement;
};

export type Projection = {
  expression: Expression;
  alias?: string;
};

export type Relation = TableRelation | SubqueryRelation | JoinRelation;

export type TableRelation = {
  type: "table";
  name: string;
  alias?: string;
};

export type SubqueryRelation = {
  type: "subquery";
  query: QueryStatement;
  alias: string;
};

export type JoinType = "inner" | "left" | "right" | "full" | "cross";

export type JoinRelation = {
  type: "join";
  joinType: JoinType;
  left: Relation;
  right: Relation;
  on?: Expression;
};

export type OrderBy = {
  expression: Expression;
  direction: "asc" | "desc";
};

export type BinaryOperator =
  | "OR"
  | "AND"
  | "="
  | "!="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/";

export type UnaryOperator = "NOT" | "-" | "+";

export type Expression =
  | LiteralExpression
  | IdentifierExpression
  | StarExpression
  | UnaryExpression
  | BinaryExpression
  | CallExpression
  | LikeExpression
  | BetweenExpression
  | InExpression
  | IsNullExpression
  | ExistsExpression
  | SubqueryExpression
  | QuantifiedComparisonExpression;

export type LiteralExpression = {
  type: "literal";
  value: SQLValue;
};

export type IdentifierExpression = {
  type: "identifier";
  name: string;
  table?: string;
};

export type StarExpression = {
  type: "star";
  table?: string;
};

export type UnaryExpression = {
  type: "unary";
  operator: UnaryOperator;
  expression: Expression;
};

export type BinaryExpression = {
  type: "binary";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
};

export type CallExpression = {
  type: "call";
  name: string;
  args: Expression[];
  distinct: boolean;
};

export type LikeExpression = {
  type: "like";
  expression: Expression;
  pattern: Expression;
  not: boolean;
};

export type BetweenExpression = {
  type: "between";
  expression: Expression;
  lower: Expression;
  upper: Expression;
  not: boolean;
};

export type InExpression = {
  type: "in";
  expression: Expression;
  values: Expression[] | QueryStatement;
  not: boolean;
};

export type IsNullExpression = {
  type: "isNull";
  expression: Expression;
  not: boolean;
};

export type ExistsExpression = {
  type: "exists";
  query: QueryStatement;
  not: boolean;
};

export type SubqueryExpression = {
  type: "subquery";
  query: QueryStatement;
};

export type Quantifier = "ANY" | "ALL";

export type QuantifiedComparisonExpression = {
  type: "quantifiedComparison";
  operator: Exclude<BinaryOperator, "OR" | "AND" | "+" | "-" | "*" | "/">;
  left: Expression;
  quantifier: Quantifier;
  query: QueryStatement;
};

export const aggregateFunctions = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

export function isAggregateExpression(expression: Expression): boolean {
  switch (expression.type) {
    case "call":
      return aggregateFunctions.has(expression.name.toUpperCase());
    case "binary":
      return isAggregateExpression(expression.left) || isAggregateExpression(expression.right);
    case "unary":
      return isAggregateExpression(expression.expression);
    case "like":
      return isAggregateExpression(expression.expression) || isAggregateExpression(expression.pattern);
    case "between":
      return (
        isAggregateExpression(expression.expression) ||
        isAggregateExpression(expression.lower) ||
        isAggregateExpression(expression.upper)
      );
    case "in":
      return (
        isAggregateExpression(expression.expression) ||
        (Array.isArray(expression.values)
          ? expression.values.some((value) => isAggregateExpression(value))
          : false)
      );
    case "isNull":
      return isAggregateExpression(expression.expression);
    case "quantifiedComparison":
      return isAggregateExpression(expression.left);
    default:
      return false;
  }
}

export function expressionToSQL(expression: Expression): string {
  switch (expression.type) {
    case "literal":
      if (expression.value === null) return "NULL";
      if (typeof expression.value === "string") return `'${expression.value.replaceAll("'", "''")}'`;
      return String(expression.value);
    case "identifier":
      return expression.table ? `${expression.table}.${expression.name}` : expression.name;
    case "star":
      return expression.table ? `${expression.table}.*` : "*";
    case "unary":
      return `${expression.operator} ${expressionToSQL(expression.expression)}`;
    case "binary":
      return `(${expressionToSQL(expression.left)} ${expression.operator} ${expressionToSQL(expression.right)})`;
    case "call":
      return `${expression.name.toUpperCase()}(${expression.distinct ? "DISTINCT " : ""}${expression.args
        .map(expressionToSQL)
        .join(", ")})`;
    case "like":
      return `${expressionToSQL(expression.expression)} ${expression.not ? "NOT " : ""}LIKE ${expressionToSQL(
        expression.pattern,
      )}`;
    case "between":
      return `${expressionToSQL(expression.expression)} ${expression.not ? "NOT " : ""}BETWEEN ${expressionToSQL(
        expression.lower,
      )} AND ${expressionToSQL(expression.upper)}`;
    case "in":
      return `${expressionToSQL(expression.expression)} ${expression.not ? "NOT " : ""}IN (${
        Array.isArray(expression.values) ? expression.values.map(expressionToSQL).join(", ") : queryToSQL(expression.values)
      })`;
    case "isNull":
      return `${expressionToSQL(expression.expression)} IS ${expression.not ? "NOT " : ""}NULL`;
    case "exists":
      return `${expression.not ? "NOT " : ""}EXISTS (${queryToSQL(expression.query)})`;
    case "subquery":
      return `(${queryToSQL(expression.query)})`;
    case "quantifiedComparison":
      return `${expressionToSQL(expression.left)} ${expression.operator} ${expression.quantifier} (${queryToSQL(
        expression.query,
      )})`;
  }
}

export function queryToSQL(query: QueryStatement): string {
  const withClause =
    query.with.length > 0
      ? `WITH ${query.with.map((cte) => `${cte.name} AS (${queryToSQL(cte.query)})`).join(", ")} `
      : "";
  if (query.type === "setOperation") {
    return `${withClause}${queryToSQL(query.left)} ${query.operator}${query.all ? " ALL" : ""} ${queryToSQL(
      query.right,
    )}`;
  }
  const projections = query.projections
    .map((projection) => `${expressionToSQL(projection.expression)}${projection.alias ? ` AS ${projection.alias}` : ""}`)
    .join(", ");
  return `${withClause}SELECT ${query.distinct ? "DISTINCT " : ""}${projections}`;
}
