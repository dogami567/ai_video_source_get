export type Locale = "en" | "zh-CN";

const STORAGE_KEY = "vidunpack_locale";

export type I18nVars = Record<string, string | number | boolean | null | undefined>;

const en = {
  appTitle: "VidUnpack",
  appSubtitle: "Video Decomposition Workspace",

  langEN: "EN",
  langZH: "中文",
  langToggleTitle: "Switch language",

  systemError: "System Error",
  orchestrator: "Orchestrator",
  toolserver: "Toolserver",

  projects: "Projects",
  refresh: "Refresh",
  newProjectTitlePlaceholder: "New project title",
  creating: "Creating…",
  createProject: "Create Project",
  loadingProjects: "Loading projects…",
  emptyProjects: "No projects found. Create one to get started.",
  title: "Title",
  created: "Created",
  action: "Action",
  open: "Open",
  untitled: "Untitled",

  backToProjects: "Projects",
  idLabel: "ID",
  loadingProjectData: "Loading project data…",

  colConfig: "Configuration",
  colWorkspace: "Workspace",
  colResults: "Results",

  settings: "Settings",
  autoConfirmDownloads: "Auto-confirm downloads",
  consent: "Consent",
  granted: "Granted",
  pending: "Pending",
  enableReasoning: "Enable Reasoning",
  latestPlan: "Latest Plan",

  inputs: "Inputs",
  localVideo: "Local Video",
  import: "Import",
  videoUrl: "Video URL",
  save: "Save",
  videosCount: "Videos ({count})",
  urlsCount: "URLs ({count})",

  analysis: "Analysis",
  modelIdPlaceholder: "Model ID",
  noVideoAvailable: "No video available",
  analyzing: "Analyzing…",
  runAnalysis: "Run Analysis",
  analysisPlaceholder: "Analysis results will appear here.",

  contextSearch: "Context Search",
  usageStats: "Exa: {exa}/3 • Fetch: {fetch}/3",
  searchQueryPlaceholder: "Search query...",
  searching: "Searching…",
  search: "Search",
  fetch: "Fetch",
  add: "Add",
  fetched: "Fetched: {url}",

  assetPool: "Asset Pool",
  selected: "Selected: {count}",
  noItemsInPool: "No items in pool.",
  asset: "Asset",
  source: "Source",
  select: "Select",

  export: "Export",
  includeOriginalVideo: "Include original video in Zip",
  generatingReport: "Generating Report…",
  genReport: "Gen Report",
  estimating: "Estimating…",
  estimateSize: "Estimate Size",
  exporting: "Exporting…",
  exportZip: "Export Zip",
  reportManifestGenerated: "✓ Report & Manifest generated",
  estimateLabel: "Estimate:",
  zipReady: "✓ Zip Ready:",
  download: "Download",

  externalContentWarningTitle: "External Content Warning",
  externalContentWarningText:
    "You are about to save an external URL. This may trigger automated downloads or analysis.\nPlease confirm you have the right to access and process this content.",
  autoConfirmForThisProject: "Auto-confirm for this project",
  cancel: "Cancel",
  confirming: "Confirming…",
  iConfirm: "I Confirm",

  errEnterUrl: "Please enter a URL",
  errEnterModel: "Please enter a model",
  errPickLocalVideo: "Please select a local video (input_video)",
  errEnterSearchQuery: "Please enter a search query",
} satisfies Record<string, string>;

const zhCN: typeof en = {
  appTitle: "VidUnpack（视频拆解箱）",
  appSubtitle: "视频拆解工作台",

  langEN: "EN",
  langZH: "中文",
  langToggleTitle: "切换语言",

  systemError: "系统异常",
  orchestrator: "编排服务",
  toolserver: "工具服务",

  projects: "项目",
  refresh: "刷新",
  newProjectTitlePlaceholder: "新项目名称",
  creating: "创建中…",
  createProject: "创建项目",
  loadingProjects: "加载项目…",
  emptyProjects: "暂无项目，创建一个开始吧。",
  title: "标题",
  created: "创建时间",
  action: "操作",
  open: "打开",
  untitled: "未命名",

  backToProjects: "项目",
  idLabel: "ID",
  loadingProjectData: "加载项目数据…",

  colConfig: "配置",
  colWorkspace: "工作台",
  colResults: "结果",

  settings: "设置",
  autoConfirmDownloads: "自动确认下载",
  consent: "授权",
  granted: "已授权",
  pending: "待确认",
  enableReasoning: "启用思考",
  latestPlan: "最新计划",

  inputs: "输入",
  localVideo: "本地视频",
  import: "导入",
  videoUrl: "视频链接",
  save: "保存",
  videosCount: "视频（{count}）",
  urlsCount: "链接（{count}）",

  analysis: "分析",
  modelIdPlaceholder: "模型 ID",
  noVideoAvailable: "没有可用视频",
  analyzing: "分析中…",
  runAnalysis: "运行分析",
  analysisPlaceholder: "分析结果会显示在这里。",

  contextSearch: "联网搜索",
  usageStats: "Exa：{exa}/3 • 抓取：{fetch}/3",
  searchQueryPlaceholder: "搜索关键词…",
  searching: "搜索中…",
  search: "搜索",
  fetch: "抓取",
  add: "加入",
  fetched: "已抓取：{url}",

  assetPool: "素材池",
  selected: "已选：{count}",
  noItemsInPool: "素材池为空。",
  asset: "素材",
  source: "来源",
  select: "选择",

  export: "导出",
  includeOriginalVideo: "Zip 中包含原视频",
  generatingReport: "生成报告中…",
  genReport: "生成报告",
  estimating: "估算中…",
  estimateSize: "估算大小",
  exporting: "打包中…",
  exportZip: "导出 Zip",
  reportManifestGenerated: "✓ 已生成报告与清单",
  estimateLabel: "预计：",
  zipReady: "✓ Zip 就绪：",
  download: "下载",

  externalContentWarningTitle: "外部内容提示",
  externalContentWarningText:
    "你将要保存一个外部链接，这可能触发自动下载或分析。\n请确认你有权访问并处理该内容。",
  autoConfirmForThisProject: "本项目自动确认",
  cancel: "取消",
  confirming: "确认中…",
  iConfirm: "我确认",

  errEnterUrl: "请输入 URL",
  errEnterModel: "请输入 model",
  errPickLocalVideo: "请选择一个本地视频（input_video）",
  errEnterSearchQuery: "请输入 search query",
};

export const messages = { en, "zh-CN": zhCN } as const;
export type MessageKey = keyof typeof en;

export function getInitialLocale(): Locale {
  try {
    const saved = String(localStorage.getItem(STORAGE_KEY) || "").trim();
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch {
    // ignore
  }

  const nav = typeof navigator !== "undefined" ? String(navigator.language || "").toLowerCase() : "";
  if (nav.startsWith("zh")) return "zh-CN";
  return "en";
}

export function persistLocale(locale: Locale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // ignore
  }
}

export function t(locale: Locale, key: MessageKey, vars?: I18nVars): string {
  const template = messages[locale]?.[key] ?? messages.en[key] ?? String(key);
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));
}
