import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    email: v.string(),
    status: v.string(),
    age: v.number(),
  }).index("by_status", ["status"]),
  orders: defineTable({
    userEmail: v.string(),
    total: v.number(),
  }).index("by_userEmail", ["userEmail"]),
});
