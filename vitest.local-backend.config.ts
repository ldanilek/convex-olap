import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/local-backend/**/*.test.ts"],
    fileParallelism: false,
  },
});
