// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SQL, type ScanFunction } from "../src/index.js";
import { materializePlanToFile } from "../src/node.js";

let tempDir: string | undefined;

const scan: ScanFunction = async () => [
  { email: "a@gmail.com", status: "active" },
  { email: "b@example.com", status: "inactive" },
];

describe("materializePlanToFile", () => {
  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test("writes query results as JSONL", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "convex-olap-"));
    const sql = new SQL({
      tables: {
        users: {
          columns: { email: "string", status: "string" },
        },
      },
    });
    const plan = sql.plan("SELECT email FROM users WHERE status = 'active'");
    const filePath = join(tempDir, "users.jsonl");

    const result = await materializePlanToFile({}, plan, filePath, { scan, format: "jsonl" });

    expect(result.rows).toBe(1);
    expect(await readFile(filePath, "utf8")).toBe('{"email":"a@gmail.com"}\n');
  });
});
