export type TokenType =
  | "identifier"
  | "keyword"
  | "number"
  | "string"
  | "operator"
  | "punctuation"
  | "eof";

export type Token = {
  type: TokenType;
  value: string;
  position: number;
};

const keywords = new Set([
  "ALL",
  "AND",
  "AS",
  "ASC",
  "AVG",
  "BETWEEN",
  "BY",
  "COUNT",
  "CROSS",
  "DESC",
  "DISTINCT",
  "FALSE",
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
  "MAX",
  "MIN",
  "NOT",
  "NULL",
  "OFFSET",
  "ON",
  "OR",
  "ORDER",
  "OUTER",
  "RIGHT",
  "SELECT",
  "SUM",
  "TRUE",
  "WHERE",
]);

export class SQLSyntaxError extends Error {
  constructor(message: string, readonly position: number) {
    super(`${message} at character ${position}`);
    this.name = "SQLSyntaxError";
  }
}

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let position = 0;

  while (position < source.length) {
    const char = source[position]!;

    if (/\s/.test(char)) {
      position += 1;
      continue;
    }

    if (char === "-" && source[position + 1] === "-") {
      position += 2;
      while (position < source.length && source[position] !== "\n") position += 1;
      continue;
    }

    if (char === "/" && source[position + 1] === "*") {
      const start = position;
      position += 2;
      while (position < source.length && !(source[position] === "*" && source[position + 1] === "/")) {
        position += 1;
      }
      if (position >= source.length) throw new SQLSyntaxError("Unterminated block comment", start);
      position += 2;
      continue;
    }

    if (char === "'" || char === '"') {
      const start = position;
      const quote = char;
      position += 1;
      let value = "";
      while (position < source.length) {
        const current = source[position]!;
        if (current === quote) {
          if (source[position + 1] === quote) {
            value += quote;
            position += 2;
            continue;
          }
          position += 1;
          tokens.push({ type: quote === '"' ? "identifier" : "string", value, position: start });
          break;
        }
        value += current;
        position += 1;
      }
      if (position >= source.length && source[position - 1] !== quote) {
        throw new SQLSyntaxError("Unterminated quoted value", start);
      }
      continue;
    }

    if (char === "`") {
      const start = position;
      position += 1;
      let value = "";
      while (position < source.length && source[position] !== "`") {
        value += source[position]!;
        position += 1;
      }
      if (source[position] !== "`") throw new SQLSyntaxError("Unterminated quoted identifier", start);
      position += 1;
      tokens.push({ type: "identifier", value, position: start });
      continue;
    }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[position + 1] ?? ""))) {
      const start = position;
      let value = "";
      while (position < source.length && /[0-9_]/.test(source[position]!)) {
        value += source[position]!;
        position += 1;
      }
      if (source[position] === ".") {
        value += ".";
        position += 1;
        while (position < source.length && /[0-9_]/.test(source[position]!)) {
          value += source[position]!;
          position += 1;
        }
      }
      if ((source[position] === "e" || source[position] === "E") && /[+\-0-9]/.test(source[position + 1] ?? "")) {
        value += source[position]!;
        position += 1;
        if (source[position] === "+" || source[position] === "-") {
          value += source[position]!;
          position += 1;
        }
        while (position < source.length && /[0-9_]/.test(source[position]!)) {
          value += source[position]!;
          position += 1;
        }
      }
      tokens.push({ type: "number", value: value.replaceAll("_", ""), position: start });
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const start = position;
      let value = "";
      while (position < source.length && /[A-Za-z0-9_$]/.test(source[position]!)) {
        value += source[position]!;
        position += 1;
      }
      const upper = value.toUpperCase();
      tokens.push({
        type: keywords.has(upper) ? "keyword" : "identifier",
        value: keywords.has(upper) ? upper : value,
        position: start,
      });
      continue;
    }

    const twoChar = source.slice(position, position + 2);
    if (["<=", ">=", "!=", "<>"].includes(twoChar)) {
      tokens.push({ type: "operator", value: twoChar, position });
      position += 2;
      continue;
    }

    if (["=", "<", ">", "+", "-", "*", "/", "."].includes(char)) {
      tokens.push({ type: "operator", value: char, position });
      position += 1;
      continue;
    }

    if ([",", "(", ")", ";"].includes(char)) {
      tokens.push({ type: "punctuation", value: char, position });
      position += 1;
      continue;
    }

    throw new SQLSyntaxError(`Unexpected character ${JSON.stringify(char)}`, position);
  }

  tokens.push({ type: "eof", value: "<eof>", position: source.length });
  return tokens;
}
