import {
  type BinaryOperator,
  type Expression,
  type JoinType,
  type OrderBy,
  type Projection,
  type Relation,
  type SelectStatement,
} from "./ast.js";
import { lex, SQLSyntaxError, type Token } from "./lexer.js";

export function parseSQL(source: string): SelectStatement {
  const parser = new Parser(lex(source));
  return parser.parseSelectStatement();
}

class Parser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  parseSelectStatement(): SelectStatement {
    this.expectKeyword("SELECT");
    const distinct = this.matchKeyword("DISTINCT");
    if (!distinct) this.matchKeyword("ALL");

    const projections = this.parseProjectionList();
    const from = this.matchKeyword("FROM") ? this.parseRelation() : undefined;
    const where = this.matchKeyword("WHERE") ? this.parseExpression() : undefined;
    const groupBy = this.matchKeyword("GROUP")
      ? (this.expectKeyword("BY"), this.parseExpressionList())
      : [];
    const having = this.matchKeyword("HAVING") ? this.parseExpression() : undefined;
    const orderBy = this.matchKeyword("ORDER")
      ? (this.expectKeyword("BY"), this.parseOrderByList())
      : [];
    const limit = this.matchKeyword("LIMIT") ? this.parsePositiveInteger("LIMIT") : undefined;
    const offset = this.matchKeyword("OFFSET") ? this.parsePositiveInteger("OFFSET") : undefined;

    this.matchPunctuation(";");
    this.expect("eof");

