'use client'

/**
 * 帮助文档站 — 从 elevated-admin-dashboard/DocsSiteView 迁移
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ChevronRight, Search, ArrowLeft,
  Blocks, Rocket, Bot, HelpCircle, Code,
  LayoutDashboard, Database, Cpu, UserCog,
  Settings as SettingsIcon, ArrowRight, Lightbulb,
  BookOpen, Zap, Shield, Wrench, Layers, Menu, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ApiReferenceView from '@/components/docs/ApiReferenceView'
import { apiDocsApi } from '@/lib/api/api-docs'
import type { ApiReferenceModule, DocsViewMode } from '@/types/api-docs'
import { businessErrorMessage } from '@/lib/ui/business-error'
import { UnifiedSelect } from '@/components/ui/UnifiedSelect'

/* ══════════════════════════════════════════════
   Sidebar Section Item
   ══════════════════════════════════════════════ */
type DocSection =
  | 'overview'
  | 'quickstart'
  | 'template-00'
  | 'template-function'
  | 'template-usage'
  | 'template-config'
  | 'template-custom'
  | 'faq'
  | 'dev-environment'
  | 'dev-guide'

const DOC_SECTIONS: DocSection[] = [
  'overview',
  'quickstart',
  'template-00',
  'template-function',
  'template-usage',
  'template-config',
  'template-custom',
  'faq',
  'dev-environment',
  'dev-guide',
]

interface SideItem {
  id: DocSection
  icon: LucideIcon
  label: string
  children?: { id: DocSection; label: string }[]
}

const SIDE_NAV: SideItem[] = [
  { id: 'overview', icon: Blocks, label: '平台功能说明' },
  { id: 'quickstart', icon: Rocket, label: '快速开始与操作指南' },
  {
    id: 'template-00', icon: Bot, label: '模板说明文档',
    children: [
      { id: 'template-00', label: '模板概览' },
      { id: 'template-function', label: '功能说明' },
      { id: 'template-usage', label: '使用方法' },
      { id: 'template-config', label: '配置方式' },
      { id: 'template-custom', label: '定制指南' },
    ],
  },
  { id: 'faq', icon: HelpCircle, label: '常见问题 FAQ' },
  { id: 'dev-environment', icon: Wrench, label: '开发环境' },
  { id: 'dev-guide', icon: Code, label: '开发与扩展指南' },
]

const DOCS_VIEW_MODE_KEY = 'docs-view-mode'
const DOCS_API_MODULE_KEY = 'docs-api-module'
const DOCS_API_ENDPOINT_KEY = 'docs-api-endpoint'
const DEFAULT_API_MODULE_ID = 'local-model'

const API_METHOD_CLASS: Record<string, string> = {
  GET: 'bg-blue-100 text-blue-700',
  POST: 'bg-emerald-100 text-emerald-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-violet-100 text-violet-700',
  DELETE: 'bg-rose-100 text-rose-700',
}

const DOC_LABELS: Record<DocSection, string> = {
  overview: '平台功能说明',
  quickstart: '快速开始与操作指南',
  'template-00': '模板概览',
  'template-function': '功能说明',
  'template-usage': '使用方法',
  'template-config': '配置方式',
  'template-custom': '定制指南',
  faq: '常见问题 FAQ',
  'dev-environment': '开发环境',
  'dev-guide': '开发与扩展指南',
}

const FEATURE_INDEX = [
  { name: '本地开源大语言模型与量化推理', pages: '/models、/chat', api: 'local-model', record: '模型列表、当前模型、推理测试响应、资源占用、离线运行状态' },
  { name: '智能体框架与应用', pages: '/agents、/dify、/conversation-records', api: 'agent-external', record: 'Dify 模板、运行记录、Workflow Run ID、输入输出与错误信息' },
  { name: '智能家居设备控制与状态回读', pages: '/devices、/home-assistant、/monitor', api: 'smart-home', record: '设备状态、控制反馈、operation_logs、HA 状态' },
  { name: '电子沙盘与虚拟设备联调', pages: '/sandbox', api: 'sandbox', record: '虚拟设备数量、场景执行、运行日志、真实沙盘接入状态' },
  { name: '知识库增强与 RAG 检索', pages: '/knowledge、/conversation-records', api: 'knowledge', record: '数据集 ID、文档索引、命中片段、RAG 回答、Dify 运行记录' },
  { name: '用户、接口文档和系统配置', pages: '/users、/settings、/docs、/help-docs、/api-console', api: 'system', record: '用户审计、配置保存记录、API 参考、帮助教程' },
]

/* ══════════════════════════════════════════════
   Doc Page Content Components
   ══════════════════════════════════════════════ */

