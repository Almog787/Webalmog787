import type { CDPSession, Page } from 'patchright';
import type {
  AnimationsOutput,
  CdpStartedAnimation,
  CollectedAsset,
  CssKeyframeEntry,
  WaapiAnimationEntry,
} from '../types.js';

export interface AnimationTracker {
  getStartedAnimations(): CdpStartedAnimation[];
  dispose(): void;
}

interface CdpAnimationPayload {
  animation?: {
    id?: string;
    name?: string;
    type?: string;
    startTime?: number;
    source?: {
      duration?: number;
      easing?: string;
    };
  };
}

export async function attachAnimationTracker(
  cdpClient: CDPSession,
): Promise<AnimationTracker> {
  const started: CdpStartedAnimation[] = [];
  const seenIds = new Set<string>();

  await cdpClient.send('Animation.enable');

  const onAnimationStarted = (payload: unknown): void => {
    const data = payload as CdpAnimationPayload;
    const anim = data?.animation;
    if (!anim || !anim.id || seenIds.has(anim.id)) {
      return;
    }
    seenIds.add(anim.id);
    started.push({
      id: anim.id,
      name: anim.name || '(anonymous)',
      type: anim.type || 'Unknown',
      startTime: typeof anim.startTime === 'number' ? anim.startTime : 0,
      duration: typeof anim.source?.duration === 'number' ? anim.source.duration : 0,
      easing: anim.source?.easing || 'linear',
    });
  };

  cdpClient.on('Animation.animationStarted', onAnimationStarted);

  return {
    getStartedAnimations: () => [...started],
    dispose: () => {
      cdpClient.off('Animation.animationStarted', onAnimationStarted);
    },
  };
}

function stripCssComments(cssText: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inComment = false;

  for (let i = 0; i < cssText.length; i++) {
    const ch = cssText[i]!;
    const next = cssText[i + 1];

    if (inComment) {
      if (ch === '*' && next === '/') {
        inComment = false;
        i++;
      }
      continue;
    }

    if (inSingle) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i++;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      inComment = true;
      i++;
      continue;
    }

    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    out += ch;
  }

  return out;
}

export function extractCssKeyframesFromText(
  rawCssText: string,
  source: string,
): CssKeyframeEntry[] {
  const cssText = stripCssComments(rawCssText);
  const results: CssKeyframeEntry[] = [];
  const atRuleRegex = /@(?:-(?:webkit|moz|o)-)?keyframes\s+([a-zA-Z0-9_-]+)\s*\{|@starting-style\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = atRuleRegex.exec(cssText)) !== null) {
    const startIdx = match.index;
    const openBraceIdx = cssText.indexOf('{', startIdx);
    if (openBraceIdx === -1) break;

    let depth = 0;
    let endIdx = -1;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inComment = false;

    for (let i = openBraceIdx; i < cssText.length; i++) {
      const ch = cssText[i];
      const next = cssText[i + 1];

      if (inComment) {
        if (ch === '*' && next === '/') {
          inComment = false;
          i++;
        }
        continue;
      }

      if (inSingleQuote) {
        if (ch === '\\') {
          i++;
        } else if (ch === "'") {
          inSingleQuote = false;
        }
        continue;
      }

      if (inDoubleQuote) {
        if (ch === '\\') {
          i++;
        } else if (ch === '"') {
          inDoubleQuote = false;
        }
        continue;
      }

      if (ch === '/' && next === '*') {
        inComment = true;
        i++;
        continue;
      }
      if (ch === "'") {
        inSingleQuote = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = true;
        continue;
      }
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    if (endIdx !== -1) {
      const rulesText = cssText.slice(startIdx, endIdx + 1).replace(/\s+/g, ' ').trim();
      const name = match[1] ?? '@starting-style';
      results.push({
        name,
        source,
        rulesText,
      });
      atRuleRegex.lastIndex = endIdx + 1;
    }
  }

  return results;
}

interface BrowserAnimationExtraction {
  waapiAnimations: WaapiAnimationEntry[];
  cssomKeyframes: CssKeyframeEntry[];
}

