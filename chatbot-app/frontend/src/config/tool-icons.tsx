import { IconType } from "react-icons";
import {
  TbCalculator,
  TbChartBar,
  TbChartDots,
  TbSearch,
  TbWorldWww,
  TbBrowser,
  TbCloudRain,
  TbFileText,
  TbTable,
  TbPresentation,
  TbChartLine,
  TbCode,
  TbSchema,
} from "react-icons/tb";
import {
  SiDuckduckgo,
  SiGoogle,
  SiWikipedia,
  SiArxiv,
  SiGooglemaps,
  SiGmail,
  SiGooglecalendar,
  SiNotion,
  SiGithub,
  SiBluesky,
  SiYoutube,
  SiSnowflake,
} from "react-icons/si";
import toolsConfig from "./tools-config.json";

/**
 * Icon mapping for tools using react-icons
 * Uses professional brand icons where available (Simple Icons)
 * Falls back to Tabler Icons for generic tools
 */
export const toolIconMap: Record<string, IconType> = {
  // Analytics & Reports
  calculator: TbCalculator,
  create_visualization: TbChartBar,
  visual_design: TbChartDots,
  word_document_tools: TbFileText,
  excel_spreadsheet_tools: TbTable,
  powerpoint_presentation_tools: TbPresentation,
  gateway_financial_news: TbChartLine,
  "gateway_financial-news": TbChartLine,

  // Code Execution
  code_interpreter_tools: TbCode,

  // Research & Search
  web_search: SiDuckduckgo,
  gateway_web_search: SiDuckduckgo,
  gateway_tavily_search: TbSearch,
  "gateway_tavily-search": TbSearch,
  gateway_wikipedia_search: SiWikipedia,
  "gateway_wikipedia-search": SiWikipedia,
  gateway_arxiv_search: SiArxiv,
  "gateway_arxiv-search": SiArxiv,
  fetch: TbWorldWww,
  gateway_fetch: TbWorldWww,

  // Data
  gateway_snowflake: SiSnowflake,
  "gateway_revenue-analyst": SiSnowflake,
  "gateway_sql-executor": SiSnowflake,
  "gateway_semantic-layer": TbSchema,
  gateway_ListOntologies: TbSchema,
  gateway_OntologyQuery: TbSchema,
  gateway_MetadataQuery: TbSchema,
  gateway_QuerySuggestions: TbSchema,

  // Web & Automation
  browser_automation: TbBrowser,

  // Location & Live Data
  gateway_google_maps: SiGooglemaps,
  "gateway_google-maps": SiGooglemaps,
  gateway_show_on_map: SiGooglemaps,
  gateway_weather: TbCloudRain,
  get_current_weather: TbCloudRain,

  // Productivity (Gateway)
  gateway_gmail: SiGmail,
  gateway_calendar: SiGooglecalendar,
  gateway_notion: SiNotion,
  gateway_github: SiGithub,

  // Microsoft 365 (Graph) — react-icons/si has no Microsoft brand icons; SVGs in toolImageMap render instead.

  // Social
  gateway_bluesky: SiBluesky,
  gateway_youtube_transcripts: SiYoutube,

  // Research Agent
  "agentcore_research-agent": TbSearch,
};

/**
 * Image-based icons for tools that have actual logo files in /public/tool-icons/
 * These take priority over react-icon components when available.
 */
export const toolImageMap: Record<string, string> = {
  gateway_gmail: "/tool-icons/gmail.svg",
  gateway_calendar: "/tool-icons/google-calendar.svg",
  gateway_notion: "/tool-icons/notion.svg",
  gateway_github: "/tool-icons/github.svg",
  calculator: "/tool-icons/calculator.svg",
  excel_spreadsheet_tools: "/tool-icons/excel.svg",
  visual_design: "/tool-icons/diagram.svg",
  gateway_arxiv_search: "/tool-icons/arxiv.svg",
  "gateway_arxiv-search": "/tool-icons/arxiv.svg",
  gateway_google_maps: "/tool-icons/google-maps.svg",
  "gateway_google-maps": "/tool-icons/google-maps.svg",
  gateway_show_on_map: "/tool-icons/google-maps.svg",
  browser_automation: "/tool-icons/nova-act.png",
  powerpoint_presentation_tools: "/tool-icons/powerpoint.svg",
  word_document_tools: "/tool-icons/word.svg",
  fetch: "/tool-icons/url-fetcher.svg",
  gateway_fetch: "/tool-icons/url-fetcher.svg",
  create_visualization: "/tool-icons/visualization.svg",
  gateway_tavily_search: "/tool-icons/tavily.png",
  "gateway_tavily-search": "/tool-icons/tavily.png",
  gateway_tavily_extract: "/tool-icons/tavily.png",
  web_search: "/tool-icons/duckduckgo.svg",
  gateway_web_search: "/tool-icons/duckduckgo.svg",
  gateway_weather: "/tool-icons/weather.png",
  get_current_weather: "/tool-icons/weather.png",
  gateway_wikipedia_search: "/tool-icons/wikipedia.svg",
  "gateway_wikipedia-search": "/tool-icons/wikipedia.svg",
  gateway_financial_news: "/tool-icons/financial.svg",
  "gateway_financial-news": "/tool-icons/financial.svg",
  code_interpreter_tools: "/tool-icons/code-interpreter.svg",
  "agentcore_code-agent": "/tool-icons/code-agent.svg",
  code_agent: "/tool-icons/code-agent.svg",
  workspace_tools: "/tool-icons/s3-workspace.svg",
  create_excalidraw_diagram: "/tool-icons/excalidraw.svg",
  excalidraw: "/tool-icons/excalidraw.svg",
  gateway_outlook_mail: "/tool-icons/outlook.svg",
  gateway_ms_teams: "/tool-icons/teams.svg",
  gateway_onedrive: "/tool-icons/onedrive.svg",
  gateway_sharepoint: "/tool-icons/sharepoint.svg",
  gateway_bluesky: "/tool-icons/bluesky.svg",
  gateway_youtube_transcripts: "/tool-icons/youtube.svg",
};

