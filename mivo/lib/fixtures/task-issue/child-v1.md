<!-- 合成夹具:按 task-issue/v1 模板填写,不含任何真实仓库内容。审查机 #133 的段落解析、验收标准解析与代码判定项都用它。 -->
> 子 issue · 总 issue o/r#100 · 并行组 B · 对应 1 个 PR（PR 指向 main，正文写一行「任务 issue：o/r#12」）

## 目标

导出面板支持把选中的画布区域存成 PNG。

## 原因

用户要把局部画面贴进周报。

## 范围（可改）

<!-- 模板说明里的 `check-pr.mjs`、`__tests__/` 不是本 issue 的范围。
- [ ] SC99 模板示例里的验收标准不算。验证：unit
-->
- `src/export/regionPng.ts`：新增区域导出
- `src/export/panel/`：面板入口
- `src/i18n/locales/*/export.json`：文案
- `scripts/fixtures/export/**`：夹具
- `src/**/__tests__/*.test.ts`：相关测试
- `CHANGELOG.md`：记一行

## 不做

- 不改整张画布导出（#14）。

## 参考

- `docs/export.md`：导出约定

## 依赖

等 #10 合进 main 再开工；与 #11 并行，#11 先合。跨仓的 other/repo#5 只是参考。

## 待定问题

无

## 验收标准

- [ ] SC1 选中区域后导出的 PNG 尺寸等于选区乘以 DPR。验证：unit（测试点：`regionPng` 尺寸函数）
- [x] SC2 面板里多一个「导出选区」按钮。验证：browser-fixture（测试点：导出面板截图）
- [ ] SC3 mac 实机导出 4K 选区不卡顿。验证：cindy-mac
- [ ] SC4 文案三种语言齐全
- [ ] SC5 目标仓测试与 CI 全绿。验证：static
