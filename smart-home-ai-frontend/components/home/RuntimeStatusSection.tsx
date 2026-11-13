"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, ArrowRight, Box, BrainCircuit, Database, RefreshCw, ServerCog, Wifi } from "lucide-react";
import {
  fetchPublicSystemSummary,
  type PublicSystemSummary,
  type PublicSystemSummaryService,
} from "@/lib/api/system";
import { formatMilliseconds } from "@/lib/ui/format-duration";
import { businessErrorMessage } from "@/lib/ui/business-error";

const SERVICE_LABELS: Record<string, string> = {
  backend: "平台后端",
  dify_app: "智能体应用",
  dify_knowledge: "知识库服务",
  homeassistant: "设备中枢",
  ollama: "本地推理",
  influxdb: "时序数据",
};

const SERVICE_ICONS: Record<string, typeof Activity> = {
  backend: ServerCog,
  dify_app: BrainCircuit,
  dify_knowledge: Database,
  homeassistant: Wifi,
  ollama: Box,
  influxdb: Activity,
};

const STATUS_LABELS = {
  running: "运行中",
  stopped: "未连接",
  error: "异常",
  unknown: "待检测",
  unconfigured: "未配置",
};

function formatGeneratedAt(value?: string) {
  if (!value) return "尚未取得快照";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "更新时间未知";
  return `更新于 ${date.toLocaleTimeString("zh-CN", { hour12: false })}`;
}

function metricValue(value: number | null, suffix = "") {
  return value == null ? "待检测" : `${value}${suffix}`;
}

function serviceTone(status: PublicSystemSummaryService["status"]) {
  if (status === "running") return "bg-emerald-500";
  if (status === "error") return "bg-rose-500";
  if (status === "stopped") return "bg-amber-500";
  return "bg-slate-400";
}

function serviceMetric(
  summary: PublicSystemSummary,
  key: string,
  value: number | null,
) {
  const status = summary.services.find((service) => service.key === key)?.status;
  if (status && status !== "running") return STATUS_LABELS[status] || "不可用";
  return metricValue(value);
}

export default function RuntimeStatusSection() {
  const [summary, setSummary] = useState<PublicSystemSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef<{ controller: AbortController; generation: number } | null>(null);

  const load = useCallback(async (force = false) => {
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const generation = (requestRef.current?.generation || 0) + 1;
    requestRef.current = { controller, generation };
    setLoading(true);
    setError("");
    try {
      const nextSummary = await fetchPublicSystemSummary(force, controller.signal);
      if (requestRef.current?.generation === generation) setSummary(nextSummary);
    } catch (caught) {
      if (controller.signal.aborted || requestRef.current?.generation !== generation) return;
      setError(businessErrorMessage(caught, { fallback: "运行状态读取失败", service: "平台运行状态" }));
    } finally {
      if (requestRef.current?.generation === generation) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current?.controller.abort();
      requestRef.current = null;
    };
  }, [load]);

  const status = useMemo(() => {
    if (!summary) return { label: loading ? "正在检测" : "状态未知", tone: "bg-slate-400" };
    if (summary.overall_status === "healthy") return { label: "核心服务正常", tone: "bg-emerald-500" };
    if (summary.overall_status === "unavailable") return { label: "服务暂不可用", tone: "bg-rose-500" };
    return { label: "部分服务待处理", tone: "bg-amber-500" };
  }, [loading, summary]);

  const metrics = [
    {
      label: "服务在线",
      value: summary ? `${summary.stats.running_services}/${summary.stats.total_services}` : "--",
      detail: "实时健康探测",
    },
    {
      label: "设备在线",
      value: summary ? metricValue(summary.stats.online_devices, `/${summary.stats.registered_devices}`) : "--",
      detail: "平台设备台账",
    },
    {
      label: "知识库",
      value: summary ? serviceMetric(summary, "dify_knowledge", summary.stats.knowledge_count) : "--",
      detail: "Dify 当前返回",
    },
    {
      label: "本地模型",
      value: summary ? serviceMetric(summary, "ollama", summary.stats.model_count) : "--",
      detail: "Ollama 当前返回",
    },
  ];

  return (
    <section id="runtime" className="relative border-y border-border/60 bg-background/75 py-20 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl section-padding">
        <div className="flex flex-col gap-6 border-b border-border/60 pb-10 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="mb-4 text-sm font-medium text-primary">当前运行状态</p>
            <h2 className="font-display text-3xl font-bold leading-tight tracking-normal text-foreground md:text-4xl">
              能力介绍与实时状态，清楚分开
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">
              以下数据来自平台后端的实时探测。服务离线或未配置时保留真实状态，不用示例数据补齐。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
              <span className={`h-2 w-2 rounded-full ${status.tone}`} />
              {status.label}
            </span>
            <span className="text-xs text-muted-foreground">
              {summary?.cached ? "缓存快照 · " : ""}{formatGeneratedAt(summary?.generated_at)}
            </span>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              aria-label="刷新运行状态"
              title="刷新运行状态"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {error && !summary ? (
          <div className="flex flex-col gap-4 py-12 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium text-foreground">暂时无法读取运行状态</p>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            </div>
            <button type="button" onClick={() => void load(true)} className="inline-flex items-center gap-2 text-sm font-medium text-primary">
              重新检测 <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 border-b border-border/60 md:grid-cols-4">
              {metrics.map((metric, index) => (
                <div
                  key={metric.label}
                  className={`py-8 ${index % 2 ? "pl-6" : "pr-6"} ${index > 1 ? "border-t border-border/60 md:border-t-0" : ""} ${index ? "md:border-l md:border-border/60 md:px-8" : ""}`}
                >
                  <p className="text-xs font-medium text-muted-foreground">{metric.label}</p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums tracking-normal text-foreground">
                    {loading && !summary ? <span className="inline-block h-8 w-16 animate-pulse rounded bg-muted" /> : metric.value}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{metric.detail}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-px bg-border/60 sm:grid-cols-2 lg:grid-cols-6">
              {(summary?.services || []).map((service) => {
                const Icon = SERVICE_ICONS[service.key] || Activity;
                return (
                  <div key={service.key} className="flex min-h-24 items-center gap-3 bg-background px-4 py-5">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">{SERVICE_LABELS[service.key] || service.name}</p>
                      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className={`h-1.5 w-1.5 rounded-full ${serviceTone(service.status)}`} />
                        {STATUS_LABELS[service.status] || "待检测"}
                        {service.status === "running" ? ` · ${formatMilliseconds(service.latency_ms)}` : ""}
                      </p>
                    </div>
                  </div>
                );
              })}
              {loading && !summary
                ? Array.from({ length: 6 }, (_, index) => (
                    <div key={index} className="h-24 animate-pulse bg-background px-4 py-5">
                      <div className="h-3 w-24 rounded bg-muted" />
                      <div className="mt-3 h-2 w-16 rounded bg-muted" />
                    </div>
                  ))
                : null}
            </div>
          </>
        )}

        <div className="mt-6 flex justify-end">
          <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
            查看完整系统状态 <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        {error && summary ? <p className="mt-3 text-right text-xs text-amber-700">刷新失败，当前保留上一份快照：{error}</p> : null}
      </div>
    </section>
  );
}
