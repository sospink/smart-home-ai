export type AgentInstanceType = 'chatflow' | 'workflow'
export type AgentInstanceStatus = 'draft' | 'ready' | 'running' | 'disabled'
export type AgentSourceType = 'built_in_template' | 'template_library' | 'uploaded_dsl' | 'external_dify'

export interface AgentOverviewMetric {
  label: string
  value: string
  note: string
}

export interface AgentCapabilityModule {
  title: string
  description: string
  status: string
  entryLabel: string
  entryRoute: string
  deploymentScope: string
  extensible: boolean
}

export interface AgentFrameworkOverview {
  title: string
  subtitle: string
  metrics: AgentOverviewMetric[]
  modules: AgentCapabilityModule[]
  deploymentHighlights: string[]
}

export interface AgentTemplateDoc {
  id: string
  title: string
  fileName: string
  templateType: string
  description: string
  functionDesc: string
  usage: string
  config: string
  customization: string
  entryRoute: string
  docsSection: string
  capabilityTags: string[]
}

export interface AgentTemplateLibraryItem {
  id: string
  name: string
  description: string
  tags: string[]
  fileName: string
  source: 'builtin' | 'uploaded' | string
  readonly: boolean
  createdBy?: number | null
  createdAt: string
  updatedAt: string
}

export interface AgentTemplateLibraryDetail extends AgentTemplateLibraryItem {
  dslContent: string
}

export interface AgentTemplateLibraryListResponse {
  items: AgentTemplateLibraryItem[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  summary: {
    totalTemplates: number
    builtinTemplates: number
    uploadedTemplates: number
  }
  canManage: boolean
  generatedAt: string | null
  cacheTtlSeconds: number
}

export interface AgentTemplateLibraryListParams {
  page?: number
  pageSize?: number
  keyword?: string
  source?: '' | 'builtin' | 'uploaded'
}

export interface AgentTemplateLibraryUploadResponse {
  success: boolean
  created: boolean
  item: AgentTemplateLibraryItem
}

export interface UpdateAgentTemplateLibraryPayload {
  name?: string
  description?: string
  tags?: string[]
}

export interface AgentInstance {
  id: number
  businessName: string
  businessDescription: string
  name: string
  slug: string
  difyAppId: string
  isDefault: boolean
  instanceType: AgentInstanceType
  sourceType: AgentSourceType
  sourceTemplate: string
  dslFileName: string
  status: AgentInstanceStatus
  enabled: boolean
  description: string
  defaultModel: string
  knowledgeBindings: string[]
  capabilityTags: string[]
  entryRoute: string
  difyConsoleUrl: string
  dslContent: string
  hasDifyApiKey: boolean
  difyApiKeyMasked: string
  createdBy?: number | null
  createdAt: string
  updatedAt: string
  runtime: AgentRuntimeEvidence
  lastRun: AgentLastRunEvidence
}

export interface AgentRuntimeEvidence {
  status: 'running' | 'mismatch' | 'unavailable' | 'unconfigured' | 'disabled' | string
  bindingStatus: 'instance_key' | 'system_runtime_fallback' | 'unconfigured' | string
  appName: string
  appMode: string
  baseUrl: string
  latencyMs: number | null
  checkedAt: string | null
  error: string
  nameMatches: boolean | null
  source: string
}

export interface AgentLastRunEvidence {
  status: 'success' | 'failed' | 'never' | string
  title: string
  query: string
  messageId: string
  workflowRunId: string
  error: string
  createdAt: string | null
}

export interface AgentInstanceListSummary {
  totalInstances: number
  enabledInstances: number
  defaultInstances: number
  boundInstances: number
  callableInstances: number
  templateReferenceInstances: number
  successfulRuns24h: number
  failedRuns24h: number
}

export interface AgentInstanceListResponse {
  instances: AgentInstance[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  summary: AgentInstanceListSummary
  runVisibilityScope: 'all' | 'self'
  generatedAt: string | null
  cacheTtlSeconds: number
}

export interface AgentInstanceListParams {
  page?: number
  pageSize?: number
  keyword?: string
  status?: string
  instanceType?: string
  sourceType?: string
  bound?: boolean
  refreshRuntime?: boolean
  primaryOnly?: boolean
  includeRuntime?: boolean
}

export interface AgentRunRecord {
  id: number
  instanceId: number | null
  instanceName: string
  businessName: string
  status: 'success' | 'failed' | string
  title: string
  query: string
  answer: string
  messageId: string
  workflowRunId: string
  error: string
  username: string
  createdAt: string | null
}

export interface AgentRunListSummary {
  totalRuns: number
  successfulRuns: number
  failedRuns: number
  runs24h: number
}

export interface AgentRunListResponse {
  items: AgentRunRecord[]
  total: number
  page: number
  pageSize: number
  pageCount: number
  summary: AgentRunListSummary
  visibilityScope: 'all' | 'self'
}

export interface AgentRunListParams {
  page?: number
  pageSize?: number
  keyword?: string
  status?: string
  instanceId?: number
}

export interface AgentCapabilitiesResponse {
  title: string
  subtitle: string
  items: Array<{
    title: string
    description: string
    consoleUrl?: string
  }>
}

export interface CreateAgentInstancePayload {
  name?: string
  description?: string
  instanceType?: AgentInstanceType
  sourceType?: AgentSourceType
  sourceTemplate?: string
  defaultModel?: string
  knowledgeBindings?: string[]
  capabilityTags?: string[]
  entryRoute?: string
  enabled?: boolean
  difyAppId?: string
  difyApiKey?: string
  isDefault?: boolean
  difyConsoleUrl?: string
}

export interface UpdateAgentInstancePayload extends Partial<CreateAgentInstancePayload> {
  slug?: string
  dslFileName?: string
  status?: AgentInstanceStatus
  dslContent?: string
}

export interface AgentUploadDslResult {
  success: boolean
  instance: AgentInstance
  parsed: {
    name?: string
    mode?: string
    description?: string
  }
}

export interface AgentTestRunResult {
  success: boolean
  instanceId: number
  instanceName: string
  businessName: string
  query: string
  answer: string
  messageId: string
  conversationId: string
  taskId: string
  workflowRunId: string
  runtimeBinding: {
    difyBaseUrl?: string
    binding?: string
    bindingStatus?: string
    instanceDifyAppId?: string
    instanceType?: string
    hasInstanceApiKey?: boolean
    isDefault?: boolean
  }
  warnings: string[]
}
