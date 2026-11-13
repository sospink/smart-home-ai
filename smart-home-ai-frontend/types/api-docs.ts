export type DocsViewMode = 'docs' | 'api'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

export interface ApiReferenceParam {
  name: string
  location: 'header' | 'query' | 'path' | 'body'
  type: string
  required?: boolean
  description: string
  defaultValue?: string | number | boolean | Record<string, unknown> | unknown[]
}

export interface ApiResponseField {
  name: string
  type: string
  description: string
}

export interface ApiCodeSample {
  id: string
  label: string
  language: string
  code: string
}

export interface ApiPlaygroundField {
  id: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'checkbox' | 'select'
  placeholder?: string
  value?: string | number | boolean
  options?: { label: string; value: string }[]
}

export interface ApiPlaygroundPreset {
  id: string
  label: string
  description: string
  requestPreview: string
  responseBody: string
  responseMeta: string
}

export interface ApiEndpoint {
  id: number
  moduleId: number
  slug: string
  group: string
  method: HttpMethod
  path: string
  summary: string
  description: string
  sourceType: string
  sourceIdentifier: string
  sortOrder: number
  isVisible: boolean
  tags: string[]
  params: ApiReferenceParam[]
  responses: ApiResponseField[]
  notes?: string[]
  codeSamples: ApiCodeSample[]
  requestPreview: string
  responseBody: string
  responseMeta: string
  createdAt?: string | null
  updatedAt?: string | null
}

export interface ApiReferenceModule {
  id: number
  slug: string
  title: string
  subtitle: string
  status: 'static' | 'planned'
  sourceType: string
  rendererType: string
  endpointBase: string
  description: string
  markdownContent: string
  sortOrder: number
  isVisible: boolean
  capabilityTags: string[]
  highlights: Array<{ title: string; description: string }>
  groups: Array<{ id: string; label: string }>
  endpoints: ApiEndpoint[]
  playground: {
    title: string
    targetLabel: string
    statusLabel: string
    note: string
    fields: ApiPlaygroundField[]
    presets: ApiPlaygroundPreset[]
  }
}

export interface ApiModuleListResponse {
  modules: ApiReferenceModule[]
}

export interface ApiDocsAdminOverview {
  moduleTotal: number
  visibleModuleTotal: number
  endpointTotal: number
  visibleEndpointTotal: number
  manualEndpointTotal: number
  historyTotal: number
  lastChangeAt: string | null
  lastChangeSource: string
}

export interface ApiModuleSummary {
  id: number
  slug: string
  title: string
  subtitle: string
  status: string
  sourceType: string
  endpointBase: string
  sortOrder: number
  isVisible: boolean
  endpointCount: number
  visibleEndpointCount: number
  updatedAt: string | null
}

export interface ApiModulePageResponse {
  items: ApiModuleSummary[]
  total: number
  page: number
  size: number
  pageCount: number
}

export interface ApiEndpointPageResponse {
  items: ApiEndpoint[]
  total: number
  page: number
  size: number
  pageCount: number
  availableFilters: { groups: string[]; methods: string[] }
}

export type ApiEndpointWritePayload = Pick<ApiEndpoint,
  'slug' | 'group' | 'method' | 'path' | 'summary' | 'description' |
  'sortOrder' | 'isVisible' | 'tags' | 'params' | 'responses' | 'notes' |
  'codeSamples' | 'requestPreview' | 'responseBody' | 'responseMeta'
>

export interface ApiDocChangeRecord {
  id: number
  targetType: string
  targetRef: string
  targetLabel: string
  sourceType: string
  sourceRef: string
  importStrategy: string
  note: string
  importedAt: string | null
  repeatCount: number
}

export interface ApiDocChangePageResponse {
  items: ApiDocChangeRecord[]
  total: number
  rawTotal: number
  page: number
  size: number
  pageCount: number
}

export interface ApiActionResult {
  success: boolean
  message: string
  detail?: Record<string, unknown>
}

export interface OpenApiImportResult {
  created: number
  updated: number
  skipped: number
  unmatched: number
}

export interface ApiDebuggerExecutePayload {
  moduleSlug: string
  endpointSlug: string
  baseUrl: string
  method: HttpMethod
  path: string
  pathParams: Record<string, string>
  queryParams: Record<string, string>
  headers: Record<string, string>
  bodyText: string
  authType: string
  authValue: string
  customHeaderName: string
  confirmRiskyExecution?: boolean
}

export interface ApiDebuggerExecuteResult {
  success: boolean
  statusCode: number | null
  durationMs: number
  responseHeaders: Record<string, string>
  responseBody: unknown
  requestSnapshot: Record<string, unknown>
  curlCommand: string
  error: string
}
