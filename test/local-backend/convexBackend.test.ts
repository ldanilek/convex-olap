import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const deploymentUrl = process.env.CONVEX_URL ?? "http://127.0.0.1:3210";

const seed = makeFunctionReference<"mutation">("olap:seed");
const clear = makeFunctionReference<"mutation">("olap:clear");
const runInQuery = makeFunctionReference<"query">("olap:runInQuery");
const runInAction = makeFunctionReference<"action">("olap:runInAction");

describe("local Convex backend OLAP execution", () => {
  const client = new ConvexHttpClient(deploymentUrl, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
  });

  beforeAll(async () => {
    await client.mutation(seed, {});
  });

  afterAll(async () => {
    await client.mutation(clear, {});
  });

  test("executes SQL directly in a Convex query context", async () => {
    const rows = await client.query(runInQuery, {
      source: `
        SELECT status, COUNT(*) AS count
        FROM users
        GROUP BY status
        ORDER BY count DESC
      `,
    });

    expect(rows).toEqual([
      { status: "active", count: 2 },
      { status: "inactive", count: 1 },
    ]);
  });

  test("executes SQL from an action through paginated scan queries", async () => {
    const rows = await client.action(runInAction, {
      source: `
        SELECT u.email AS email, SUM(o.total) AS revenue
        FROM users u
        JOIN orders o ON u.email = o.userEmail
        GROUP BY u.email
        ORDER BY revenue DESC
      `,
    });

    expect(rows).toEqual([
      { email: "a@gmail.com", revenue: 25 },
      { email: "c@gmail.com", revenue: 20 },
    ]);
  });

  test("uses schema indexes when planning action scans", async () => {
    const rows = await client.action(runInAction, {
      source: "SELECT COUNT(*) AS count FROM users WHERE status = 'active'",
    });

    expect(rows).toEqual([{ count: 2 }]);
  });
});
