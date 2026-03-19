# 第一阶段能力边界与 FAQ

## FAQ 1：为什么说是“可用但不实控”？
第一阶段先验证 Dify 的 Agent 架构、意图识别和流程编排，设备实控在第二阶段接入。

## FAQ 2：如果知识库没命中怎么办？
返回 knowledge_not_found，并提示补充文档后重试。

## FAQ 3：主入口应该调用哪个应用？
只调用 01_main_orchestrator_chatflow，其他 workflow 由主入口内部路由。

## FAQ 4：为什么模板有 user_id/session_id/context？
这些是预留字段，便于第二阶段接 API 时对接会话追踪。当前阶段可为空。
