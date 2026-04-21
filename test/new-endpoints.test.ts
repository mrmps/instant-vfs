// Integration tests for endpoints added in this session:
//   · /llms.txt
//   · /tree?depth=1 (one-level listing)
//   · /files (batched reads)
//   · /outline enhancements (endLine, ?depth=2, ?comments=1, directory mode)
//   · /bash footer on empty-output non-zero exit
// These hit the deployed worker — they confirm the wire contract, not just
// the local runner. Assumes `sindresorhus/ky` and `tj/commander.js` are
// already ingested (prewarm handles it).

import { describe, expect, test } from "bun:test";
import { getJson, getText, prewarm } from "./common";

describe("/llms.txt", () => {
  test("served at both /llms.txt and /.well-known/llms.txt", async () => {
    const a = await getText("/llms.txt");
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toContain("text/plain");
    expect(a.body).toContain("gitvfs");
    expect(a.body).toContain("/outline");
    expect(a.body).toContain("/bash");
    expect(a.body).toContain("/files");

    const b = await getText("/.well-known/llms.txt");
    expect(b.status).toBe(200);
    expect(b.body).toContain("gitvfs");
  });

  test("warns agents off summarizing fetchers", async () => {
    const { body } = await getText("/llms.txt");
    expect(body).toMatch(/summariz/i);
    expect(body).toMatch(/curl/);
  });
});

describe("/tree?depth=1", () => {
  test("text format returns one-level listing with directories marked", async () => {
    await prewarm("sindresorhus/ky");
    const { body, status } = await getText("/sindresorhus/ky/tree?depth=1");
    expect(status).toBe(200);
    const lines = body.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.endsWith("/"))).toBe(true); // at least one dir
    expect(lines.some((l) => !l.endsWith("/"))).toBe(true); // at least one file
    expect(lines).toContain("source/");
    // Flat top-level — no deep paths
    expect(lines.every((l) => !l.includes("/") || l.endsWith("/"))).toBe(true);
  });

  test("json format includes kind per entry", async () => {
    await prewarm("sindresorhus/ky");
    const { body, status } = await getJson("/sindresorhus/ky/tree.json?depth=1");
    expect(status).toBe(200);
    expect(body.entries.some((e: any) => e.kind === "dir")).toBe(true);
    expect(body.entries.some((e: any) => e.kind === "file" && typeof e.size === "number")).toBe(true);
  });

  test("depth=1 scoped to a subpath", async () => {
    await prewarm("sindresorhus/ky");
    const { body } = await getText("/sindresorhus/ky/tree/source?depth=1");
    const lines = body.trim().split("\n");
    expect(lines).toContain("core/");
    expect(lines).toContain("index.ts");
  });

  test("depth=1 rejects incompatible glob / outlines combos", async () => {
    const glob = await getJson("/sindresorhus/ky/tree?depth=1&glob=**/*.ts");
    expect(glob.status).toBe(400);
    expect(glob.body.error).toBe("bad_params");
    const outl = await getJson("/sindresorhus/ky/tree.json?depth=1&outlines=1");
    expect(outl.status).toBe(400);
    expect(outl.body.error).toBe("bad_params");
  });
});

