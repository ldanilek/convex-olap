import {
  type BinaryOperator,
  type CallExpression,
  type Expression,
  expressionToSQL,
  type Projection,
  type QueryStatement,
} from "./ast.js";

export type Row = Record<string, unknown>;

export type SubqueryEvaluator = (query: QueryStatement, outerRow: Row) => Promise<Row[]>;

export function evaluateExpression(expression: Expression, row: Row): unknown {
  switch (expression.type) {
    case "literal":
      return expression.value;
    case "identifier":
      return resolveIdentifier(expression.name, expression.table, row);
    case "star":
      return row;
    case "unary": {
      const value = evaluateExpression(expression.expression, row);
      if (expression.operator === "NOT") return !truthy(value);
      if (expression.operator === "-") return -Number(value);
      return Number(value);
    }
    case "binary":
      return evaluateBinary(expression.operator, evaluateExpression(expression.left, row), evaluateExpression(expression.right, row));
    case "call":
      return row[expressionToSQL(expression)];
    case "like":
      return expression.not
        ? !matchesLike(evaluateExpression(expression.expression, row), evaluateExpression(expression.pattern, row))
        : matchesLike(evaluateExpression(expression.expression, row), evaluateExpression(expression.pattern, row));
    case "between": {
      const value = evaluateExpression(expression.expression, row);
      const lower = evaluateExpression(expression.lower, row);
      const upper = evaluateExpression(expression.upper, row);
      const matches = compareValues(value, lower) >= 0 && compareValues(value, upper) <= 0;
      return expression.not ? !matches : matches;
    }
    case "in": {
      const value = evaluateExpression(expression.expression, row);
      const matches =
        Array.isArray(expression.values) &&
        expression.values.some((candidate) => compareValues(value, evaluateExpression(candidate, row)) === 0);
      return expression.not ? !matches : matches;
    }
    case "isNull": {
      const matches = evaluateExpression(expression.expression, row) == null;
      return expression.not ? !matches : matches;
    }
    case "exists":
    case "subquery":
    case "quantifiedComparison":
      throw new Error(`Expression ${expression.type} requires async subquery evaluation.`);
  }
}

export async function evaluateExpressionAsync(
  expression: Expression,
  row: Row,
  evaluateSubquery: SubqueryEvaluator,
): Promise<unknown> {
  switch (expression.type) {
    case "literal":
    case "identifier":
    case "star":
    case "call":
      return evaluateExpression(expression, row);
    case "unary": {
      const value = await evaluateExpressionAsync(expression.expression, row, evaluateSubquery);
      if (expression.operator === "NOT") return !truthy(value);
      if (expression.operator === "-") return -Number(value);
      return Number(value);
    }
    case "binary":
      return evaluateBinary(
        expression.operator,
        await evaluateExpressionAsync(expression.left, row, evaluateSubquery),
        await evaluateExpressionAsync(expression.right, row, evaluateSubquery),
      );
    case "like":
      return expression.not
        ? !matchesLike(
            await evaluateExpressionAsync(expression.expression, row, evaluateSubquery),
            await evaluateExpressionAsync(expression.pattern, row, evaluateSubquery),
          )
        : matchesLike(
            await evaluateExpressionAsync(expression.expression, row, evaluateSubquery),
            await evaluateExpressionAsync(expression.pattern, row, evaluateSubquery),
          );
    case "between": {
      const value = await evaluateExpressionAsync(expression.expression, row, evaluateSubquery);
      const lower = await evaluateExpressionAsync(expression.lower, row, evaluateSubquery);
      const upper = await evaluateExpressionAsync(expression.upper, row, evaluateSubquery);
      const matches = compareValues(value, lower) >= 0 && compareValues(value, upper) <= 0;
      return expression.not ? !matches : matches;
    }
    case "in": {
      const value = await evaluateExpressionAsync(expression.expression, row, evaluateSubquery);
      const values = Array.isArray(expression.values)
        ? await Promise.all(expression.values.map((candidate) => evaluateExpressionAsync(candidate, row, evaluateSubquery)))
        : firstColumnValues(await evaluateSubquery(expression.values, row));
      const matches = values.some((candidate) => compareValues(value, candidate) === 0);
      return expression.not ? !matches : matches;
    }
    case "isNull": {
      const matches = (await evaluateExpressionAsync(expression.expression, row, evaluateSubquery)) == null;
      return expression.not ? !matches : matches;
    }
    case "exists": {
      const rows = await evaluateSubquery(expression.query, row);
      const matches = rows.length > 0;
      return expression.not ? !matches : matches;
    }
    case "subquery": {
      const rows = await evaluateSubquery(expression.query, row);
      return rows.length === 0 ? null : firstColumnValues(rows)[0];
    }
    case "quantifiedComparison": {
      const left = await evaluateExpressionAsync(expression.left, row, evaluateSubquery);
      const values = firstColumnValues(await evaluateSubquery(expression.query, row));
      if (values.length === 0) return expression.quantifier === "ALL";
      const comparisons = values.map((value) => truthy(evaluateBinary(expression.operator, left, value)));
      return expression.quantifier === "ANY" ? comparisons.some(Boolean) : comparisons.every(Boolean);
    }
  }
}

