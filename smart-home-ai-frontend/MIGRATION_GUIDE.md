# 前端页面迁移指南（Aetheris 系列 -> 主项目）

本文用于规范把外部 React/Tailwind 页面（如 `aetheris`、`aetheris-ai`）迁移到主项目 `smart-home-ai-frontend` 的流程，避免样式错乱、资源失效、重复布局等问题。

## 1. 适用范围

- 源项目：Vite + React + Tailwind v4 风格页面
- 目标项目：Next.js App Router + React + Tailwind v4
- 典型场景：
- 从源项目迁移整段 Landing Section 到 `app/(user)/home/page.tsx`
- 仅迁移某个区块（如 `Real-world Intelligence`）到既有页面中间位置

## 2. 迁移前检查（必须做）

1. 对齐框架与样式管线
- 源项目通常是 `vite`；目标项目是 `next`
- 确认目标项目 Tailwind v4 已工作（本项目通过 `@import "tailwindcss"` + `@tailwindcss/postcss`）

2. 识别布局边界
- 目标项目 `home` 页面由 `app/(user)/layout.tsx` 提供顶部导航和壳层
- 源页面若自带 `<nav>`、整页容器，要先决定是否删除或拆分

3. 识别全局样式风险
- 重点检查 `app/globals.css` 是否有 `*`、`h1`、`a` 等全局规则
- Tailwind v4 下，unlayered 全局规则可能压过 utility class，导致“类名写了但样式不生效”

4. 识别外链资源风险
- 图片外链可能过期/404（尤其 Unsplash 某些历史 URL）
- 404 的图片常触发浏览器 `ERR_BLOCKED_BY_ORB`，表现为“图片不显示”

## 3. 一次性基线修复（强烈建议）

为避免后续所有迁移反复踩坑，先统一样式优先级：

1. 把全局 reset 与基础元素样式放进 `@layer base`
- 包括：`*`、`html`、`body`、`h1/h2/h3`、`a` 等

2. 不要在页面局部容器里写会覆盖 utility 的强选择器
- 例如 `.xxx h1 { font-family: inherit; font-weight: inherit; }` 这类规则要谨慎

3. 迁移时优先复用 Tailwind class，不用新增强覆盖 CSS

## 4. 标准迁移流程（推荐顺序）

### Step A：定位要迁移的最小区块

1. 在源项目中找到对应 JSX 区块（例如 `Scenarios` / `CTA`）
2. 只复制“目标区块本体”，不复制不必要的页面壳（如整页 Navbar、Footer）
3. 记录依赖：
- 图标组件（`lucide-react`）
- 动画组件（`motion/react`）
- 该区块用到的 token class（如 `bg-surface`、`text-on-surface-variant`）

### Step B：落位到目标页面

1. 在 `app/(user)/home/page.tsx` 插入区块
2. 按产品要求放置顺序（例如：
- 在 `Vision to Power` 之后
- 在 `Silent Guardian` sticky 叙事之前）
3. 更新 import（新增图标、组件）

### Step C：处理布局差异

1. 源项目若有 `max-w-*` + `bg-*` 混用，注意背景是否被“限制在内容宽度”
2. 需要全宽背景时采用双层结构：
- 外层 `section` 负责背景与上下间距
- 内层 `max-w-*` 容器负责内容宽度

### Step D：资源稳定性校验

1. 对外链图片先做 HEAD 检查

```bash
curl -I 'https://example.com/your-image.jpg'
```

2. 必须是 `200` 且 `content-type: image/*`
3. 若 404 或返回 html，立即更换 URL（不要等线上报错）

### Step E：本地验证

1. 打开页面视觉检查（结构、间距、字体、背景）
2. 检查网络请求，确保关键图片 200
3. 最小 lint 校验改动文件

```bash
npx eslint 'app/(user)/home/page.tsx'
```

## 5. 常见问题 -> 原因 -> 处理

### 问题 1：迁移后字体/间距明显不对，像 Tailwind 没生效

- 原因：全局 unlayered 规则覆盖了 Tailwind utilities（v4 层级问题）
- 处理：
- 全局规则迁移到 `@layer base`
- 删除或弱化会覆盖 utility 的局部强选择器

### 问题 2：某一张图就是不显示

- 原因：外链失效（404），浏览器报 `ERR_BLOCKED_BY_ORB`
- 处理：
- `curl -I` 验证 URL
- 替换为可用图片链接并重新验证

### 问题 3：背景颜色只在中间一条区域显示

- 原因：`bg-*` 写在 `max-w-*` 容器上
- 处理：
- 改为“外层 section 背景 + 内层 max-w 内容”

### 问题 4：迁移后和主项目顶部导航冲突

- 原因：源区块包含自己的 Navbar
- 处理：
- 删除源 `<nav>`，只保留内容区块
- 统一使用 `app/(user)/layout.tsx` 提供的导航

## 6. 本项目推荐落点约定

- 首页主文件：`app/(user)/home/page.tsx`
- 全局样式：`app/globals.css`
- 跨页面布局：`app/(user)/layout.tsx`

迁移优先做“区块级拼装”，避免一次性整页替换。

## 7. 提交流程建议（团队协作）

1. 每次迁移只做一个主题区块
2. PR 描述要包含：
- 来源区块（来自哪个项目、哪个组件）
- 插入位置（在什么区块前后）
- 新增外链资源清单（含可用性校验）
- 风险点与处理（特别是 Tailwind v4 层级）
3. 附至少 2 张截图（桌面端/移动端）

## 8. 迁移完成验收清单（可复制）

- [ ] 区块位置正确（前后顺序符合需求）
- [ ] 无重复导航/重复 Footer
- [ ] 关键文案与按钮行为正确（例如跳转登录）
- [ ] 样式无错乱（字体、颜色、间距、背景）
- [ ] 外链图片全部 200 且可见
- [ ] 目标文件 lint 无 error
- [ ] 无新增高优先级全局覆盖规则

---

如后续迁移出现新坑，请把“问题现象 + 根因 + 修复方式”追加到本文的“常见问题”章节，持续沉淀团队经验。
