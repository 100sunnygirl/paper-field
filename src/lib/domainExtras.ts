/**
 * 领域强调色：多个领域不再只靠短码文字区分——领域头进度条、快捷切换条目等以
 * 同一颜色归组。色板固定六枚（与墨色系同饱和度的深色，保证在浅色界面上可读），
 * 不引入自由取色；信号黄不在色板内（保留给「打开 PDF」与选中提示）。
 */

export interface DomainAccent {
  id: string;
  label: string;
}

export const DOMAIN_ACCENTS: DomainAccent[] = [
  { id: "moss", label: "苔绿" },
  { id: "indigo", label: "黛蓝" },
  { id: "sienna", label: "赭石" },
  { id: "plum", label: "紫棠" },
  { id: "teal", label: "青碧" },
  { id: "amber", label: "琥珀" },
];

export function isDomainAccent(id: string | null | undefined): id is string {
  return Boolean(id && DOMAIN_ACCENTS.some((accent) => accent.id === id));
}

/** 领域强调色对应的 CSS 变量（--pf-accent-<id>，定义见 workstation.css token 区）。 */
export function domainAccentVar(id: string | null | undefined): string | null {
  return isDomainAccent(id) ? `var(--pf-accent-${id})` : null;
}
