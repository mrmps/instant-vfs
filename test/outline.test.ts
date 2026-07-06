// Unit tests for the outline extractor. Run locally — no HTTP required.

import { describe, expect, test } from "bun:test";
import { outline } from "../src/outline";

describe("outline: endLine", () => {
  test("totalLines follows stored logical line-count semantics", () => {
    const trailing = outline("README.md", "Hello World!\n");
    expect(trailing.totalLines).toBe(1);

    const empty = outline("empty.txt", "");
    expect(empty.totalLines).toBe(0);
  });

  test("ts function: endLine points at the matching closing brace", () => {
    const src = [
      "export function foo(a: number) {",
      "  if (a > 0) {",
      "    return a + 1;",
      "  }",
      "  return 0;",
      "}",
      "",
      "export const bar = 42;",
    ].join("\n");
    const o = outline("x.ts", src);
    const foo = o.items.find((i) => i.name === "foo")!;
    expect(foo).toBeDefined();
    expect(foo.line).toBe(1);
    expect(foo.endLine).toBe(6);
  });

  test("ts class with nested string/comment braces", () => {
    const src = [
      "export class K {",
      "  f() {",
      "    const s = '{';",
      '    const t = "}";',
      "    // note: { curly in comment }",
      "    return s + t;",
      "  }",
      "}",
    ].join("\n");
    const o = outline("x.ts", src);
    const k = o.items.find((i) => i.name === "K")!;
    expect(k.line).toBe(1);
    expect(k.endLine).toBe(8);
  });

  test("python def: endLine uses indentation", () => {
    const src = [
      "def foo(x):",
      "    if x > 0:",
      "        return x",
      "    return 0",
      "",
      "def bar():",
      "    return 1",
    ].join("\n");
    const o = outline("x.py", src);
    const foo = o.items.find((i) => i.name === "foo")!;
    expect(foo.line).toBe(1);
    // last non-blank line at deeper indent is line 4
    expect(foo.endLine).toBe(4);
  });
});

describe("outline: leadingComment", () => {
  test("JSDoc block above a function is captured with ?comments=1", () => {
    const src = [
      "/**",
      " * Does a thing.",
      " * @param a the thing",
      " */",
      "export function doThing(a: number) {",
      "  return a;",
      "}",
    ].join("\n");
    const o = outline("x.ts", src, { comments: true });
    const it = o.items.find((i) => i.name === "doThing")!;
    expect(it.leadingComment).toBeDefined();
    expect(it.leadingComment).toContain("Does a thing");
    expect(it.leadingComment).toContain("@param a");
  });

  test("line comments above a function are captured", () => {
    const src = [
      "// one",
      "// two",
      "export function f() { return 1; }",
    ].join("\n");
    const o = outline("x.ts", src, { comments: true });
    const f = o.items.find((i) => i.name === "f")!;
    expect(f.leadingComment).toBe("one\ntwo");
  });

  test("python # comment above a def is captured", () => {
    const src = [
      "# what this does",
      "def foo():",
      "    pass",
    ].join("\n");
    const o = outline("x.py", src, { comments: true });
    const f = o.items.find((i) => i.name === "foo")!;
    expect(f.leadingComment).toBe("what this does");
  });

  test("comments are absent when ?comments is off (default)", () => {
    const src = [
      "// hi",
      "export function f() {}",
    ].join("\n");
    const o = outline("x.ts", src);
    const f = o.items.find((i) => i.name === "f")!;
    expect(f.leadingComment).toBeUndefined();
  });
});

describe("outline: depth", () => {
  test("depth=2 enumerates ts class methods and properties", () => {
    const src = [
      "export class Command {",
      "  readonly name: string;",
      "  private _opts: any = {};",
      "  constructor(n: string) { this.name = n; }",
      "  option(flag: string, desc?: string): this { return this; }",
      "  async parse(argv?: string[]): Promise<this> { return this; }",
      "}",
    ].join("\n");
    const o = outline("x.ts", src, { depth: 2 });
    const cmd = o.items.find((i) => i.name === "Command")!;
    expect(cmd.children).toBeDefined();
    const names = cmd.children!.map((c) => c.name).sort();
    expect(names).toEqual(["_opts", "constructor", "name", "option", "parse"]);
    // method bodies should have endLine
    const parse = cmd.children!.find((c) => c.name === "parse")!;
    expect(parse.endLine).toBeDefined();
  });

  test("depth=1 (default) still produces no children", () => {
    const src = [
      "export class A {",
      "  m() {}",
      "}",
    ].join("\n");
    const o = outline("x.ts", src);
    const a = o.items.find((i) => i.name === "A")!;
    expect(a.children).toBeUndefined();
  });

  test("depth=2 enumerates python class methods", () => {
    const src = [
      "class Foo:",
      "    def bar(self):",
      "        pass",
      "    def baz(self, x):",
      "        return x",
    ].join("\n");
    const o = outline("x.py", src, { depth: 2 });
    const foo = o.items.find((i) => i.name === "Foo")!;
    expect(foo.children).toBeDefined();
    expect(foo.children!.map((c) => c.name).sort()).toEqual(["bar", "baz"]);
  });

  test("depth=2 enumerates ts interface members", () => {
    const src = [
      "export interface Thing {",
      "  id: string;",
      "  doIt(): Promise<void>;",
      "}",
    ].join("\n");
    const o = outline("x.ts", src, { depth: 2 });
    const t = o.items.find((i) => i.name === "Thing")!;
    expect(t.children).toBeDefined();
    expect(t.children!.map((c) => c.name).sort()).toEqual(["doIt", "id"]);
  });
});
