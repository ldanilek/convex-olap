import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ConvexLikeContext, type ExecuteOptions, PlanExecutor } from "./executor.js";
import { type QueryPlan } from "./planner.js";

export type MaterializeOptions = ExecuteOptions & {
  format?: "json" | "jsonl";
};

export async function materializePlanToFile(
  ctx: ConvexLikeContext,
  plan: QueryPlan,
  filePath: string,
  options: MaterializeOptions = {},
): Promise<{ filePath: string; rows: number }> {
  const executor = new PlanExecutor();
  const rows = await executor.execute(ctx, plan, options);
  const contents =
    options.format === "jsonl"
      ? `${rows.map((row) => JSON.stringify(row)).join("\n")}${rows.length > 0 ? "\n" : ""}`
      : `${JSON.stringify(rows, null, 2)}\n`;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
  return { filePath, rows: rows.length };
}
