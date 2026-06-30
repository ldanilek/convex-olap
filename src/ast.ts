export type SQLValue = string | number | boolean | null;

export type SelectStatement = {
  type: "select";
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

export type Projection = {
  expression: Expression;
  alias?: string;
};

export type Relation = TableRelation | JoinRelation;

export type TableRelation = {
  type: "table";
  name: string;
  alias?: string;
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
  | IsNullExpression;

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
  values: Expression[];
  not: boolean;
};

export type IsNullExpression = {
  type: "isNull";
  expression: Expression;
  not: boolean;
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
        expression.values.some((value) => isAggregateExpression(value))
      );
    case "isNull":
      return isAggregateExpression(expression.expression);
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
      return `${expressionToSQL(expression.expression)} ${expression.not ? "NOT " : ""}IN (${expression.values
        .map(expressionToSQL)
        .join(", ")})`;
    case "isNull":
      return `${expressionToSQL(expression.expression)} IS ${expression.not ? "NOT " : ""}NULL`;
  }
}
