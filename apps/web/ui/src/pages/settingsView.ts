import type { SettingFieldView, SettingsView } from "../api";

/**
 * 后端会按角色裁掉 /api/settings 的敏感字段（2026-10-11）。
 * 缺字段、空分组或整块缺失时都收成可渲染的形状：空分组不进菜单，不留空框。
 */
export function normalizeSettings(raw: unknown): SettingsView {
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<SettingsView>;
  const groups = (Array.isArray(src.groups) ? src.groups : [])
    .filter((g) => g && typeof g.title === "string" && g.title)
    .map((g) => ({
      title: g.title,
      fields: (Array.isArray(g.fields) ? g.fields : []).filter(
        (f): f is SettingFieldView => Boolean(f) && typeof f.key === "string" && Boolean(f.key),
      ),
    }))
    .filter((g) => g.fields.length > 0);
  const probes = (Array.isArray(src.probes) ? src.probes : []).filter(
    (p) => p && typeof p.id === "string" && typeof p.label === "string",
  );
  const out: SettingsView = { groups, probes };
  if (src.derived && typeof src.derived === "object") out.derived = src.derived;
  if (src.health && typeof src.health === "object") out.health = src.health;
  return out;
}

/** 选中的目录分组被裁掉时回到「外观」，不画空表单。 */
export function resolveGroup(group: string, view: SettingsView, virtual: ReadonlySet<string>): string {
  if (virtual.has(group)) return group;
  return view.groups.some((g) => g.title === group) ? group : "外观";
}

/** 表单初值：密钥一律空；被省略的 value 当空串，不写 undefined。 */
export function initialDraft(view: SettingsView): Record<string, string> {
  const init: Record<string, string> = {};
  for (const g of view.groups) {
    for (const f of g.fields) init[f.key] = f.kind === "secret" ? "" : f.value ?? "";
  }
  return init;
}

/** 要提交的值：密钥留空不改；后端省略了 value 的字段没改过就不提交，免得把真值写成空。 */
export function valuesToSave(view: SettingsView, draft: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const g of view.groups) {
    for (const f of g.fields) {
      const d = draft[f.key] ?? "";
      if (f.kind === "secret" || f.value === undefined) {
        if (d.trim()) values[f.key] = d;
      } else {
        values[f.key] = d;
      }
    }
  }
  return values;
}

/** 密钥框占位：有 last4 才露尾号。 */
export function secretPlaceholder(f: Pick<SettingFieldView, "set" | "last4">): string {
  if (!f.set) return "未填";
  return f.last4 ? `已填 ${f.last4}，留空不改` : "已填，留空不改";
}
