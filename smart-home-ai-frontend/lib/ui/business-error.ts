type BusinessErrorOptions = {
  fallback: string
  service?: string
}

function errorText(value: unknown) {
  if (value instanceof Error) return value.message.trim()
  return String(value || '').trim()
}

export function businessErrorMessage(value: unknown, { fallback, service = '服务' }: BusinessErrorOptions) {
  const message = errorText(value)
  if (!message) return fallback
  const normalized = message.toLowerCase()

  if (/登录已过期|没有权限|仅管理员|不能为空|不能|不支持|格式错误|无效|不存在|未配置|尚未|请/.test(message)
    && /[\u4e00-\u9fff]/.test(message)
    && !/https?:\/\/|traceback|exception|\b[a-z]+error\b/i.test(message)) return message
  if (/timeout|timed out|connecttimeout|readtimeout|请求超时/.test(normalized)) {
    return `${service}请求超时，请检查服务状态和网络链路`
  }
  if (/all connection attempts failed|connection refused|connecterror|network error|failed to fetch|server disconnected|connection reset|network is unreachable|no route to host|host is down/.test(normalized)) {
    return `无法连接${service}，请检查服务地址、运行状态和网络链路`
  }
  if (/401|403|unauthorized|forbidden|authentication|invalid.*(?:token|key)/.test(normalized)) {
    return `${service}认证失败，请检查访问凭证和权限配置`
  }
  if (/404|not found/.test(normalized)) {
    return `${service}目标资源不存在，请刷新数据并检查当前配置`
  }
  if (/500|502|503|504|internal server error|bad gateway|service unavailable|gateway timeout/.test(normalized)) {
    return `${service}返回异常，请检查服务运行状态和日志`
  }
  if (/https?:\/\/|traceback|exception|\b[a-z]+error\b|\bhttp\s*\d{3}\b/i.test(message)) return fallback
  return /[\u4e00-\u9fff]/.test(message) ? message : fallback
}
