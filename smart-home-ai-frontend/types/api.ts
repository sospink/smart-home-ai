/**
 * 通用 API 响应类型
 */

// FastAPI 422 错误格式
export interface ValidationError {
  detail: Array<{
    loc: (string | number)[]
    msg: string
    type: string
  }>
}

// 分页响应
export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  size: number
}

// 操作结果
export interface ActionResult {
  success: boolean
  message?: string
}

// 用户信息
export interface User {
  id: number
  username: string
  nickname: string
  role: 'user' | 'admin'
  created_at: string
}

// 登录请求
export interface LoginRequest {
  username: string
  password: string
}

// Token 响应
export interface TokenResponse {
  access_token: string
  token_type: string
}

// 用户详情（管理端 - 含完整字段）
export interface UserDetail {
  id: number
  username: string
  nickname: string
  avatar: string
  role: 'user' | 'admin'
  is_active: boolean
  created_at: string
  updated_at: string | null
}

// 用户列表分页响应
export interface UserListResponse {
  items: UserDetail[]
  total: number
  page: number
  size: number
}
