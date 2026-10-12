import { CoreError } from "@core/contracts";
import { z } from "zod";
import { defineTool } from "../define.js";

/** Nesting (parentheses, unary signs, `^` chains) beyond this is refused instead of overflowing the stack. */
const MAX_DEPTH = 256;

type Token = {
  type: "number" | "operator" | "open" | "close" | "bad" | "end";
  /** The source text. */
  text: string;
  /** Zero-based offset into the expression. */
  pos: number;
  /** For operators, the canonical symbol (`×` is `*`, `÷` is `/`). */
  op?: string;
  value?: number;
};

const NUMBER = /\d+(?:\.\d+)?|\.\d+/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;

function fail(what: string, pos: number): never {
  throw new CoreError("bad_request", `${what}: at position ${pos}`);
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < expression.length) {
    const char = expression.charAt(pos);
    if (/\s/.test(char)) {
      pos += 1;
      continue;
    }
    NUMBER.lastIndex = pos;
    const number = NUMBER.exec(expression);
    if (number !== null) {
      tokens.push({ type: "number", text: number[0], pos, value: Number(number[0]) });
      pos += number[0].length;
      continue;
    }
    if ("+-*/%^".includes(char)) {
      tokens.push({ type: "operator", text: char, pos, op: char });
    } else if (char === "×" || char === "÷") {
      tokens.push({ type: "operator", text: char, pos, op: char === "×" ? "*" : "/" });
    } else if (char === "(") {
      tokens.push({ type: "open", text: char, pos });
    } else if (char === ")") {
      tokens.push({ type: "close", text: char, pos });
    } else {
      // Anything else is kept as a token so that errors are reported left to right.
      WORD.lastIndex = pos;
      const word = WORD.exec(expression);
      const text = word?.[0] ?? char;
      tokens.push({ type: "bad", text, pos });
      pos += text.length - 1;
    }
    pos += 1;
  }
  tokens.push({ type: "end", text: "", pos: expression.length });
  return tokens;
}

/**
 * Recursive descent over the grammar
 *
 *     expr  = term (("+" | "-") term)*
 *     term  = unary (("*" | "/" | "%") unary)*
 *     unary = ("+" | "-") unary | power
 *     power = primary ("^" unary)?        // right-associative, tighter than unary minus
 *     primary = number | "(" expr ")"
 */
class Parser {
  readonly #tokens: Token[];
  #index = 0;
  #depth = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  parse(): number {
    if (this.#peek().type === "end") fail("empty expression", 0);
    const value = this.#expr();
    const rest = this.#peek();
    if (rest.type !== "end") fail(this.#unexpected(rest), rest.pos);
    return value;
  }

  #peek(): Token {
    // The token list always ends with "end", and nothing advances past it.
    return this.#tokens[this.#index] as Token;
  }

  #next(): Token {
    const token = this.#peek();
    if (token.type !== "end") this.#index += 1;
    return token;
  }

  #isOperator(token: Token, symbols: string): boolean {
    return token.type === "operator" && token.op !== undefined && symbols.includes(token.op);
  }

  #unexpected(token: Token): string {
    return token.type === "end" ? "unexpected end of input" : `unexpected "${token.text}"`;
  }

  #expr(): number {
    let value = this.#term();
    while (this.#isOperator(this.#peek(), "+-")) {
      const op = this.#next().op;
      const right = this.#term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }

  #term(): number {
    let value = this.#unary();
    while (this.#isOperator(this.#peek(), "*/%")) {
      const op = this.#next().op;
      const right = this.#unary();
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  }

  #unary(): number {
    const token = this.#peek();
    if (++this.#depth > MAX_DEPTH) fail("expression is nested too deeply", token.pos);
    let value: number;
    if (this.#isOperator(token, "+-")) {
      this.#next();
      const operand = this.#unary();
      value = token.op === "-" ? -operand : operand;
    } else {
      value = this.#power();
    }
    this.#depth -= 1;
    return value;
  }

  #power(): number {
    const base = this.#primary();
    if (this.#isOperator(this.#peek(), "^")) {
      this.#next();
      return base ** this.#unary();
    }
    return base;
  }

  #primary(): number {
    const token = this.#next();
    if (token.type === "number") return token.value as number;
    if (token.type === "open") {
      const value = this.#expr();
      const close = this.#peek();
      if (close.type === "close") {
        this.#next();
        return value;
      }
      if (close.type === "end") fail('missing closing parenthesis ")"', close.pos);
      fail(this.#unexpected(close), close.pos);
    }
    return fail(this.#unexpected(token), token.pos);
  }
}

/**
 * Evaluates an arithmetic expression without `eval`. Supports decimal numbers, `+ - * / % ^`
 * (`×` and `÷` as aliases for `*` and `/`), unary `+` and `-`, parentheses and whitespace.
 * `^` is right-associative and binds tighter than unary minus, so `-2^2` is `-4`.
 * Throws `CoreError` `bad_request`: for malformed input with the zero-based position of the
 * problem, and for a result that is not a finite number (such as a division by zero).
 */
export function evaluate(expression: string): number {
  const result = new Parser(tokenize(expression)).parse();
  if (!Number.isFinite(result)) throw new CoreError("bad_request", "result is not a finite number");
  return result;
}

export const calculateTool = defineTool({
  name: "calculate",
  description: "Evaluate an arithmetic expression exactly. Supports + - * / % ^ and parentheses.",
  input: z.object({ expression: z.string().min(1).max(200) }),
  policy: { sideEffects: false },
  handler: ({ expression }) => ({ expression, result: evaluate(expression) }),
});
