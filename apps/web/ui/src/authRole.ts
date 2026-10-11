import type { Me } from "./api";

/**
 * 前端唯一的「是不是管理员」判断。现用 `/api/auth/me` 的 `role === "admin"`；
 * 后端（开发哥）若改字段路径，只改这一行。
 */
export function isAdmin(user: Pick<Me, "role"> | null | undefined): boolean {
  return user?.role === "admin";
}
