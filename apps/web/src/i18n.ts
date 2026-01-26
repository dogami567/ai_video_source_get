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
  quickStartTitle: "Quick start",
  quickStartStep1: "Open Settings and set API keys (optional).",
  quickStartStep2: "Create a project.",
  quickStartStep3: "Import a local video or paste a URL (consent required).",
  quickStartStep4: "Run analysis/search, then export a zip.",
  openSettings: "Open Settings",
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

  chat: "Chat",
  newChat: "New chat",
  loadingChats: "Loading chats…",
  noChats: "No chats yet.",
  loadingMessages: "Loading messages…",
  chatEmptyMessages: "Start a conversation to get video cards.",
  upload: "Upload",
  send: "Send",
  sending: "Sending…",
  chatPlaceholder: "Describe your idea… (Enter to send, Shift+Enter for newline)",
  chatHint: "Enter to send • Shift+Enter for newline",

  settings: "Settings",
  globalSettingsTitle: "Global Settings",
  globalSettingsHint:
    "Saved locally in this browser. Leave fields empty to fall back to .env. Tip: for OpenAI-compatible relays, set Base URL to your relay (with or without /v1) and put the relay key in API Key.",
  settingsGemini: "Gemini",
  settingsBaseUrl: "Base URL",
  settingsGeminiKey: "API Key",
  settingsDefaultModel: "Default Model",
  settingsExa: "Exa",
  settingsExaKey: "Exa API Key",
  settingsExaHint: "Used for search and fetch tools.",
  settingsDownloader: "Downloader",
  settingsCookiesFromBrowser: "Cookies from browser",
  settingsCookiesFromBrowserHint:
    "Optional. If you are logged in in your browser, set e.g. 'chrome' or 'edge' to let yt-dlp reuse it. (This does not store cookies here.)",
  settingsKeyPlaceholder: "Paste your API key",
  settingsEmptyUsesEnv: "Leave blank to use .env",
  clear: "Clear",
  saved: "Saved",
  autoConfirmDownloads: "Auto-confirm downloads",
  consent: "Consent",
  granted: "Granted",
  pending: "Pending",
  enableReasoning: "Enable Reasoning",
  latestPlan: "Latest Plan",

  backendOfflineTitle: "Backend is offline",
  backendOfflineDesc: "Start the local dev servers before using this app.",
  backendOfflineCommand: "Command:",

  inputs: "Inputs",
  localVideo: "Local Video",
  import: "Import",
  videoUrl: "Video URL",
  save: "Save",
  resolve: "Resolve",
  downloadNow: "Download",
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
  errEnterMessage: "Please enter a message",
  errEnterModel: "Please enter a model",
  errPickLocalVideo: "Please select a local video (input_video)",
  errEnterSearchQuery: "Please enter a search query",
  noResults: "No results found.",
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
  quickStartTitle: "快速开始",
  quickStartStep1: "打开「设置」并填写 API Key（可选）。",
  quickStartStep2: "创建一个项目。",
  quickStartStep3: "导入本地视频或粘贴链接（需要确认授权）。",
  quickStartStep4: "运行分析/搜索，然后导出 Zip。",
  openSettings: "打开设置",
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

  chat: "聊天",
  newChat: "新对话",
  loadingChats: "加载对话…",
  noChats: "暂无对话。",
  loadingMessages: "加载消息…",
  chatEmptyMessages: "开始聊天吧：我会帮你搜索并输出视频卡片。",
  upload: "上传",
  send: "发送",
  sending: "发送中…",
  chatPlaceholder: "说说你的想法…（Enter 发送，Shift+Enter 换行）",
  chatHint: "Enter 发送 • Shift+Enter 换行",

  settings: "设置",
  globalSettingsTitle: "全局设置",
  globalSettingsHint:
    "保存到本浏览器本地。留空则回退到 .env。提示：如果你用「中转/OpenAI 兼容」，Base URL 填中转地址（可带 /v1），API Key 填中转 key。",
  settingsGemini: "Gemini",
  settingsBaseUrl: "Base URL",
  settingsGeminiKey: "API Key（Gemini/中转）",
  settingsDefaultModel: "默认模型",
  settingsExa: "Exa",
  settingsExaKey: "Exa API Key",
  settingsExaHint: "用于联网搜索与抓取。",
  settingsDownloader: "下载/解析",
  settingsCookiesFromBrowser: "从浏览器读取登录态",
  settingsCookiesFromBrowserHint:
    "可选：先在浏览器完成登录，再填 chrome/edge/firefox 让 yt-dlp 复用登录态（这里只保存浏览器名，不保存 cookie）。",
  settingsKeyPlaceholder: "粘贴你的 API Key",
  settingsEmptyUsesEnv: "留空则使用 .env",
  clear: "清除",
  saved: "已保存",
  autoConfirmDownloads: "自动确认下载",
  consent: "授权",
  granted: "已授权",
  pending: "待确认",
  enableReasoning: "启用思考",
  latestPlan: "最新计划",

  backendOfflineTitle: "后端未启动",
  backendOfflineDesc: "请先启动本地服务后再使用本应用。",
  backendOfflineCommand: "命令：",

  inputs: "输入",
  localVideo: "本地视频",
  import: "导入",
  videoUrl: "视频链接",
  save: "保存",
  resolve: "解析",
  downloadNow: "下载",
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
  errEnterMessage: "请输入内容",
  errEnterModel: "请输入 model",
  errPickLocalVideo: "请选择一个本地视频（input_video）",
  errEnterSearchQuery: "请输入 search query",
  noResults: "未找到结果。",
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