describe("/files (batched)", () => {
  test("reads multiple paths in one request", async () => {
    await prewarm("sindresorhus/ky");
    const { body, status } = await getJson(
      "/sindresorhus/ky/files?paths=package.json&paths=readme.md",
    );
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    const byPath = Object.fromEntries(body.results.map((r: any) => [r.path, r]));
    expect(byPath["package.json"].content).toContain('"name"');
    expect(byPath["readme.md"].content.length).toBeGreaterThan(0);
  });

  test("comma-separated paths are also supported", async () => {
    await prewarm("sindresorhus/ky");
    const { body } = await getJson(
      "/sindresorhus/ky/files?paths=" + encodeURIComponent("package.json,readme.md"),
    );
    expect(body.count).toBe(2);
  });

  test("missing paths surface as {error: not_found}, don't fail the request", async () => {
    await prewarm("sindresorhus/ky");
    const { body, status } = await getJson(
      "/sindresorhus/ky/files?paths=package.json&paths=nonexistent.xyz",
    );
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    const miss = body.results.find((r: any) => r.path === "nonexistent.xyz");
    expect(miss.error).toBe("not_found");
    // The real file still came back fine.
    const ok = body.results.find((r: any) => r.path === "package.json");
    expect(ok.content).toBeDefined();
  });

  test("ndjson format returns one JSON object per line", async () => {
    await prewarm("sindresorhus/ky");
    const { body, status, headers } = await getText(
      "/sindresorhus/ky/files?paths=package.json&paths=readme.md&format=ndjson",
    );
    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("ndjson");
    const lines = body.trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.path).toBe("package.json");
    expect(second.path).toBe("readme.md");
  });

  test("rejects > 50 paths", async () => {
    const paths = Array.from({ length: 51 }, (_, i) => `f${i}`).join(",");
    const { status, body } = await getJson(
      "/sindresorhus/ky/files?paths=" + encodeURIComponent(paths),
    );
    expect(status).toBe(400);
    expect(body.error).toBe("too_many_paths");
  });

  test("rejects path traversal in ?paths=", async () => {
    const { status, body } = await getJson(
      "/sindresorhus/ky/files?paths=" + encodeURIComponent("../etc/passwd"),
    );
    expect(status).toBe(400);
    expect(body.error).toBe("bad_path");
  });

  test("missing ?paths param returns 400", async () => {
    const { status, body } = await getJson("/sindresorhus/ky/files");
    expect(status).toBe(400);
    expect(body.error).toBe("missing_paths");
  });
});

describe("/outline enhancements (live)", () => {
  test("endLine is populated on top-level classes", async () => {
    await prewarm("tj/commander.js");
    const { body } = await getJson("/tj/commander.js/outline/lib/command.js");
    const cls = body.items.find((i: any) => i.kind === "class");
    expect(cls).toBeDefined();
    expect(cls.endLine).toBeGreaterThan(cls.line);
  });

  test("?depth=2 returns children for classes", async () => {
    await prewarm("tj/commander.js");
    const { body } = await getJson("/tj/commander.js/outline/typings/index.d.ts?depth=2");
    const cmd = body.items.find((i: any) => i.name === "Command");
    expect(cmd.children).toBeDefined();
    expect(cmd.children.length).toBeGreaterThan(20);
    const option = cmd.children.find((c: any) => c.name === "option");
    expect(option).toBeDefined();
  });

  test("?comments=1 surfaces JSDoc on class members", async () => {
    await prewarm("tj/commander.js");
    const { body } = await getJson(
      "/tj/commander.js/outline/typings/index.d.ts?depth=2&comments=1",
    );
    const err = body.items.find((i: any) => i.name === "CommanderError");
    const ctor = err.children.find((c: any) => c.name === "constructor");
    expect(ctor.leadingComment).toBeDefined();
    expect(ctor.leadingComment).toContain("exitCode");
  });

  test("/outline on a directory returns bulk entries", async () => {
    await prewarm("sindresorhus/ky");
    const { body, status } = await getJson("/sindresorhus/ky/outline/source/core");
    expect(status).toBe(200);
    expect(body.kind).toBe("directory");
    expect(body.count).toBeGreaterThan(0);
    expect(body.entries[0].items).toBeDefined();
    expect(body.entries[0].language).toBeDefined();
  });
});

describe("/bash empty-output footer (live)", () => {
  test("format=text emits exit footer when grep has no matches", async () => {
    await prewarm("sindresorhus/ky");
    const cmd = encodeURIComponent("grep -rln __absolutely_no_match_token_xyz__ source");
    const { body, status } = await getText(
      `/sindresorhus/ky/bash?format=text&cmd=${cmd}`,
    );
    expect(status).toBe(200);
    expect(body).toMatch(/^# bash: exit=1/);
  });

  test("successful empty output (e.g. echo -n) stays truly empty", async () => {
    await prewarm("sindresorhus/ky");
    // `sort` with empty stdin → empty output, exit 0 → no footer
    const cmd = encodeURIComponent("echo '' | head -n 0");
    const { body } = await getText(`/sindresorhus/ky/bash?format=text&cmd=${cmd}`);
    expect(body).not.toMatch(/^# bash:/);
  });
});