export async function extractPageAnimations(
  page: Page,
  url: string,
  tracker: AnimationTracker,
  collectedCssAssets: CollectedAsset[],
): Promise<AnimationsOutput> {
  const browserData: BrowserAnimationExtraction = await page
    .evaluate(() => {
      const describeElement = (el: Element | null): string => {
        if (!el) return 'document';
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const classes =
          typeof el.className === 'string' && el.className.trim()
            ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
            : '';
        return `${tag}${id}${classes}`;
      };

      const seenAnims = new Set<Animation>();
      const allAnims: Animation[] = [];

      for (const a of document.getAnimations()) {
        if (!seenAnims.has(a)) {
          seenAnims.add(a);
          allAnims.push(a);
        }
      }

      try {
        if (document.documentElement) {
          for (const a of document.documentElement.getAnimations({ subtree: true })) {
            if (!seenAnims.has(a)) {
              seenAnims.add(a);
              allAnims.push(a);
            }
          }
        }
      } catch {
        // Fallback already covered by document.getAnimations()
      }

      const waapiAnimations: WaapiAnimationEntry[] = [];
      for (const anim of allAnims) {
        try {
          const effect = anim.effect as KeyframeEffect | null;
          const computedTiming = effect?.getComputedTiming?.();
          const rawKeyframes = effect?.getKeyframes?.() ?? [];

          const sanitizedKeyframes = rawKeyframes.map((kf) => {
            const entry: Record<string, string | number | null> = {};
            for (const [k, v] of Object.entries(kf)) {
              if (k === 'computedOffset' || k === 'composite') continue;
              if (
                typeof v === 'string' ||
                typeof v === 'number' ||
                v === null
              ) {
                entry[k] = v;
              }
            }
            return entry;
          });

          const animAny = anim as unknown as {
            animationName?: string;
            transitionProperty?: string;
          };
          const constructorName = anim.constructor?.name || 'Animation';

          waapiAnimations.push({
            type: constructorName,
            animationName:
              typeof animAny.animationName === 'string'
                ? animAny.animationName
                : anim.id || null,
            transitionProperty:
              typeof animAny.transitionProperty === 'string'
                ? animAny.transitionProperty
                : null,
            target: describeElement(effect?.target ?? null),
            pseudoElement: effect?.pseudoElement ?? null,
            timing: {
              delay:
                typeof computedTiming?.delay === 'number'
                  ? computedTiming.delay
                  : 0,
              duration:
                typeof computedTiming?.duration === 'number' ||
                typeof computedTiming?.duration === 'string'
                  ? computedTiming.duration
                  : String(computedTiming?.duration ?? 0),
              iterations:
                typeof computedTiming?.iterations === 'number'
                  ? computedTiming.iterations
                  : 1,
              easing: computedTiming?.easing || 'linear',
            },
            keyframes: sanitizedKeyframes,
          });
        } catch {
          // Ignore unreadable animation instance
        }
      }

      const cssomKeyframes: CssKeyframeEntry[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        const source = sheet.href || 'inline-style';
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          // Cross-origin stylesheet protected by CORS; handled via raw CSS fallback
          continue;
        }

        const scanRules = (ruleList: CSSRuleList): void => {
          for (const rule of Array.from(ruleList)) {
            const cssText = rule.cssText || '';
            if (typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule) {
              cssomKeyframes.push({
                name: rule.name,
                source,
                rulesText: cssText.replace(/\s+/g, ' ').trim(),
              });
            } else if (
              cssText.trimStart().startsWith('@starting-style') ||
              cssText.includes('animation-timeline')
            ) {
              cssomKeyframes.push({
                name: cssText.trimStart().startsWith('@starting-style')
                  ? '@starting-style'
                  : 'animation-timeline',
                source,
                rulesText: cssText.replace(/\s+/g, ' ').trim(),
              });
            } else if ('cssRules' in rule) {
              try {
                const nested = (rule as CSSGroupingRule).cssRules;
                if (nested) scanRules(nested);
              } catch {
                // Ignore inaccessible nested rules
              }
            }
          }
        };

        scanRules(rules);
      }

      return { waapiAnimations, cssomKeyframes };
    })
    .catch(() => ({ waapiAnimations: [], cssomKeyframes: [] }));

  const keyframeMap = new Map<string, CssKeyframeEntry>();
  for (const entry of browserData.cssomKeyframes) {
    const key = `${entry.name}::${entry.rulesText}`;
    if (!keyframeMap.has(key)) {
      keyframeMap.set(key, entry);
    }
  }

  for (const cssAsset of collectedCssAssets) {
    try {
      const cssText =
        typeof cssAsset.content === 'string'
          ? cssAsset.content
          : await (await import('node:fs/promises')).readFile(cssAsset.filePath, 'utf8');
      const parsedFromRaw = extractCssKeyframesFromText(cssText, cssAsset.url);
      for (const entry of parsedFromRaw) {
        const key = `${entry.name}::${entry.rulesText}`;
        if (!keyframeMap.has(key)) {
          keyframeMap.set(key, entry);
        }
      }
    } catch {
      // Ignore unreadable CSS file
    }
  }

  return {
    url,
    cdpStartedAnimations: tracker.getStartedAnimations(),
    waapiAnimations: browserData.waapiAnimations,
    cssKeyframes: [...keyframeMap.values()],
  };
}