/**
 * Sub-tool ID → parent group ID mapping, built from tools-config.json.
 * e.g. "create_word_document" → "word_document_tools"
 */
const subToolToParent: Record<string, string> = {};
const allGroups = [
  ...toolsConfig.local_tools,
  ...toolsConfig.builtin_tools,
  ...toolsConfig.browser_automation,
  ...toolsConfig.gateway_targets,
  ...toolsConfig.agentcore_runtime_a2a,
  ...toolsConfig.agentcore_runtime_gateway,
];
for (const group of allGroups) {
  if ("tools" in group && Array.isArray((group as any).tools)) {
    for (const sub of (group as any).tools) {
      subToolToParent[sub.id] = group.id;

      // Gateway tools: backend may strip the prefix (e.g., "gateway_notion_search" → "notion_search")
      // Also map the unprefixed version so icons resolve correctly.
      for (const prefix of ["gateway_"]) {
        if (sub.id.startsWith(prefix)) {
          const unprefixed = sub.id.slice(prefix.length);
          if (!(unprefixed in subToolToParent)) {
            subToolToParent[unprefixed] = group.id;
          }
        }
      }
    }
  }
}

/**
 * Resolve a tool ID to the one that has an icon mapping.
 * Checks direct match first, then falls back to parent group ID.
 */
function resolveIconId(
  toolId: string,
  map: Record<string, any>,
): string | null {
  if (toolId in map) return toolId;
  const parentId = subToolToParent[toolId];
  if (parentId && parentId in map) return parentId;
  return null;
}

/**
 * Skill name → representative tool ID mapping.
 * Used to resolve icons for skill_dispatcher / skill_executor.
 */
export const skillToToolId: Record<string, string> = {
  "web-search": "web_search",
  "url-fetcher": "fetch",
  visualization: "create_visualization",
  "visual-design": "visual_design",
  "word-documents": "word_document_tools",
  "excel-spreadsheets": "excel_spreadsheet_tools",
  "powerpoint-presentations": "powerpoint_presentation_tools",
  "browser-automation": "browser_automation",
  "code-interpreter": "code_interpreter_tools",
  weather: "gateway_weather",
  "financial-news": "gateway_financial-news",
  "arxiv-search": "gateway_arxiv-search",
  "google-maps": "gateway_google-maps",
  "wikipedia-search": "gateway_wikipedia-search",
  "tavily-search": "gateway_tavily-search",
  snowflake: "gateway_snowflake",
  "semantic-layer": "gateway_semantic-layer",
  gmail: "gateway_gmail",
  "google-calendar": "gateway_calendar",
  notion: "gateway_notion",
  github: "gateway_github",
  "outlook-mail": "gateway_outlook_mail",
  "ms-teams": "gateway_ms_teams",
  onedrive: "gateway_onedrive",
  sharepoint: "gateway_sharepoint",
  bluesky: "gateway_bluesky",
  "youtube-transcripts": "gateway_youtube_transcripts",
  excalidraw: "create_excalidraw_diagram",
  workspace: "workspace_tools",
  "code-agent": "agentcore_code-agent",
  "research-agent": "agentcore_research-agent",
  "doc-coauthoring": "word_document_tools",
};

/**
 * Resolve the effective tool ID for icon lookup.
 * For skill_dispatcher: uses toolInput.skill_name → representative tool ID.
 * For skill_executor: uses toolInput.tool_name directly.
 * For regular tools: returns the tool ID as-is.
 */
export function resolveEffectiveToolId(
  toolId: string,
  toolInput?: any,
): string {
  if (toolId === "skill_dispatcher" && toolInput?.skill_name) {
    return skillToToolId[toolInput.skill_name] || toolId;
  }
  if (toolId === "skill_executor" && toolInput?.tool_name) {
    return toolInput.tool_name;
  }
  return toolId;
}

/**
 * Get the image path for a tool ID, if one exists.
 * Returns null if the tool should use a react-icon instead.
 */
export function getToolImageSrc(toolId: string): string | null {
  const resolved = resolveIconId(toolId, toolImageMap);
  return resolved ? toolImageMap[resolved] : null;
}

/**
 * Get the icon component for a tool ID
 * Returns a default icon if tool ID is not found
 */
export function getToolIcon(toolId: string): IconType {
  const resolved = resolveIconId(toolId, toolIconMap);
  return resolved ? toolIconMap[resolved] : TbSearch;
}