    return {
      type: "select",
      distinct,
      projections,
      from,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
    };
  }

  private parseProjectionList(): Projection[] {
    return this.parseCommaList(() => {
      const expression = this.parseExpression();
      let alias: string | undefined;
      if (this.matchKeyword("AS")) {
        alias = this.parseIdentifier();
      } else if (this.canStartImplicitAlias()) {
        alias = this.parseIdentifier();
      }
      return { expression, alias };
    });
  }

  private parseRelation(): Relation {
    let relation = this.parseTableRelation();

    while (true) {
      if (this.matchPunctuation(",")) {
        relation = {
          type: "join",
          joinType: "cross",
          left: relation,
          right: this.parseTableRelation(),
        };
        continue;
      }

      const joinType = this.parseOptionalJoinType();
      if (!joinType) break;
      const right = this.parseTableRelation();
      const on = joinType === "cross" ? undefined : this.matchKeyword("ON") ? this.parseExpression() : undefined;
      relation = { type: "join", joinType, left: relation, right, on };
    }

    return relation;
  }

  private parseOptionalJoinType(): JoinType | undefined {
    if (this.matchKeyword("JOIN")) return "inner";
    if (this.matchKeyword("INNER")) {
      this.expectKeyword("JOIN");
      return "inner";
    }
    if (this.matchKeyword("LEFT")) {
      this.matchKeyword("OUTER");
      this.expectKeyword("JOIN");
      return "left";
    }
    if (this.matchKeyword("RIGHT")) {
      this.matchKeyword("OUTER");
      this.expectKeyword("JOIN");
      return "right";
    }
    if (this.matchKeyword("FULL")) {
      this.matchKeyword("OUTER");
      this.expectKeyword("JOIN");
      return "full";
    }
    if (this.matchKeyword("CROSS")) {
      this.expectKeyword("JOIN");
      return "cross";
    }
    return undefined;
  }

  private parseTableRelation(): Relation {
    const name = this.parseQualifiedName();
    let alias: string | undefined;
    if (this.matchKeyword("AS")) {
      alias = this.parseIdentifier();
    } else if (this.canStartImplicitAlias()) {
      alias = this.parseIdentifier();
    }
    return { type: "table", name, alias };
  }

  private parseOrderByList(): OrderBy[] {
    return this.parseCommaList(() => {
      const expression = this.parseExpression();
      const direction = this.matchKeyword("DESC") ? "desc" : (this.matchKeyword("ASC"), "asc");
      return { expression, direction };
    });
  }

  private parseExpressionList(): Expression[] {
    return this.parseCommaList(() => this.parseExpression());
  }

  private parseExpression(): Expression {
    return this.parseOr();
  }

  private parseOr(): Expression {
    let expression = this.parseAnd();
    while (this.matchKeyword("OR")) {
      expression = { type: "binary", operator: "OR", left: expression, right: this.parseAnd() };
    }
    return expression;
  }

  private parseAnd(): Expression {
    let expression = this.parseNot();
    while (this.matchKeyword("AND")) {
      expression = { type: "binary", operator: "AND", left: expression, right: this.parseNot() };
    }
    return expression;
  }

  private parseNot(): Expression {
    if (this.matchKeyword("NOT")) {
      return { type: "unary", operator: "NOT", expression: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expression {
    let expression = this.parseAdditive();

    while (true) {
      if (this.matchKeyword("IS")) {
        const not = this.matchKeyword("NOT");
        this.expectKeyword("NULL");
        expression = { type: "isNull", expression, not };
        continue;
      }

      const not = this.matchKeyword("NOT");
      if (this.matchKeyword("LIKE")) {
        expression = { type: "like", expression, pattern: this.parseAdditive(), not };
        continue;
      }
      if (this.matchKeyword("BETWEEN")) {
        const lower = this.parseAdditive();
        this.expectKeyword("AND");
        expression = { type: "between", expression, lower, upper: this.parseAdditive(), not };
        continue;
      }
      if (this.matchKeyword("IN")) {
        this.expectPunctuation("(");
        const values = this.matchPunctuation(")") ? [] : this.parseExpressionList();
        this.expectPunctuation(")");
        expression = { type: "in", expression, values, not };
        continue;
      }
      if (not) {
        throw this.error("Expected LIKE, BETWEEN, or IN after NOT");
      }

      const operator = this.matchComparisonOperator();
      if (!operator) break;
      expression = { type: "binary", operator, left: expression, right: this.parseAdditive() };
    }

    return expression;
  }

  private parseAdditive(): Expression {
    let expression = this.parseMultiplicative();
    while (true) {
      if (this.matchOperator("+")) {
        expression = { type: "binary", operator: "+", left: expression, right: this.parseMultiplicative() };
      } else if (this.matchOperator("-")) {
        expression = { type: "binary", operator: "-", left: expression, right: this.parseMultiplicative() };
      } else {
        return expression;
      }
    }
  }

  private parseMultiplicative(): Expression {
    let expression = this.parseUnary();
    while (true) {
      if (this.matchOperator("*")) {
        expression = { type: "binary", operator: "*", left: expression, right: this.parseUnary() };
      } else if (this.matchOperator("/")) {
        expression = { type: "binary", operator: "/", left: expression, right: this.parseUnary() };
      } else {
        return expression;
      }
    }
  }

  private parseUnary(): Expression {
    if (this.matchOperator("-")) {
      return { type: "unary", operator: "-", expression: this.parseUnary() };
    }
    if (this.matchOperator("+")) {
      return { type: "unary", operator: "+", expression: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    if (this.matchPunctuation("(")) {
      const expression = this.parseExpression();
      this.expectPunctuation(")");
      return expression;
    }

    const token = this.current();
    if (token.type === "number") {
      this.advance();
      return { type: "literal", value: Number(token.value) };
    }
    if (token.type === "string") {
      this.advance();
      return { type: "literal", value: token.value };
    }
    if (this.matchKeyword("NULL")) return { type: "literal", value: null };
    if (this.matchKeyword("TRUE")) return { type: "literal", value: true };
    if (this.matchKeyword("FALSE")) return { type: "literal", value: false };
    if (this.matchOperator("*")) return { type: "star" };

    const name = this.parseIdentifier();
    if (this.matchPunctuation("(")) {
      const distinct = this.matchKeyword("DISTINCT");
      const args = this.matchPunctuation(")") ? [] : this.parseFunctionArgs();
      this.expectPunctuation(")");
      return { type: "call", name, args, distinct };
    }

    if (this.matchOperator(".")) {
      if (this.matchOperator("*")) return { type: "star", table: name };
      return { type: "identifier", table: name, name: this.parseIdentifier() };
    }

    return { type: "identifier", name };
  }

  private parseFunctionArgs(): Expression[] {
    if (this.matchOperator("*")) return [{ type: "star" }];
    return this.parseExpressionList();
  }

  private parseCommaList<T>(parseItem: () => T): T[] {
    const items = [parseItem()];
    while (this.matchPunctuation(",")) {
      items.push(parseItem());
    }
    return items;
  }

  private parseQualifiedName(): string {
    let name = this.parseIdentifier();
    while (this.matchOperator(".")) {
      name += `.${this.parseIdentifier()}`;
    }
    return name;
  }

  private parseIdentifier(): string {
    const token = this.current();
    if (token.type === "identifier") {
      this.advance();
      return token.value;
    }
    if (token.type === "keyword" && !this.isClauseKeyword(token.value)) {
      this.advance();
      return token.value.toLowerCase();
    }
    throw this.error("Expected identifier");
  }

  private parsePositiveInteger(context: string): number {
    const token = this.expect("number");
    const value = Number(token.value);
    if (!Number.isInteger(value) || value < 0) throw this.error(`${context} must be a non-negative integer`);
    return value;
  }

  private canStartImplicitAlias(): boolean {
    const token = this.current();
    return token.type === "identifier" || (token.type === "keyword" && !this.isClauseKeyword(token.value));
  }

  private isClauseKeyword(value: string): boolean {
    return [
      "AND",
      "ASC",
      "BETWEEN",
      "BY",
      "CROSS",
      "DESC",
      "FROM",
      "FULL",
      "GROUP",
      "HAVING",
      "IN",
      "INNER",
      "IS",
      "JOIN",
      "LEFT",
      "LIKE",
      "LIMIT",
      "NOT",
      "OFFSET",
      "ON",
      "OR",
      "ORDER",
      "OUTER",
      "RIGHT",
      "WHERE",
    ].includes(value);
  }

  private matchComparisonOperator(): BinaryOperator | undefined {
    for (const operator of ["=", "!=", "<>", "<=", ">=", "<", ">"] as const) {
      if (this.matchOperator(operator)) return operator;
    }
    return undefined;
  }

  private matchKeyword(value: string): boolean {
    const token = this.current();
    if (token.type === "keyword" && token.value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  private expectKeyword(value: string): Token {
    const token = this.current();
    if (token.type === "keyword" && token.value === value) {
      this.advance();
      return token;
    }
    throw this.error(`Expected ${value}`);
  }

  private matchOperator(value: string): boolean {
    const token = this.current();
    if (token.type === "operator" && token.value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  private matchPunctuation(value: string): boolean {
    const token = this.current();
    if (token.type === "punctuation" && token.value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  private expectPunctuation(value: string): Token {
    const token = this.current();
    if (token.type === "punctuation" && token.value === value) {
      this.advance();
      return token;
    }
    throw this.error(`Expected ${value}`);
  }

  private expect(type: Token["type"]): Token {
    const token = this.current();
    if (token.type !== type) throw this.error(`Expected ${type}`);
    this.advance();
    return token;
  }

  private current(): Token {
    return this.tokens[this.position]!;
  }

  private advance(): void {
    this.position += 1;
  }

  private error(message: string): SQLSyntaxError {
    return new SQLSyntaxError(message, this.current().position);
  }
}
