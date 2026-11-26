export type ViewportMode = 'desktop+mobile' | 'desktop-only';
export type StealthMode = 'chrome-xvfb' | 'chromium-headless';

export interface CrawlConfig {
  targetUrl: string;
  maxPages: number;
  maxDepth: number;
  viewports: ViewportMode;
  stealthMode: StealthMode;
  unpackJs: boolean;
  compressOutput: boolean;
  tokenBudget: number;
  proxyUrl?: string;
  extractedDir: string;
  storageDir: string;
  snapshotOutPath?: string;
  enableKatana: boolean;
  enablePurgeCss: boolean;
  enableSingleFile: boolean;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormalizedLayoutNode {
  nodeId: number;
  parentNodeId: number | null;
  tag: string;
  id?: string;
  classes: string[];
  role?: string;
  ariaLabel?: string;
  href?: string;
  text?: string;
  bounds: Bounds;
  paintOrder: number;
  styles: Record<string, string>;
}

export interface ViewportLayoutSnapshot {
  viewport: {
    width: number;
    height: number;
  };
  documentSize: {
    width: number;
    height: number;
  };
  nodeCount: number;
  nodes: NormalizedLayoutNode[];
}

export interface PageLayoutOutput {
  url: string;
  viewports: {
    desktop: ViewportLayoutSnapshot;
    mobile?: ViewportLayoutSnapshot;
  };
}

export interface OverlayNodeEntry {
  tag: string;
  selectorHint: string;
  role?: string;
  ariaModal?: string;
  reason?: string;
  bounds: Bounds;
  paintOrder: number;
  styles?: Record<string, string>;
}

export interface HoverFocusDelta {
  selector: string;
  pseudoState: 'hover' | 'focus';
  changedStyles: Record<string, string>;
}

export interface ProbedStateEntry {
  triggerSelector: string;
  revealedOverlays: OverlayNodeEntry[];
  hoverFocusDeltas: HoverFocusDelta[];
}

export interface OverlaysOutput {
  url: string;
  initialOverlays: OverlayNodeEntry[];
  interactiveProbedStates: ProbedStateEntry[];
}

export interface CdpStartedAnimation {
  id: string;
  name: string;
  type: string;
  startTime: number;
  duration: number;
  easing: string;
}

export interface WaapiAnimationEntry {
  type: string;
  animationName: string | null;
  transitionProperty: string | null;
  target: string;
  pseudoElement: string | null;
  timing: {
    delay: number;
    duration: number | string;
    iterations: number;
    easing: string;
  };
  keyframes: Array<Record<string, string | number | null>>;
}

export interface CssKeyframeEntry {
  name: string;
  source: string;
  rulesText: string;
}

export interface AnimationsOutput {
  url: string;
  cdpStartedAnimations: CdpStartedAnimation[];
  waapiAnimations: WaapiAnimationEntry[];
  cssKeyframes: CssKeyframeEntry[];
}

export type CollectedAssetKind = 'js' | 'css' | 'map';

export interface CollectedAsset {
  url: string;
  kind: CollectedAssetKind;
  hash: string;
  filePath: string;
  content?: string;
  sizeBytes: number;
  sourceMapHeader?: string;
  pageSlug?: string;
}

export interface SourceMapRecoverySummary {
  filesRecovered: number;
  recoveredBundleHashes: Set<string>;
  warnings: string[];
}

export interface WebcrackSummary {
  filesUnpacked: number;
  wakaruUnpackedCount: number;
  prettierFallbackCount: number;
  warnings: string[];
}

export interface DembrandtSummary {
  extracted: boolean;
  warnings: string[];
}

export interface TechStackResult {
  targetUrl: string;
  detector: 'wappalyzergo' | 'builtin-fallback';
  technologies: Array<{
    name: string;
    categories: string[];
    version?: string;
  }>;
  warnings: string[];
}

export interface KatanaReconResult {
  ran: boolean;
  discoveredUrls: string[];
  seedPageUrls: string[];
  warnings: string[];
}

export interface WallaceAnalysisSummary {
  analyzed: boolean;
  cssFilesCount: number;
  totalBytes: number;
  warnings: string[];
}

export interface PurgeCssSummary {
  purged: boolean;
  filesProcessed: number;
  bytesBefore: number;
  bytesAfter: number;
  warnings: string[];
}

export interface SvgAssetEntry {
  hash: string;
  file: string;
  selectorHint: string;
  pageSlug: string;
  bytesBefore: number;
  bytesAfter: number;
}

export interface SingleFileSummary {
  saved: boolean;
  outputPath?: string;
  warnings: string[];
}

export interface ManifestPageEntry {
  slug: string;
  url: string;
  title: string;
  status: number;
}

export interface ManifestData {
  schemaVersion: string;
  targetUrl: string;
  crawledAt: string;
  config: {
    maxPages: number;
    maxDepth: number;
    viewports: ViewportMode;
    stealthMode: StealthMode;
    unpackJs: boolean;
  };
  stats: {
    pagesCrawled: number;
    totalLayoutNodes: number;
    totalOverlays: number;
    totalAnimations: number;
    sourceMapFilesRecovered: number;
    webcrackFilesUnpacked: number;
    wakaruFilesUnpacked: number;
    svgIconsOptimized: number;
    cssBytesBeforePurge: number;
    cssBytesAfterPurge: number;
    katanaDiscoveredUrls: number;
    technologiesDetected: number;
    designSystemExtracted: boolean;
    wallaceTokensExtracted: boolean;
    scraplingFallbackUsed: boolean;
    singleFileSaved: boolean;
  };
  pages: ManifestPageEntry[];
  warnings: string[];
}

export interface CdpCaptureSnapshotResult {
  documents: Array<{
    documentURL?: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    contentWidth?: number;
    contentHeight?: number;
    nodes?: {
      parentIndex?: number[];
      nodeType?: number[];
      nodeName?: number[];
      nodeValue?: number[];
      attributes?: number[][];
    };
    layout?: {
      nodeIndex?: number[];
      styles?: number[][];
      bounds?: number[][];
      paintOrders?: number[];
    };
  }>;
  strings: string[];
}