export function truthy(value: unknown): boolean {
  return value !== false && value !== null && value !== undefined && value !== 0 && value !== "";
}

export function compareValues(left: unknown, right: unknown): number {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftString = String(left);
  const rightString = String(right);
  if (leftString < rightString) return -1;
  if (leftString > rightString) return 1;
  return 0;
}

export function projectRow(row: Row, projections: Projection[]): Row {
  const projected: Row = {};
  for (const projection of projections) {
    if (projection.expression.type === "star") {
      Object.assign(projected, expandStar(row, projection.expression.table));
      continue;
    }
    const key = projection.alias ?? defaultProjectionName(projection.expression);
    projected[key] = evaluateExpression(projection.expression, row);
  }
  return projected;
}

export async function projectRowAsync(
  row: Row,
  projections: Projection[],
  evaluateSubquery: SubqueryEvaluator,
): Promise<Row> {
  const projected: Row = {};
  for (const projection of projections) {
    if (projection.expression.type === "star") {
      Object.assign(projected, expandStar(row, projection.expression.table));
      continue;
    }
    const key = projection.alias ?? defaultProjectionName(projection.expression);
    projected[key] = await evaluateExpressionAsync(projection.expression, row, evaluateSubquery);
  }
  return projected;
}

export function defaultProjectionName(expression: Expression): string {
  if (expression.type === "identifier") return expression.name;
  return expressionToSQL(expression);
}

export function aggregateValue(call: CallExpression, rows: Row[]): unknown {
  const name = call.name.toUpperCase();
  const values = call.args[0]?.type === "star" ? rows : rows.map((row) => evaluateExpression(call.args[0]!, row));
  const filtered = values.filter((value) => value !== null && value !== undefined);
  const distinctValues = call.distinct ? uniqueValues(filtered) : filtered;

  switch (name) {
    case "COUNT":
      return call.args[0]?.type === "star" ? rows.length : distinctValues.length;
    case "SUM":
      return sumNumbers(distinctValues);
    case "AVG":
      return distinctValues.length === 0 ? null : sumNumbers(distinctValues) / distinctValues.length;
    case "MIN":
      return distinctValues.reduce<unknown | null>(
        (minimum, value) => (minimum === null || compareValues(value, minimum) < 0 ? value : minimum),
        null,
      );
    case "MAX":
      return distinctValues.reduce<unknown | null>(
        (maximum, value) => (maximum === null || compareValues(value, maximum) > 0 ? value : maximum),
        null,
      );
    default:
      throw new Error(`Unsupported aggregate function ${name}`);
  }
}

function evaluateBinary(operator: BinaryOperator, left: unknown, right: unknown): unknown {
  switch (operator) {
    case "OR":
      return truthy(left) || truthy(right);
    case "AND":
      return truthy(left) && truthy(right);
    case "=":
      return compareValues(left, right) === 0;
    case "!=":
    case "<>":
      return compareValues(left, right) !== 0;
    case "<":
      return compareValues(left, right) < 0;
    case "<=":
      return compareValues(left, right) <= 0;
    case ">":
      return compareValues(left, right) > 0;
    case ">=":
      return compareValues(left, right) >= 0;
    case "+":
      return Number(left) + Number(right);
    case "-":
      return Number(left) - Number(right);
    case "*":
      return Number(left) * Number(right);
    case "/":
      return Number(left) / Number(right);
  }
}

function resolveIdentifier(name: string, table: string | undefined, row: Row): unknown {
  if (table) return row[`${table}.${name}`];
  if (Object.hasOwn(row, name)) return row[name];
  const matches = Object.entries(row).filter(([key]) => key.endsWith(`.${name}`));
  return matches.length === 1 ? matches[0]![1] : undefined;
}

function matchesLike(value: unknown, pattern: unknown): boolean {
  if (value == null || pattern == null) return false;
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replaceAll("%", ".*").replaceAll("_", ".")}$`, "s");
  return regex.test(String(value));
}

function expandStar(row: Row, table: string | undefined): Row {
  if (table) {
    const prefix = `${table}.`;
    return Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );
  }
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.includes(".")));
}

function uniqueValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function sumNumbers(values: unknown[]): number {
  return values.reduce<number>((sum, value) => sum + Number(value), 0);
}

function firstColumnValues(rows: Row[]): unknown[] {
  return rows.map((row) => {
    const entry = Object.entries(row)[0];
    return entry ? entry[1] : undefined;
  });
}