function OverviewContent() {
  const modules = [
    { icon: LayoutDashboard, title: '系统运行状况', desc: '系统运行状态、用户统计、服务健康度一览。可视化展示系统运行状况、使用情况、统计信息。' },
    { icon: Database, title: '知识库管理', desc: '文档导入、向量化存储、语义检索。支持多种格式文档的处理与知识增量管理。' },
    { icon: Cpu, title: '模型运行状态查看', desc: '支持本地 LLM 模型的部署、拉取、删除和切换，可部署 6B-10B 级模型并使用量化推理；当前安装与可运行规格以模型页面和交付机实测为准。' },
    { icon: Bot, title: '智能体框架与应用', desc: '基于 Dify 的智能体应用管理。平台登记已发布的 Dify 应用，绑定 API Key 并设为当前运行智能体。' },
    { icon: UserCog, title: '用户管理', desc: '用户增删改查、角色分配、密码管理、权限控制。' },
    { icon: SettingsIcon, title: '系统设置', desc: '服务地址配置、安全策略、连接测试、系统信息。' },
  ]
  return (
    <>
      <header className="mb-12">
        <h1 className="mb-4 text-4xl font-black text-slate-900 dark:text-white">平台功能说明</h1>
        <p className="text-lg text-slate-500 dark:text-slate-400 leading-relaxed max-w-2xl">
          基于智慧家居场景的大语言模型智能体科研应用平台，提供六大核心功能模块。
        </p>
      </header>

      <section className="mb-16" id="introduction">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-8">系统概述</h2>
        <div className="bg-white dark:bg-slate-900 p-8 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800">
          <p className="text-slate-500 dark:text-slate-400 leading-loose mb-6">
            本平台集成了本地大语言模型服务（Ollama）、智能体框架（Dify）、智能家居对接（Home Assistant）、
            知识增强（RAG）、应用模板库和 Web 管理界面六大功能模块。支持本地化部署，
            本地模型推理及已完成本地部署的服务可在局域网内运行；Dify、Home Assistant、知识库和时序能力以当前运行配置与服务状态为准。
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-6 bg-slate-50 dark:bg-slate-800 rounded-xl">
              <div className="flex items-center gap-2 mb-2"><Zap size={16} className="text-amber-500" /><h4 className="font-bold dark:text-white">离线运行</h4></div>
              <p className="text-sm text-slate-500 dark:text-slate-400">本地模型及平台服务支持本地部署；外部模型、镜像下载和第三方服务仍取决于实际网络与部署方式。</p>
            </div>
            <div className="p-6 bg-slate-50 dark:bg-slate-800 rounded-xl">
              <div className="flex items-center gap-2 mb-2"><Shield size={16} className="text-emerald-500" /><h4 className="font-bold dark:text-white">安全合规</h4></div>
              <p className="text-sm text-slate-500 dark:text-slate-400">基于符合国家法律法规的开源大模型构建，JWT 认证 + RBAC 鉴权。</p>
            </div>
          </div>
        </div>
      </section>

      <section className="mb-16" id="core-modules">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-8">核心模块</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {modules.map(m => (
            <div key={m.title} className="group bg-white dark:bg-slate-900 p-6 rounded-2xl hover:shadow-xl transition-all duration-300 border border-slate-100 dark:border-slate-800">
              <div className="w-12 h-12 bg-blue-600/10 dark:bg-blue-400/10 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center mb-6 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                <m.icon size={24} />
              </div>
              <h3 className="text-lg font-bold mb-2 dark:text-white">{m.title}</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">{m.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-16" id="tech-stack">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-8">技术架构</h2>
        <div className="bg-white dark:bg-slate-900 p-8 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {[
              { label: '后端框架', value: 'FastAPI + SQLAlchemy' },
              { label: '前端框架', value: 'Next.js 16 + React 19' },
              { label: '模型服务', value: 'Ollama (本地)' },
              { label: '智能体框架', value: 'Dify (可本地部署)' },
              { label: '智能家居', value: 'Home Assistant' },
              { label: '时序数据库', value: 'InfluxDB' },
            ].map(item => (
              <div key={item.label} className="p-4 bg-slate-50 dark:bg-slate-800 rounded-xl">
                <p className="mb-1 text-[10px] font-bold text-slate-400 dark:text-slate-500">{item.label}</p>
                <p className="text-sm font-bold text-slate-900 dark:text-white">{item.value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mb-16" id="function-index">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-8">功能能力索引</h2>
        <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="hidden grid-cols-[1.1fr_0.9fr_0.8fr_1.3fr] gap-4 bg-slate-50 px-6 py-4 text-[10px] font-black text-slate-400 dark:bg-slate-800 dark:text-slate-500 lg:grid">
            <span>功能能力</span>
            <span>页面入口</span>
            <span>API 参考</span>
            <span>运行记录</span>
          </div>
          {FEATURE_INDEX.map((item) => (
            <div key={item.name} className="grid grid-cols-1 gap-3 border-t border-slate-100 px-6 py-5 text-sm dark:border-slate-800 lg:grid-cols-[1.1fr_0.9fr_0.8fr_1.3fr]">
              <div className="font-bold text-slate-900 dark:text-white"><span className="mb-1 block text-[10px] font-black text-slate-400 lg:hidden">功能能力</span>{item.name}</div>
              <div className="break-all text-slate-500 dark:text-slate-400"><span className="mb-1 block text-[10px] font-black text-slate-400 lg:hidden">页面入口</span>{item.pages}</div>
              <div><span className="mb-1 block text-[10px] font-black text-slate-400 lg:hidden">API 参考</span><Link href={`/docs?view=api&module=${item.api}`} className="inline-flex min-h-8 items-center font-bold text-blue-600 dark:text-blue-300">查看 {item.api}</Link></div>
              <div className="leading-6 text-slate-500 dark:text-slate-400"><span className="mb-1 block text-[10px] font-black leading-4 text-slate-400 lg:hidden">运行记录</span>{item.record}</div>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

function QuickStartContent() {
  const steps = [
    { step: '1', title: '登录系统', desc: '使用管理员提供的平台账号登录。首次登录后请及时修改初始密码，不要在文档、截图或聊天记录中传播账号凭证。' },
    { step: '2', title: '拉取模型', desc: '进入「模型拉取与验证」，先执行资源预检，再从官方模型目录选择适合当前设备资源的模型并创建拉取任务。' },
    { step: '3', title: '设为当前模型', desc: '模型拉取完成并通过推理验证后，将其设为当前使用模型；页面会阻止重复切换和不支持对话推理的模型。' },
    { step: '4', title: '绑定最终智能体', desc: '进入 /agents，登记已发布的 Dify Chatflow，填写 App ID、聊天或控制台地址、应用 API Key，并设为当前运行智能体。' },
    { step: '5', title: '开始使用', desc: '从工作台进入「智能体对话」「设备控制」「电子沙盘」或「设备状态与系统监控」，按页面实时状态开始联调。' },
    { step: '6', title: '查看运行记录', desc: '在「会话与运行记录」「操作日志」、知识库详情、设备详情和系统设置中核对运行结果与来源。' },
    { step: '7', title: '确认外部连接', desc: '真实沙盘、RAG Dataset、密钥轮换和外部账号等运行条件，可在对应模块查看配置状态。' },
  ]
  return (
    <>
      <header className="mb-12">
        <h1 className="mb-4 text-4xl font-black text-slate-900 dark:text-white">快速开始与操作指南</h1>
        <p className="text-lg text-slate-500 dark:text-slate-400 leading-relaxed max-w-2xl">
          从零开始使用平台的完整步骤指南。按照以下步骤即可快速上手。
        </p>
      </header>

      <section className="mb-16">
        <div className="space-y-6">
          {steps.map(s => (
            <div key={s.step} className="flex gap-6 bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-100 dark:border-slate-800">
              <div className="w-10 h-10 bg-blue-600 text-white rounded-full flex items-center justify-center text-lg font-black shrink-0">
                {s.step}
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-1">{s.title}</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

type TemplateDocPage = {
  label: string
  eyebrow: string
  summary: string
  sections: {
    id: string
    title: string
    paragraphs?: string[]
    bullets?: string[]
    table?: { name: string; value: string }[]
  }[]
}

function TemplateContent({ id, onNavigate }: { id: DocSection; onNavigate: (section: DocSection) => void }) {
  const pages: Record<string, TemplateDocPage> = {
    'template-00': {
      label: '模板概览',
      eyebrow: '统一智能体模板',
      summary: '本模板是一份面向智慧家居科研应用的一体化 Dify Chatflow。模板将设备控制、知识库问答、数据查询和通用问答统一在同一个应用内，减少多应用编排、子 Workflow Key 管理和运行链路切换带来的复杂度。',
      sections: [
        {
          id: 'scope',
          title: '适用范围',
          paragraphs: [
            'Chatflow 面向平台内的智能体对话、设备控制、知识库问答和运行数据查询场景。用户通过统一入口提交自然语言请求，模板根据意图将请求分发到相应分支，并将平台接口返回结果整理为可读回复。',
            '当前交付主路径以 00 单体 Chatflow 为准。历史拆分模板保留在仓库和模板库中用于架构追溯，不作为帮助文档主路径，也不要求用户在常规部署中维护多个子流程应用。',
          ],
        },
        {
          id: 'assets',
          title: '模板资产',
          table: [
            { name: '模板文件', value: '00 Smart Home Unified Chatflow.yml' },
            { name: '模板类型', value: 'Dify advanced-chat / Chatflow' },
            { name: '平台入口', value: '/agents 绑定当前运行智能体，/chat 发起统一对话' },
            { name: '后端依赖', value: '设备搜索与控制、监控查询、知识库检索、系统状态等平台 API' },
          ],
        },
        {
          id: 'structure',
          title: '文档结构',
          bullets: [
            '功能说明：说明 Chatflow 内置能力、分支职责和平台接口边界。',
            '使用方法：说明从导入、发布、绑定到验证的操作流程。',
            '配置方式：说明 Dify 变量、平台智能体配置、知识库和运行时服务配置。',
            '定制指南：说明如何扩展意图、接口、知识库策略、输出格式和测试规范。',
          ],
        },
      ],
    },
    'template-function': {
      label: '功能说明',
      eyebrow: '能力与流程',
      summary: '统一 Chatflow 通过意图识别、分支执行和结果汇总三个阶段组织业务能力。每条分支只负责一种清晰任务，避免在同一节点中混合设备控制、知识问答和数据分析逻辑。',
      sections: [
        {
          id: 'pipeline',
          title: '整体处理流程',
          bullets: [
            '接收用户输入后，先进行问题增强和上下文整理，保留必要的设备名称、位置、时间范围和查询目标。',
            '通过问题分类节点识别请求类型，按设备控制、知识问答、数据查询、通用问答进入不同分支。',
            '分支完成后统一整理输出，保留关键执行结果、数据来源、异常信息或下一步建议。',
          ],
        },
        {
          id: 'branches',
          title: '内置分支能力',
          table: [
            { name: '设备控制', value: '解析设备、位置和动作，调用平台设备搜索与控制接口，控制结果以平台接口和 HA 状态回读为准。' },
            { name: '知识问答', value: '调用 Dify 知识库检索节点，基于绑定 dataset 的命中片段生成回答，并保留引用依据。' },
            { name: '数据查询', value: '调用平台 /monitor/agent-query 查询实时或历史运行数据，返回数据来源、接口路径和摘要结果。' },
            { name: '通用问答', value: '处理未命中业务分支的问题，给出平台能力说明或引导用户补充条件。' },
          ],
        },
        {
          id: 'boundary',
          title: '运行边界',
          paragraphs: [
            '模板不直接保存设备密钥、Dify 应用密钥、HA Token 或数据库凭证。所有敏感信息应通过 Dify 应用变量、平台系统设置或服务器环境变量维护。',
            '真实硬件控制以平台设备台账、实体映射、Home Assistant 状态和操作日志为准。模板负责调用和表达结果，不把未接入设备包装为已完成控制。',
          ],
        },
      ],
    },
    'template-usage': {
      label: '使用方法',
      eyebrow: '导入与验证流程',
      summary: '使用该模板时，应先在 Dify 中导入并发布 Chatflow，再在平台中登记应用信息。平台通过当前运行智能体调用该 Chatflow，用户无需分别选择设备控制、知识问答或数据查询应用。',
      sections: [
        {
          id: 'import',
          title: '导入模板',
          bullets: [
            '进入 Dify 控制台，选择导入 DSL 文件，上传 `00 Smart Home Unified Chatflow.yml`。',
            '导入后检查画布节点是否完整，包括问题增强、意图分类、设备控制、知识库检索、数据查询和回答输出节点。',
            '确认模型供应商、模型名称和工作区权限可用，再保存并发布应用。',
          ],
        },
        {
          id: 'bind',
          title: '平台登记',
          bullets: [
            '进入平台 `/agents`，新增或编辑智能体实例，填写 Dify 应用 ID、应用地址和应用 API Key。',
            '将该实例设为当前运行智能体后，平台 `/chat`、智能体测试运行和运行记录将统一使用该实例。',
            '若需要更换 Dify 应用，先新增新实例并完成测试，再切换当前运行实例，避免直接覆盖可用配置。',
          ],
        },
        {
          id: 'verify',
          title: '验证建议',
          bullets: [
            '设备控制：使用非破坏性设备或虚拟 HA 实体执行一次开关类控制，并核对平台操作日志和 HA 状态。',
            '知识问答：选择已绑定 dataset 的问题，确认回答包含知识库依据或明确未命中提示。',
            '数据查询：询问系统状态、室内温度或历史趋势，确认回复包含数据来源和平台接口结果。',
          ],
        },
      ],
    },
    'template-config': {
      label: '配置方式',
      eyebrow: '变量与运行时配置',
      summary: '模板配置分为 Dify 应用变量、平台智能体实例、平台运行时服务三层。三层配置职责不同，不能把平台密钥写入 DSL 文件，也不能用前端页面硬编码替代运行时配置。',
      sections: [
        {
          id: 'dify-vars',
          title: 'Dify 应用变量',
          table: [
            { name: 'BACKEND_BASE_URL', value: '平台后端访问地址，例如交付环境后端网关地址。节点中的 HTTP 请求通过该变量调用平台接口。' },
            { name: 'AGENT_API_KEY', value: '平台 Agent 代理调用密钥，变量类型应为 secret，用于保护 Dify 调用平台接口的权限。' },
            { name: '知识库 dataset', value: '在知识库检索节点绑定真实 dataset；模板文件不内置交付环境 dataset ID。' },
          ],
        },
        {
          id: 'platform-config',
          title: '平台智能体配置',
          bullets: [
            '`/agents` 维护 Dify 应用 ID、应用地址、应用 API Key、当前运行状态和测试结果。',
            '应用 API Key 只在平台后端保存和调用，前端页面不展示明文。',
            '当前运行智能体用于 `/chat` 默认调用链路，也用于专家复核时的统一入口。',
          ],
        },
        {
          id: 'runtime-config',
          title: '运行时服务配置',
          bullets: [
            '设备控制依赖平台设备模块、网关配置、实体映射和 Home Assistant 可达状态。',
            '数据查询依赖平台监控接口、HA History 或 InfluxDB 等数据源配置。',
            '知识问答依赖 Dify dataset、文档索引状态和检索节点配置。',
          ],
        },
      ],
    },
    'template-custom': {
      label: '定制指南',
      eyebrow: '扩展与二次开发',
      summary: '二次定制应优先保持单体 Chatflow 的主结构稳定，在清晰边界内扩展新的意图、接口或回答模板。涉及硬件、知识库和外部系统的定制，需要同时更新平台接口、运行日志和验收文档。',
      sections: [
        {
          id: 'intent',
          title: '扩展意图分支',
          bullets: [
            '新增业务分支前，先定义用户问题特征、必要参数、目标接口和失败反馈。',
            '在问题分类节点中增加新类别，并为该类别配置独立的处理节点和输出节点。',
            '避免把多个无关业务放入同一提示词中处理，保持分支职责可测试、可追踪。',
          ],
        },
        {
          id: 'api',
          title: '扩展平台接口',
          bullets: [
            '新增外部功能调用时，优先通过平台后端封装接口，再由 Dify HTTP 节点调用平台接口。',
            '接口响应应包含结果状态、数据来源、错误信息和必要的审计标识，便于运行记录追踪。',
            '涉及设备或硬件的接口必须区分平台配置能力、虚拟联调和真实硬件验收状态。',
          ],
        },
        {
          id: 'quality',
          title: '定制后检查',
          table: [
            { name: '导入检查', value: 'DSL 可导入，节点无缺失，环境变量可配置。' },
            { name: '运行检查', value: '每个分支至少有一组成功样例和一组失败样例。' },
            { name: '日志检查', value: '平台运行记录、操作日志或外部系统日志能追溯关键调用。' },
            { name: '文档检查', value: '同步更新模板说明、API 参考和交付验收口径。' },
          ],
        },
      ],
    },
  }
  const page = pages[id] || pages['template-00']
  return (
    <>
      <header className="mb-10 border-b border-slate-200 pb-8 dark:border-slate-800">
        <div className="mb-3 text-xs font-black text-blue-600 dark:text-blue-300">{page.eyebrow}</div>
        <h1 className="font-sans text-[32px] font-extrabold leading-tight tracking-normal text-slate-950 dark:text-white">Chatflow 模板说明文档</h1>
        <p className="mt-5 max-w-3xl text-[15px] leading-8 text-slate-600 dark:text-slate-300">{page.summary}</p>
      </header>

      <div className="mb-10 flex flex-wrap gap-2">
        {[
          { id: 'template-00', label: '模板概览' },
          { id: 'template-function', label: '功能说明' },
          { id: 'template-usage', label: '使用方法' },
          { id: 'template-config', label: '配置方式' },
          { id: 'template-custom', label: '定制指南' },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id as DocSection)}
            className={`rounded-full border px-4 py-2 text-sm font-bold transition ${
              id === item.id
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:text-blue-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {page.sections.map((section) => (
        <section key={section.id} className="mb-10" id={section.id}>
          <div className="mb-4 flex items-center gap-3">
            <div className="h-8 w-1 rounded-full bg-blue-600" />
            <h2 className="text-xl font-extrabold tracking-normal text-slate-950 dark:text-white">{section.title}</h2>
          </div>
          <div className="space-y-5 text-[15px] leading-8 text-slate-600 dark:text-slate-300">
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            {section.bullets ? (
              <ul className="space-y-3">
                {section.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-3">
                    <span className="mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {section.table ? (
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                {section.table.map((row) => (
                  <div key={row.name} className="grid gap-3 border-b border-slate-100 px-5 py-4 last:border-b-0 dark:border-slate-800 md:grid-cols-[180px_1fr]">
                    <div className="text-sm font-extrabold text-slate-900 dark:text-white">{row.name}</div>
                    <div>{row.value}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ))}
    </>
  )
}

function FaqContent() {
  const faqs = [
    { q: 'Ollama 连接不上怎么办？', a: '检查 Ollama 服务是否启动（运行 ollama serve），确认系统设置中的 Ollama 地址配置正确（默认 http://localhost:11434）。' },
    { q: '模型拉取失败或进度停止？', a: '先在“模型拉取与验证”页面查看资源预检、磁盘余量和任务错误；确认镜像源与网络可达后再重试，不要仅依据参数规模估算当前机器一定可运行。' },
    { q: '智能体对话无响应？', a: '确认 /agents 中已有当前运行智能体，实例级 Dify 应用 API Key 已配置；再检查 Dify 画布里的 BACKEND_BASE_URL、AGENT_API_KEY 和知识库绑定。' },
    { q: '如何导入 Dify 模板？', a: '在 Dify 控制台导入 00 Smart Home Unified Chatflow.yml，完成应用变量、模型和知识库配置后发布应用，再到 /agents 登记 App ID、应用地址和应用 API Key。' },
    { q: '支持哪些模型？', a: '以当前 Ollama 版本可识别的模型、平台官方目录和资源预检结果为准。模型是否适合对话、向量检索以及当前设备内存与存储，需要在拉取前预检并在完成后实际验证。' },
    { q: '如何进行二次开发？', a: '后端基于 FastAPI（MIT 协议），前端基于 Next.js（MIT 协议），智能体基于 Dify（开源）。可直接修改源码扩展功能。' },
  ]
  return (
    <>
      <header className="mb-12">
        <h1 className="mb-4 text-4xl font-black text-slate-900 dark:text-white">常见问题 FAQ</h1>
        <p className="text-lg text-slate-500 dark:text-slate-400 leading-relaxed max-w-2xl">
          常见问题与解决方案汇总。如有其他问题请联系技术支持。
        </p>
      </header>
      <div className="space-y-4">
        {faqs.map(f => (
          <div key={f.q} className="p-6 bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800">
            <h4 className="font-bold mb-2 text-blue-600 dark:text-blue-400">{f.q}</h4>
            <p className="text-slate-500 dark:text-slate-400 text-sm leading-relaxed">{f.a}</p>
          </div>
        ))}
      </div>
    </>
  )
}

function DevEnvironmentContent() {
  const environments = [
    {
      title: '基础开发环境',
      url: 'http://42.240.132.79:8443/',
      description: '提供基础开发环境，支持代码编辑、基本调试等能力，适合作为平台功能扩展与接口联调的基础开发入口。',
      bullets: ['支持代码编辑', '支持基本调试'],
    },
    {
      title: '交互式开发环境',
      url: 'http://42.240.132.79:8888/',
      description: '提供交互式开发环境（Jupyter Notebook），支持基础数据分析、模型调试等能力，适合作为科研实验与模型验证入口。',
      bullets: ['支持基础数据分析', '支持模型调试'],
    },
  ]

  return (
    <>
      <header className="mb-12">
        <h1 className="mb-4 text-4xl font-black text-slate-900 dark:text-white">开发环境</h1>
        <p className="text-lg text-slate-500 dark:text-slate-400 leading-relaxed max-w-3xl">
          本页提供平台配套开发环境入口，可直接访问基础开发环境与交互式开发环境，便于进行代码编辑、基本调试、数据分析与模型调试。
        </p>
      </header>

      <section className="mb-16" id="dev-environments">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {environments.map((item) => (
            <a
              key={item.title}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="group rounded-3xl border border-slate-200 bg-white p-7 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-blue-200 hover:shadow-xl dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-black text-slate-900 dark:text-white">{item.title}</h2>
                </div>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-500 transition-colors group-hover:bg-blue-600 group-hover:text-white dark:bg-slate-800 dark:text-slate-300">
                  <ArrowRight size={18} />
                </div>
              </div>

              <p className="mb-5 text-sm leading-7 text-slate-500 dark:text-slate-400">{item.description}</p>

              <div className="mb-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700 dark:border-slate-800 dark:bg-slate-950/60 dark:text-slate-300">
                {item.url}
              </div>

              <div className="mb-6 flex flex-wrap gap-2">
                {item.bullets.map((bullet) => (
                  <span
                    key={bullet}
                    className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                  >
                    {bullet}
                  </span>
                ))}
              </div>

              <div className="inline-flex items-center gap-2 text-sm font-bold text-blue-600 transition-colors group-hover:text-blue-700 dark:text-blue-300 dark:group-hover:text-blue-200">
                打开开发环境
                <ArrowRight size={14} />
              </div>
            </a>
          ))}
        </div>
      </section>
    </>
  )
}

function DevGuideContent() {
  return (
    <>
      <header className="mb-12">
        <h1 className="mb-4 text-4xl font-black text-slate-900 dark:text-white">开发与扩展指南</h1>
        <p className="text-lg text-slate-500 dark:text-slate-400 leading-relaxed max-w-2xl">
          如何基于本平台进行二次开发和功能扩展。
        </p>
      </header>

      {[
        { title: '项目结构', content: '后端：app/routers/ 下按模块组织路由，app/services/ 下封装外部服务调用，app/models/ 定义数据模型。\n前端：app/(dashboard)/ 为统一工作台路由，app/(user)/ 保留公共首页与帮助文档，lib/ 下的工具库可复用。' },
        { title: '添加新 API 端点', content: '1. 在 app/routers/ 下创建新路由文件\n2. 定义 Pydantic Schema 用于请求/响应验证\n3. 在 app/main.py 中注册路由\n4. 前端使用 apiClient 调用新端点' },
        { title: '扩展智能体能力', content: '1. 在 Dify 中创建新的 Workflow 子流程\n2. 配置 HTTP Request 节点对接外部 API\n3. 在主编排 Chatflow 中添加新的意图分支\n4. 更新路由节点的判断条件' },
        { title: '对接新设备系统', content: '1. 在 app/services/ 下创建新的设备服务封装\n2. 在 app/routers/devices.py 中添加新端点\n3. 在 Dify 的家居控制 Workflow 中添加对应的调用节点' },
      ].map(section => (
        <section key={section.title} className="mb-6">
          <div className="bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-100 dark:border-slate-800">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-3">{section.title}</h3>
            <pre className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed whitespace-pre-wrap">{section.content}</pre>
          </div>
        </section>
      ))}
    </>
  )
}

/* ══════════════════════════════════════════════
   Main Docs Page
   ══════════════════════════════════════════════ */

export default function DocsPage() {
  const [active, setActive] = useState<DocSection>('overview')
  const [viewMode, setViewMode] = useState<DocsViewMode>('docs')
  const [routeStateReady, setRouteStateReady] = useState(false)
  const [activeApiModuleId, setActiveApiModuleId] = useState(DEFAULT_API_MODULE_ID)
  const [activeApiEndpointSlug, setActiveApiEndpointSlug] = useState('')
  const [apiModules, setApiModules] = useState<ApiReferenceModule[]>([])
  const [apiModuleDetails, setApiModuleDetails] = useState<Record<string, ApiReferenceModule>>({})
  const [apiLoading, setApiLoading] = useState(true)
  const [apiModuleLoading, setApiModuleLoading] = useState(false)
  const [apiError, setApiError] = useState('')
  const [apiErrorScope, setApiErrorScope] = useState<'catalog' | 'module' | ''>('')
  const [apiFilterText, setApiFilterText] = useState('')
  const [docSearchText, setDocSearchText] = useState('')
  const [headerSearchFocused, setHeaderSearchFocused] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const apiCatalogAbortRef = useRef<AbortController | null>(null)
  const apiCatalogRequestRef = useRef(0)
  const apiModuleAbortRef = useRef<AbortController | null>(null)
  const apiModuleRequestRef = useRef(0)

  const tocItems: Record<DocSection, { label: string; href: string }[]> = {
    'overview': [
      { label: '系统概述', href: '#introduction' },
      { label: '核心模块', href: '#core-modules' },
      { label: '技术架构', href: '#tech-stack' },
      { label: '功能能力索引', href: '#function-index' },
    ],
    'quickstart': [{ label: '操作步骤', href: '#steps' }],
    'template-00': [{ label: '适用范围', href: '#scope' }, { label: '模板资产', href: '#assets' }, { label: '文档结构', href: '#structure' }],
    'template-function': [{ label: '整体处理流程', href: '#pipeline' }, { label: '内置分支能力', href: '#branches' }, { label: '运行边界', href: '#boundary' }],
    'template-usage': [{ label: '导入模板', href: '#import' }, { label: '平台登记', href: '#bind' }, { label: '验证建议', href: '#verify' }],
    'template-config': [{ label: 'Dify 应用变量', href: '#dify-vars' }, { label: '平台智能体配置', href: '#platform-config' }, { label: '运行时服务配置', href: '#runtime-config' }],
    'template-custom': [{ label: '扩展意图分支', href: '#intent' }, { label: '扩展平台接口', href: '#api' }, { label: '定制后检查', href: '#quality' }],
    'faq': [{ label: '常见问题', href: '#faq' }],
    'dev-environment': [{ label: '开发环境入口', href: '#dev-environments' }],
    'dev-guide': [{ label: '开发指南', href: '#dev' }],
  }

  const renderContent = () => {
    if (active === 'overview') return <OverviewContent />
    if (active === 'quickstart') return <QuickStartContent />
    if (active.startsWith('template-')) return <TemplateContent id={active} onNavigate={setActive} />
    if (active === 'faq') return <FaqContent />
    if (active === 'dev-environment') return <DevEnvironmentContent />
    if (active === 'dev-guide') return <DevGuideContent />
    return <OverviewContent />
  }

  useEffect(() => {
    const savedViewMode = window.localStorage.getItem(DOCS_VIEW_MODE_KEY)
    const savedApiModuleId = window.localStorage.getItem(DOCS_API_MODULE_KEY)
    const savedApiEndpointSlug = window.localStorage.getItem(DOCS_API_ENDPOINT_KEY)
    const params = new URLSearchParams(window.location.search)
    const urlViewMode = params.get('view')
    const urlModule = params.get('module')
    const urlEndpoint = params.get('endpoint')
    const urlSection = params.get('section')

    if (urlViewMode === 'docs' || urlViewMode === 'api') {
      setViewMode(urlViewMode)
    } else if (savedViewMode === 'docs' || savedViewMode === 'api') {
      setViewMode(savedViewMode)
    }
    if (urlSection && DOC_SECTIONS.includes(urlSection as DocSection)) {
      setActive(urlSection as DocSection)
      setViewMode('docs')
    } else if (urlSection?.startsWith('template-')) {
      setActive('template-00')
      setViewMode('docs')
    }
    if (urlModule) {
      setActiveApiModuleId(urlModule)
    } else if (savedApiModuleId) {
      setActiveApiModuleId(savedApiModuleId)
    }
    if (urlEndpoint) {
      setActiveApiEndpointSlug(urlEndpoint)
    } else if (savedApiEndpointSlug) {
      setActiveApiEndpointSlug(savedApiEndpointSlug)
    }
    setRouteStateReady(true)
  }, [])

  const loadApiCatalog = useCallback(async (force = false) => {
    const requestId = ++apiCatalogRequestRef.current
    apiCatalogAbortRef.current?.abort()
    const controller = new AbortController()
    apiCatalogAbortRef.current = controller
    setApiLoading(true)
    setApiError('')
    setApiErrorScope('')
    try {
      const res = await apiDocsApi.listModules(false, false, force, controller.signal)
      if (controller.signal.aborted || apiCatalogRequestRef.current !== requestId) return
      setApiModules(res.modules)
    } catch (error) {
      if (!controller.signal.aborted && apiCatalogRequestRef.current === requestId) {
        setApiError(businessErrorMessage(error, { fallback: 'API 模块目录加载失败', service: 'API 文档目录' }))
        setApiErrorScope('catalog')
      }
    } finally {
      if (apiCatalogAbortRef.current === controller) apiCatalogAbortRef.current = null
      if (apiCatalogRequestRef.current === requestId) setApiLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadApiCatalog()
    return () => {
      apiCatalogRequestRef.current += 1
      apiCatalogAbortRef.current?.abort()
      apiCatalogAbortRef.current = null
    }
  }, [loadApiCatalog])

  useEffect(() => {
    window.localStorage.setItem(DOCS_VIEW_MODE_KEY, viewMode)
  }, [viewMode])

  useEffect(() => {
    window.localStorage.setItem(DOCS_API_MODULE_KEY, activeApiModuleId)
  }, [activeApiModuleId])

  useEffect(() => {
    window.localStorage.setItem(DOCS_API_ENDPOINT_KEY, activeApiEndpointSlug)
  }, [activeApiEndpointSlug])

  const currentApiModule = useMemo(
    () => apiModuleDetails[activeApiModuleId]
      ?? apiModules.find((module) => module.slug === activeApiModuleId)
      ?? apiModules[0],
    [apiModuleDetails, apiModules, activeApiModuleId],
  )

  const selectApiModule = (moduleSlug: string) => {
    setActiveApiModuleId(moduleSlug)
    setActiveApiEndpointSlug('')
    setApiFilterText('')
    const params = new URLSearchParams(window.location.search)
    params.set('view', 'api')
    params.set('module', moduleSlug)
    params.delete('endpoint')
    params.delete('section')
    window.history.replaceState(null, '', `/docs?${params.toString()}`)
  }

  const loadApiModule = useCallback(async (moduleSlug: string, force = false) => {
    apiModuleAbortRef.current?.abort()
    const requestId = ++apiModuleRequestRef.current
    const controller = new AbortController()
    apiModuleAbortRef.current = controller
    setApiModuleLoading(true)
    setApiError('')
    setApiErrorScope('')
    try {
      const moduleDetail = await apiDocsApi.getModule(moduleSlug, false, force, controller.signal)
      if (controller.signal.aborted || apiModuleRequestRef.current !== requestId) return
      setApiModuleDetails((current) => ({ ...current, [moduleDetail.slug]: moduleDetail }))
    } catch (error) {
      if (!controller.signal.aborted && apiModuleRequestRef.current === requestId) {
        setApiError(businessErrorMessage(error, { fallback: '当前 API 模块加载失败', service: 'API 模块文档' }))
        setApiErrorScope('module')
      }
    } finally {
      if (apiModuleAbortRef.current === controller) apiModuleAbortRef.current = null
      if (apiModuleRequestRef.current === requestId) setApiModuleLoading(false)
    }
  }, [])

  useEffect(() => {
    apiModuleAbortRef.current?.abort()
    apiModuleRequestRef.current += 1
    if (viewMode !== 'api' || !activeApiModuleId || apiModuleDetails[activeApiModuleId]) {
      setApiModuleLoading(false)
      return
    }
    if (!apiModules.some((module) => module.slug === activeApiModuleId)) {
      setApiModuleLoading(false)
      return
    }
    void loadApiModule(activeApiModuleId)
    return () => {
      apiModuleRequestRef.current += 1
      apiModuleAbortRef.current?.abort()
      apiModuleAbortRef.current = null
    }
  }, [activeApiModuleId, apiModuleDetails, apiModules, loadApiModule, viewMode])

  useEffect(() => {
    if (!apiError || viewMode !== 'api') return

    const recoverFailedRead = () => {
      if (!navigator.onLine || document.visibilityState !== 'visible') return

      if (apiErrorScope === 'catalog' && !apiCatalogAbortRef.current) {
        void loadApiCatalog(true)
      }

      if (apiErrorScope === 'module' && activeApiModuleId && !apiModuleAbortRef.current) {
        void loadApiModule(activeApiModuleId, true)
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverFailedRead()
    }

    window.addEventListener('online', recoverFailedRead)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('online', recoverFailedRead)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [activeApiModuleId, apiError, apiErrorScope, loadApiCatalog, loadApiModule, viewMode])

  const apiGroups = useMemo(() => {
    if (!currentApiModule) return []
    const matchesFilter = (endpoint: typeof currentApiModule.endpoints[number]) => {
      if (!apiFilterText) return true
      const searchable = `${endpoint.path} ${endpoint.summary} ${endpoint.description}`.toLowerCase()
      return searchable.includes(apiFilterText.toLowerCase())
    }
    const configuredGroupIds = new Set(currentApiModule.groups.map((group) => group.id))
    const grouped = currentApiModule.groups
      .map((group) => {
        const endpoints = currentApiModule.endpoints.filter((endpoint) => {
          if (endpoint.group !== group.id) return false
          return matchesFilter(endpoint)
        })
        return { ...group, endpoints }
      })
    const ungroupedEndpoints = currentApiModule.endpoints.filter((endpoint) => {
      if (configuredGroupIds.has(endpoint.group)) return false
      return matchesFilter(endpoint)
    })
    return [
      ...grouped,
      { id: 'ungrouped', label: '其他接口', endpoints: ungroupedEndpoints },
    ].filter((group) => group.endpoints.length > 0)
  }, [currentApiModule, apiFilterText])

  const headerSearchResults = useMemo(() => {
    const keyword = (viewMode === 'api' ? apiFilterText : docSearchText).trim().toLowerCase()
    if (!keyword) return []
    if (viewMode === 'api') {
      return (currentApiModule?.endpoints || [])
        .filter((endpoint) => `${endpoint.summary} ${endpoint.path} ${endpoint.description}`.toLowerCase().includes(keyword))
        .slice(0, 6)
        .map((endpoint) => ({ id: endpoint.slug, title: endpoint.summary, detail: `${endpoint.method} ${endpoint.path}`, type: 'api' as const }))
    }
    return (Object.entries(DOC_LABELS) as Array<[DocSection, string]>)
      .filter(([, label]) => label.toLowerCase().includes(keyword))
      .slice(0, 6)
      .map(([id, label]) => ({ id, title: label, detail: '帮助文档章节', type: 'docs' as const }))
  }, [apiFilterText, currentApiModule, docSearchText, viewMode])

  useEffect(() => {
    if (!currentApiModule) return
    if (!activeApiModuleId || !apiModules.some((module) => module.slug === activeApiModuleId)) {
      setActiveApiModuleId(currentApiModule.slug)
      return
    }
    if (!apiModuleDetails[currentApiModule.slug]) {
      return
    }
    if (!currentApiModule.endpoints.length) {
      setActiveApiEndpointSlug('')
      return
    }
    if (!activeApiEndpointSlug || !currentApiModule.endpoints.some((endpoint) => endpoint.slug === activeApiEndpointSlug)) {
      setActiveApiEndpointSlug(currentApiModule.endpoints[0].slug)
    }
  }, [currentApiModule, activeApiEndpointSlug, activeApiModuleId, apiModuleDetails, apiModules])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('view', viewMode)
    if (viewMode === 'api' && activeApiModuleId) {
      params.set('module', activeApiModuleId)
      if (activeApiEndpointSlug) {
        params.set('endpoint', activeApiEndpointSlug)
      } else {
        params.delete('endpoint')
      }
      params.delete('section')
    } else {
      params.delete('module')
      params.delete('endpoint')
      params.set('section', active)
    }
    const nextQuery = params.toString()
    const nextUrl = nextQuery ? `/docs?${nextQuery}` : '/docs'
    if (`${window.location.pathname}${window.location.search}` !== nextUrl) {
      window.history.replaceState(null, '', nextUrl)
    }
  }, [viewMode, activeApiModuleId, activeApiEndpointSlug, active])

  const docsSwitcher = (
    <div className="space-y-3">
      <div className="text-[10px] font-black text-slate-400 dark:text-slate-500">内容视图</div>
      <div className="inline-flex w-full overflow-hidden rounded-full border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        {([
          { id: 'docs', label: '文档中心' },
          { id: 'api', label: 'API 参考' },
        ] as const).map((item) => (
          <button
            key={item.id}
            onClick={() => { setViewMode(item.id); setSidebarOpen(false) }}
            className={`flex-1 rounded-full px-4 py-2.5 text-sm font-bold transition ${
              viewMode === item.id
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
        {viewMode === 'docs' ? '浏览帮助文档、模板说明和开发指南。' : '查看接口说明、编辑请求并通过后端代理执行真实调试。'}
      </p>
    </div>
  )

  if (!routeStateReady) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f8f9fb] text-sm font-semibold text-slate-500 dark:bg-slate-950 dark:text-slate-400">
        正在打开文档中心...
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#f8f9fb] dark:bg-slate-950 text-slate-900 dark:text-slate-100 antialiased">
      {/* TopAppBar */}
      <header className="fixed top-0 z-50 flex h-16 w-full items-center justify-between border-b border-slate-200/50 bg-[#f8f9fb]/80 px-4 backdrop-blur-xl sm:px-6 lg:px-8 dark:border-slate-800/50 dark:bg-slate-950/80">
        <div className="flex items-center gap-8">
          <Link href="/home" className="flex items-center gap-2 group">
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white group-hover:scale-110 transition-transform">
              <ArrowLeft size={16} />
            </div>
            <span className="text-lg font-black text-slate-900 dark:text-white">帮助文档</span>
          </Link>
          <nav className="hidden md:flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Link href="/home" className="-mx-2 inline-flex min-h-8 items-center rounded-[6px] px-2 transition-colors hover:bg-blue-50 hover:text-blue-600 dark:hover:bg-blue-400/10 dark:hover:text-blue-400">首页</Link>
            <ChevronRight size={14} />
            <span>文档</span>
            <ChevronRight size={14} />
            <span className="text-blue-600 dark:text-blue-400 font-semibold">
              {viewMode === 'docs'
                ? DOC_LABELS[active]
                : (currentApiModule?.title || 'API 参考')}
            </span>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative hidden lg:block w-72">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input
              aria-label={viewMode === 'api' ? '搜索当前模块端点' : '搜索帮助文档章节'}
              className="w-full bg-slate-100 dark:bg-slate-900 border-none rounded-full py-1.5 pl-10 pr-4 text-sm focus:ring-2 focus:ring-blue-600/20 dark:focus:ring-blue-400/20 transition-all outline-none dark:text-white"
              placeholder={viewMode === 'api' ? '搜索当前模块端点...' : '搜索帮助文档章节...'}
              type="text"
              value={viewMode === 'api' ? apiFilterText : docSearchText}
              onFocus={() => setHeaderSearchFocused(true)}
              onBlur={() => window.setTimeout(() => setHeaderSearchFocused(false), 120)}
              onChange={(event) => {
                if (viewMode === 'api') setApiFilterText(event.target.value)
                else setDocSearchText(event.target.value)
              }}
            />
            {headerSearchFocused && (viewMode === 'api' ? apiFilterText : docSearchText).trim() ? (
              <div className="absolute right-0 top-[calc(100%+10px)] z-50 w-96 max-w-[calc(100vw-32px)] overflow-hidden rounded-[8px] border border-slate-200 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.14)] dark:border-slate-800 dark:bg-slate-900">
                {headerSearchResults.length ? (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {headerSearchResults.map((item) => (
                      <button
                        key={`${item.type}-${item.id}`}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          if (item.type === 'api') {
                            setActiveApiEndpointSlug(item.id)
                            setApiFilterText('')
                          } else {
                            setActive(item.id as DocSection)
                            setDocSearchText('')
                          }
                          setHeaderSearchFocused(false)
                        }}
                        className="block w-full px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800"
                      >
                        <span className="block text-sm font-semibold text-slate-900 dark:text-white">{item.title}</span>
                        <span className="mt-1 block truncate font-mono text-[11px] text-slate-500">{item.detail}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="px-4 py-5 text-center text-xs text-slate-500">没有匹配结果</p>
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen((open) => !open)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[7px] border border-slate-200 bg-white text-slate-600 lg:hidden dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
            aria-label={sidebarOpen ? '关闭文档目录' : '打开文档目录'}
            aria-expanded={sidebarOpen}
          >
            {sidebarOpen ? <X size={17} /> : <Menu size={17} />}
          </button>
        </div>
      </header>

      <div className="flex pt-16">
        {sidebarOpen ? (
          <button
            type="button"
            aria-label="关闭文档目录"
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 top-16 z-20 bg-slate-950/20 backdrop-blur-[1px] lg:hidden"
          />
        ) : null}
        {/* Sidebar */}
        <aside className={`docs-api-scroll fixed left-0 top-16 z-30 flex h-[calc(100vh-64px)] w-72 flex-col gap-1 overflow-y-auto border-r border-slate-200/50 bg-slate-100 px-4 py-6 shadow-xl transition-transform duration-200 lg:translate-x-0 lg:bg-slate-100/80 lg:shadow-none dark:border-slate-800/50 dark:bg-slate-900 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="px-4 mb-6 space-y-4">
            {docsSwitcher}
            <div>
              <h2 className="text-xl font-bold text-slate-900 dark:text-white">{viewMode === 'docs' ? '帮助文档和教程' : 'API 参考'}</h2>
              <p className="text-xs text-slate-500">v1.0.0</p>
            </div>
          </div>
          {viewMode === 'docs' ? (
          <nav className="docs-api-scroll flex-1 space-y-1 overflow-y-auto pr-2">
            <div className="mb-1 flex items-center gap-3 px-4 py-2 text-xs font-bold text-slate-500">
              帮助文档
            </div>
            {SIDE_NAV.map(item => (
              <div key={item.id}>
                {item.children ? (
                  <div className="mt-4">
                    <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400 px-4 py-2 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer">
                      <item.icon size={18} />
                      <span className="text-sm font-medium">{item.label}</span>
                    </div>
                    <div className="ml-10 space-y-1 mt-1 border-l border-slate-200 dark:border-slate-800">
                      {item.children.map(child => (
                        <button
                          key={child.id}
                          onClick={() => { setActive(child.id); setSidebarOpen(false) }}
                          className={`flex min-h-8 w-full items-center px-4 py-1.5 text-left text-xs transition-colors ${
                            active === child.id
                              ? 'text-blue-600 dark:text-blue-400 font-semibold'
                              : 'text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400'
                          }`}
                        >
                          {child.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => { setActive(item.id); setSidebarOpen(false) }}
                    className={`flex items-center gap-3 w-full rounded-full px-4 py-2.5 transition-colors active:scale-[0.98] duration-200 ${
                      active === item.id
                        ? 'bg-blue-600/10 dark:bg-blue-400/10 text-blue-600 dark:text-blue-400 font-semibold'
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-slate-800'
                    }`}
                  >
                    <item.icon size={18} />
                    <span className="text-sm">{item.label}</span>
                  </button>
                )}
              </div>
            ))}
          </nav>
          ) : (
          <div className="docs-api-scroll flex-1 overflow-y-auto pr-2">
          <div className="mb-4 px-4">
              <div className="mb-2 text-xs font-black text-slate-400">接口模块</div>
              <UnifiedSelect
                value={currentApiModule?.slug ?? activeApiModuleId}
                ariaLabel="选择接口模块"
                disabled={!apiModules.length}
                onChange={selectApiModule}
                options={apiModules.map((module) => ({ value: module.slug, label: module.title }))}
                size="sm"
                maxPanelHeight={320}
                className="[&>button]:min-h-12 [&>button]:font-semibold [&>button]:shadow-sm"
              />
            </div>
            <div className="mb-4 px-4">
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  aria-label="搜索 API 端点"
                  value={apiFilterText}
                  onChange={(event) => setApiFilterText(event.target.value)}
                  className="w-full rounded-[8px] border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-700 outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                  placeholder="搜索端点..."
                />
              </div>
            </div>
            <div className="space-y-4 px-2">
              {apiGroups.map((group) => (
                <div key={group.id}>
                  <div className="px-3 py-2 text-xs font-black text-slate-400">{group.label}</div>
                  <div className="space-y-1">
                    {group.endpoints.map((endpoint) => (
                      <button
                        key={endpoint.slug}
                        onClick={() => { setActiveApiEndpointSlug(endpoint.slug); setSidebarOpen(false) }}
                        className={`w-full rounded-2xl px-3 py-3 text-left transition ${
                          activeApiEndpointSlug === endpoint.slug ? 'bg-blue-50' : 'hover:bg-slate-200/70'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <span className={`mt-0.5 rounded-md px-2 py-1 text-xs font-black ${API_METHOD_CLASS[endpoint.method] || 'bg-slate-100 text-slate-700'}`}>
                            {endpoint.method}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className={`truncate text-[12px] font-bold ${activeApiEndpointSlug === endpoint.slug ? 'text-blue-700' : 'text-slate-800'}`}>
                              {endpoint.path}
                            </div>
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{endpoint.summary}</p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          )}
          </aside>

          {/* Main Content */}
          <main
            className={`docs-api-scroll ml-0 h-[calc(100vh-64px)] min-w-0 flex-1 overflow-y-auto lg:ml-72 ${
              viewMode === 'docs'
                ? 'flex gap-12 px-12 py-12'
                : 'flex gap-0 px-0 py-0'
            }`}
          >
          <div className={`${viewMode === 'docs' ? 'flex-1 max-w-4xl' : 'flex-1 max-w-none'}`}>
            {viewMode === 'docs' ? renderContent() : (
              apiLoading && !apiModules.length ? (
                <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500">正在加载 API 参考...</div>
              ) : apiError && apiErrorScope === 'catalog' && !apiModules.length ? (
                <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-sm font-semibold text-rose-700">{apiError}</p>
                  <button
                    type="button"
                    onClick={() => void loadApiCatalog(true)}
                    disabled={apiLoading}
                    className="rounded-[7px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                  >
                    {apiLoading ? '正在重试' : '重新读取模块目录'}
                  </button>
                </div>
              ) : apiModuleLoading ? (
                <div className="flex min-h-[60vh] items-center justify-center text-sm text-slate-500">正在加载当前 API 模块...</div>
              ) : apiError && apiErrorScope === 'module' ? (
                <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
                  <p className="text-sm font-semibold text-rose-700">{apiError}</p>
                  <p className="text-xs text-slate-500">模块目录仍可切换，重试只会重新读取当前模块。</p>
                  <button
                    type="button"
                    onClick={() => void loadApiModule(activeApiModuleId, true)}
                    disabled={apiModuleLoading || !activeApiModuleId}
                    className="rounded-[7px] border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                  >
                    {apiModuleLoading ? '正在重试' : '重新读取当前模块'}
                  </button>
                </div>
              ) : (
                <ApiReferenceView
                  modules={apiModules.map((module) => apiModuleDetails[module.slug] ?? module)}
                  activeModuleId={currentApiModule?.slug ?? activeApiModuleId}
                  activeEndpointSlug={activeApiEndpointSlug}
                  onModuleChange={selectApiModule}
                  onEndpointChange={setActiveApiEndpointSlug}
                  embedded
                  showSidebar={false}
                  showModuleTabs={false}
                />
              )
            )}

            {/* ── Footer Navigation — Premium Prev / Next Cards ── */}
            {viewMode === 'docs' ? (() => {
              const sections = DOC_SECTIONS
              const labels = DOC_LABELS
              const icons: Record<DocSection, LucideIcon> = {
                'overview': Blocks,
                'quickstart': Rocket,
                'template-00': Bot,
                'template-function': Layers,
                'template-usage': BookOpen,
                'template-config': Wrench,
                'template-custom': Code,
                'faq': HelpCircle, 'dev-environment': Wrench, 'dev-guide': Code,
              }
              const idx = sections.indexOf(active)
              const prev = idx > 0 ? sections[idx - 1] : null
              const next = idx < sections.length - 1 ? sections[idx + 1] : null

              return (
                <div className="mt-16 pt-8 border-t border-slate-200/60 dark:border-slate-800/60">
                  <div className={`grid gap-4 ${prev && next ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {/* ← Previous */}
                    {prev && (() => {
                      const PrevIcon = icons[prev]
                      return (
                        <button
                          onClick={() => setActive(prev)}
                          className="group relative overflow-hidden bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-6 text-left transition-all duration-300 hover:border-blue-200 dark:hover:border-blue-800 hover:shadow-lg hover:shadow-blue-500/5"
                        >
                          {/* Hover gradient overlay */}
                          <div className="absolute inset-0 bg-gradient-to-r from-blue-50/80 to-transparent dark:from-blue-950/30 dark:to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                          <div className="relative flex items-center gap-4">
                            <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 group-hover:bg-blue-600 group-hover:text-white transition-all duration-300 shrink-0">
                              <ArrowLeft size={18} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="mb-1 block text-[10px] font-bold text-slate-400 dark:text-slate-500">上一篇</span>
                              <span className="text-sm font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate block">{labels[prev]}</span>
                            </div>
                            <div className="w-8 h-8 rounded-lg bg-slate-50 dark:bg-slate-800/50 flex items-center justify-center shrink-0 opacity-60">
                              <PrevIcon size={14} className="text-slate-400 dark:text-slate-500" />
                            </div>
                          </div>
                        </button>
                      )
                    })()}

                    {/* → Next */}
                    {next && (() => {
                      const NextIcon = icons[next]
                      return (
                        <button
                          onClick={() => setActive(next)}
                          className={`group relative overflow-hidden bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-6 text-right transition-all duration-300 hover:border-blue-200 dark:hover:border-blue-800 hover:shadow-lg hover:shadow-blue-500/5 ${!prev ? 'col-start-1' : ''}`}
                        >
                          {/* Hover gradient overlay */}
                          <div className="absolute inset-0 bg-gradient-to-l from-blue-50/80 to-transparent dark:from-blue-950/30 dark:to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                          <div className="relative flex items-center gap-4">
                            <div className="w-8 h-8 rounded-lg bg-slate-50 dark:bg-slate-800/50 flex items-center justify-center shrink-0 opacity-60">
                              <NextIcon size={14} className="text-slate-400 dark:text-slate-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="mb-1 block text-[10px] font-bold text-slate-400 dark:text-slate-500">下一篇</span>
                              <span className="text-sm font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate block">{labels[next]}</span>
                            </div>
                            <div className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500 group-hover:bg-blue-600 group-hover:text-white transition-all duration-300 shrink-0">
                              <ArrowRight size={18} />
                            </div>
                          </div>
                        </button>
                      )
                    })()}
                  </div>

                  {/* Document counter */}
                  <div className="mt-6 flex flex-wrap items-center justify-center gap-1">
                    {sections.map((s, i) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setActive(s)}
                        aria-label={`打开${labels[s]}`}
                        aria-current={i === idx ? 'page' : undefined}
                        className="group inline-flex h-8 min-w-8 items-center justify-center rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        title={labels[s]}
                      >
                        <span className={`h-1.5 rounded-full transition-all duration-300 ${
                          i === idx
                            ? 'w-6 bg-blue-600 dark:bg-blue-400'
                            : 'w-1.5 bg-slate-200 group-hover:bg-slate-300 dark:bg-slate-800 dark:group-hover:bg-slate-700'
                        }`} />
                      </button>
                    ))}
                  </div>
                </div>
              )
            })() : null}
          </div>

          {/* Right TOC */}
          {viewMode === 'docs' ? (
          <aside className="hidden xl:block w-64 sticky top-0 self-start">
            <nav className="space-y-6">
              <div>
                <h4 className="mb-4 text-xs font-bold text-slate-900 dark:text-white">本页目录</h4>
                <ul className="space-y-3 text-sm border-l border-slate-200 dark:border-slate-800 ml-1">
                  {(tocItems[active] || []).map((item, i) => (
                    <li key={item.label}>
                      <a className={`block pl-4 transition-colors ${
                        i === 0
                          ? 'text-blue-600 dark:text-blue-400 font-semibold border-l-2 border-blue-600 dark:border-blue-400 -ml-[1px]'
                          : 'text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400'
                      }`} href={item.href}>
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="bg-blue-600/5 dark:bg-blue-400/5 p-6 rounded-2xl border border-blue-600/10 dark:border-blue-400/10">
                <Lightbulb size={20} className="text-blue-600 dark:text-blue-400 mb-3" />
                <h5 className="text-sm font-bold text-blue-600 dark:text-blue-400 mb-2">提示</h5>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  当前模板说明文档覆盖功能说明、使用方法、配置方式和定制指南，适合围绕 00 统一 Chatflow 扩展。
                </p>
              </div>
            </nav>
          </aside>
          ) : null}
        </main>
        </div>
    </div>
  )
}
