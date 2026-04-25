#!/usr/bin/env tsx
/**
 * i18n Audit Script
 *
 * Performs three checks:
 * 1. Cross-language key parity (en ↔ zh-CN ↔ zh-TW)
 * 2. Code-to-translation alignment (t('key') references exist in JSON)
 * 3. Unused key detection (JSON keys not referenced in code)
 *
 * Usage:
 *   pnpm tsx scripts/i18n-audit.ts [options]
 *
 * Options:
 *   --portal admin-portal|customer-portal   Audit one portal (default: both)
 *   --check parity|alignment|unused         Run one check (default: all)
 *   --json                                  Output as JSON
 *   --strict                                Exit with code 1 if issues found
 */

import * as fs from "fs";
import * as path from "path";

// ─── Configuration ───────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..");

const PORTALS: Record<string, PortalConfig> = {
  "admin-portal": {
    messagesDir: path.join(ROOT, "apps/admin-portal/messages"),
    codeDirs: [
      path.join(ROOT, "apps/admin-portal/app"),
      path.join(ROOT, "apps/admin-portal/components"),
      path.join(ROOT, "packages/ui/src"),
    ],
    locales: ["en", "zh-CN", "zh-TW"],
  },
  "customer-portal": {
    messagesDir: path.join(ROOT, "apps/customer-portal/messages"),
    codeDirs: [
      path.join(ROOT, "apps/customer-portal/app"),
      path.join(ROOT, "apps/customer-portal/components"),
      path.join(ROOT, "packages/ui/src"),
    ],
    locales: ["en", "zh-CN", "zh-TW"],
  },
};

// Namespaces that use dynamic key access (t(`status.${var}`)) — exclude from unused detection.
// Dotted paths are supported and matched as prefixes (e.g. "settings.users.roles" excludes
// every key under settings.users.roles.*). Use this list when the audit's dynamic-call
// detector cannot see the call site — typically because the translation function is passed
// in as a prop, or because the dynamic substitution contains characters the regex can't span.
const DYNAMIC_NAMESPACES = [
  // Top-level enum-style prefixes
  "statusBadges",
  "orderStatusDescriptions",
  "productUnits",
  "australianStates",
  "days",
  "areaTags",
  "apiErrors",
  "orderErrors",
  "packingErrors",
  "categories",
  "status",
  "paymentMethods",
  // Nested admin-portal prefixes — accessed via t(`prefix.${var}`)
  "creditReview.creditStatus",
  "customerDetail.businessInfo.accountTypes",
  "driver.returnDialog.reasons",
  "orderDetail.actionBar",
  "settings.auditLogs.entities",
  "settings.auditLogs.actions",
  "settings.delivery.workingDays",
  "settings.permissions.roles",
  "settings.permissions.modules",
  "settings.permissions.actions",
  "settings.users.roles",
  "settings.users.roleDescriptions",
  // Prop-based translation function in StockCountsTable — invisible to binding extractor
  "inventory.stockCounts.conversionBatches",
  // Dynamic substitution contains a method call (cat.toLowerCase()) that breaks the regex
  "packing.categories",
  // Nested customer-portal prefixes
  "onboarding.steps",
];

// ─── Types ───────────────────────────────────────────────────────────────────

interface PortalConfig {
  messagesDir: string;
  codeDirs: string[];
  locales: string[];
}

interface ParityIssue {
  key: string;
  presentIn: string[];
  missingFrom: string[];
}

interface AlignmentIssue {
  file: string;
  line: number;
  namespace: string;
  key: string;
  fullKey: string;
  type: "missing" | "unverifiable";
}

interface UnusedKey {
  key: string;
  namespace: string;
}

interface AuditResult {
  portal: string;
  parity: ParityIssue[];
  alignment: AlignmentIssue[];
  unused: UnusedKey[];
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/** Recursively extract all leaf key paths from a JSON object */
function extractLeafKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...extractLeafKeys(v as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/** Extract all key paths (both branch and leaf) from a JSON object */
function extractAllPaths(obj: Record<string, unknown>, prefix = ""): Set<string> {
  const paths = new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    paths.add(fullKey);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const p of extractAllPaths(v as Record<string, unknown>, fullKey)) {
        paths.add(p);
      }
    }
  }
  return paths;
}

/** Recursively find all .ts/.tsx files in a directory */
function findSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      results.push(...findSourceFiles(fullPath));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Check if a key exists in the JSON as a leaf or branch */
function keyExistsInJson(allPaths: Set<string>, key: string): boolean {
  return allPaths.has(key);
}

/** Check if a key is under a dynamic namespace */
function isUnderDynamicNamespace(key: string): boolean {
  return DYNAMIC_NAMESPACES.some(
    (ns) => key === ns || key.startsWith(ns + ".")
  );
}

// ─── Check 1: Cross-Language Key Parity ──────────────────────────────────────

function checkParity(config: PortalConfig): ParityIssue[] {
  const keysByLocale: Record<string, Set<string>> = {};

  for (const locale of config.locales) {
    const filePath = path.join(config.messagesDir, `${locale}.json`);
    const json = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    keysByLocale[locale] = new Set(extractLeafKeys(json));
  }

  // Collect union of all keys
  const allKeys = new Set<string>();
  for (const keys of Object.values(keysByLocale)) {
    for (const k of keys) allKeys.add(k);
  }

  const issues: ParityIssue[] = [];
  for (const key of [...allKeys].sort()) {
    const presentIn = config.locales.filter((l) => keysByLocale[l].has(key));
    const missingFrom = config.locales.filter((l) => !keysByLocale[l].has(key));
    if (missingFrom.length > 0) {
      issues.push({ key, presentIn, missingFrom });
    }
  }

  return issues;
}

// ─── Check 2: Code-to-Translation Alignment ─────────────────────────────────

interface TranslationBinding {
  varName: string;
  namespace: string;
  file: string;
  line: number;
}

function extractTranslationBindings(
  content: string,
  filePath: string
): TranslationBinding[] {
  const bindings: TranslationBinding[] = [];
  const lines = content.split("\n");

  // Permissive declarator prefix: optional `const|let|var` (so reassignments and
  // `let user, t;` followed by `t = await getTranslations(...)` are caught too).
  const D = String.raw`(?:const|let|var\s+)?\s*`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Pattern: const t = useTranslations('namespace')
    // Pattern: const tCommon = useTranslations('common')
    // Pattern: const t = useTranslations()
    const useMatch = line.match(
      new RegExp(`${D}(\\w+)\\s*=\\s*useTranslations\\(\\s*(?:'([^']*)'|"([^"]*)")?\\s*\\)`)
    );
    if (useMatch) {
      bindings.push({
        varName: useMatch[1],
        namespace: useMatch[2] || useMatch[3] || "",
        file: filePath,
        line: i + 1,
      });
    }

    // Pattern: const t = await getTranslations({ locale, namespace: 'metadata' })
    const getMatchObj = line.match(
      new RegExp(`${D}(\\w+)\\s*=\\s*await\\s+getTranslations\\(\\s*\\{[^}]*namespace:\\s*(?:'([^']*)'|"([^"]*)")`)
    );
    if (getMatchObj) {
      bindings.push({
        varName: getMatchObj[1],
        namespace: getMatchObj[2] || getMatchObj[3] || "",
        file: filePath,
        line: i + 1,
      });
    }

    // Pattern: const t = await getTranslations('namespace')
    const getMatchSimple = line.match(
      new RegExp(`${D}(\\w+)\\s*=\\s*await\\s+getTranslations\\(\\s*(?:'([^']*)'|"([^"]*)")\\s*\\)`)
    );
    if (getMatchSimple) {
      bindings.push({
        varName: getMatchSimple[1],
        namespace: getMatchSimple[2] || getMatchSimple[3] || "",
        file: filePath,
        line: i + 1,
      });
    }

    // Pattern: const t = await getTranslations({ locale })  (no namespace = root)
    const getMatchNoNs = line.match(
      new RegExp(`${D}(\\w+)\\s*=\\s*await\\s+getTranslations\\(\\s*\\{[^}]*\\}\\s*\\)`)
    );
    if (getMatchNoNs && !getMatchObj) {
      // Only if there's no namespace match
      if (!line.includes("namespace:")) {
        bindings.push({
          varName: getMatchNoNs[1],
          namespace: "",
          file: filePath,
          line: i + 1,
        });
      }
    }

    // Pattern: const t = await getTranslations()  (root, no args)
    const getMatchEmpty = line.match(
      new RegExp(`${D}(\\w+)\\s*=\\s*await\\s+getTranslations\\(\\s*\\)`)
    );
    if (getMatchEmpty) {
      bindings.push({
        varName: getMatchEmpty[1],
        namespace: "",
        file: filePath,
        line: i + 1,
      });
    }
  }

  return bindings;
}

/** For a given variable name at a given line, find the nearest preceding binding */
function findNearestBinding(
  varName: string,
  lineNum: number,
  bindings: TranslationBinding[]
): TranslationBinding | null {
  let best: TranslationBinding | null = null;
  for (const b of bindings) {
    if (b.varName === varName && b.line <= lineNum) {
      if (!best || b.line > best.line) {
        best = b;
      }
    }
  }
  return best;
}

function extractTranslationCalls(
  content: string,
  bindings: TranslationBinding[]
): {
  calls: { fullKey: string; file: string; line: number; namespace: string; key: string; isDynamic: boolean }[];
  dynamicNamespaces: Set<string>;
} {
  const calls: { fullKey: string; file: string; line: number; namespace: string; key: string; isDynamic: boolean }[] = [];
  const dynamicNamespaces = new Set<string>();
  const lines = content.split("\n");

  // Collect unique variable names from bindings
  const varNames = [...new Set(bindings.map((b) => b.varName))];

  for (const varName of varNames) {
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Find the nearest preceding binding for this variable at this line
      const binding = findNearestBinding(varName, lineNum, bindings);
      if (!binding) continue;

      // Match t('key') or t("key") — string literal keys
      const stringPattern = new RegExp(
        `\\b${escaped}\\(\\s*(?:'([^']+)'|"([^"]+)")`,
        "g"
      );
      let match: RegExpExecArray | null;
      while ((match = stringPattern.exec(line)) !== null) {
        const key = match[1] || match[2];
        const fullKey = binding.namespace ? `${binding.namespace}.${key}` : key;
        calls.push({
          fullKey,
          file: binding.file,
          line: lineNum,
          namespace: binding.namespace,
          key,
          isDynamic: false,
        });
      }

      // Match t(`template`) — template literal keys (dynamic).
      // Terminate at the closing backtick so substitutions like ${cat.toLowerCase()} don't
      // break the match on their internal parens.
      const templatePattern = new RegExp(
        `\\b${escaped}\\(\\s*\`([^\`]+)\``,
        "g"
      );
      while ((match = templatePattern.exec(line)) !== null) {
        const template = match[1];
        if (template.includes("${")) {
          const fullKey = binding.namespace
            ? `${binding.namespace}.${template}`
            : template;
          calls.push({
            fullKey,
            file: binding.file,
            line: lineNum,
            namespace: binding.namespace,
            key: template,
            isDynamic: true,
          });
        } else {
          const fullKey = binding.namespace
            ? `${binding.namespace}.${template}`
            : template;
          calls.push({
            fullKey,
            file: binding.file,
            line: lineNum,
            namespace: binding.namespace,
            key: template,
            isDynamic: false,
          });
        }
      }

      // Detect t(variable) — non-string, non-template arguments (dynamic access)
      // This catches patterns like t(item.labelKey), t(key), t(someVar)
      // Exclude t('string'), t("string"), t(`template`), and t() with no args
      const varCallPattern = new RegExp(
        `\\b${escaped}\\(\\s*([a-zA-Z_$][a-zA-Z0-9_.$]*)\\s*[,)]`,
        "g"
      );
      while ((match = varCallPattern.exec(line)) !== null) {
        const arg = match[1];
        // Skip if it's a string/template literal (already handled), object, or number
        if (
          arg === "undefined" || arg === "null" || arg === "true" || arg === "false" ||
          /^\d/.test(arg)
        ) continue;
        // This namespace uses dynamic key access — mark all its keys as used
        if (binding.namespace) {
          dynamicNamespaces.add(binding.namespace);
        }
      }
    }
  }

  return { calls, dynamicNamespaces };
}

function checkAlignment(
  config: PortalConfig
): { issues: AlignmentIssue[]; referencedKeys: Set<string>; dynamicNamespaces: Set<string> } {
  // Load EN json as the source of truth for checking key existence
  const enPath = path.join(config.messagesDir, "en.json");
  const enJson = JSON.parse(fs.readFileSync(enPath, "utf-8"));
  const allPaths = extractAllPaths(enJson);

  const issues: AlignmentIssue[] = [];
  const referencedKeys = new Set<string>();
  const allDynamicNamespaces = new Set<string>();

  // Track files already scanned (packages/ui/src is shared)
  const scannedFiles = new Set<string>();

  for (const dir of config.codeDirs) {
    const files = findSourceFiles(dir);
    for (const file of files) {
      if (scannedFiles.has(file)) continue;
      scannedFiles.add(file);

      const content = fs.readFileSync(file, "utf-8");

      // Skip files that don't use translations
      if (
        !content.includes("useTranslations") &&
        !content.includes("getTranslations")
      ) {
        continue;
      }

      // Skip files where getTranslations is defined locally (not imported from next-intl)
      const importsNextIntl =
        content.includes("from 'next-intl'") ||
        content.includes('from "next-intl"') ||
        content.includes("from 'next-intl/server'") ||
        content.includes('from "next-intl/server"');

      if (!importsNextIntl) continue;

      const bindings = extractTranslationBindings(content, file);
      const { calls, dynamicNamespaces } = extractTranslationCalls(content, bindings);

      // Collect dynamically-accessed namespaces
      for (const ns of dynamicNamespaces) {
        allDynamicNamespaces.add(ns);
      }

      for (const call of calls) {
        if (call.isDynamic) {
          issues.push({
            file: path.relative(ROOT, call.file),
            line: call.line,
            namespace: call.namespace,
            key: call.key,
            fullKey: call.fullKey,
            type: "unverifiable",
          });
          // For dynamic keys, add the static prefix as referenced
          const staticPrefix = call.fullKey.split("${")[0].replace(/\.$/, "");
          if (staticPrefix) {
            referencedKeys.add(staticPrefix);
            // Also mark all keys under this prefix as referenced
            for (const p of allPaths) {
              if (p.startsWith(staticPrefix + ".") || p === staticPrefix) {
                referencedKeys.add(p);
              }
            }
          }
        } else {
          referencedKeys.add(call.fullKey);
          if (!keyExistsInJson(allPaths, call.fullKey)) {
            issues.push({
              file: path.relative(ROOT, call.file),
              line: call.line,
              namespace: call.namespace,
              key: call.key,
              fullKey: call.fullKey,
              type: "missing",
            });
          }
        }
      }
    }
  }

  // Mark all keys under dynamically-accessed namespaces as referenced
  for (const ns of allDynamicNamespaces) {
    for (const p of allPaths) {
      if (p.startsWith(ns + ".") || p === ns) {
        referencedKeys.add(p);
      }
    }
  }

  return { issues, referencedKeys, dynamicNamespaces: allDynamicNamespaces };
}

// ─── Check 3: Unused Key Detection ──────────────────────────────────────────

function checkUnused(
  config: PortalConfig,
  referencedKeys: Set<string>
): UnusedKey[] {
  const enPath = path.join(config.messagesDir, "en.json");
  const enJson = JSON.parse(fs.readFileSync(enPath, "utf-8"));
  const leafKeys = extractLeafKeys(enJson);

  const unused: UnusedKey[] = [];
  for (const key of leafKeys.sort()) {
    // Skip dynamic namespaces
    if (isUnderDynamicNamespace(key)) continue;

    // A key is "used" if it or any ancestor is directly referenced
    if (!referencedKeys.has(key)) {
      const namespace = key.split(".").slice(0, -1).join(".");
      unused.push({ key, namespace });
    }
  }

  return unused;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let portal: string | null = null;
  let check: string | null = null;
  let json = false;
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--portal" && args[i + 1]) {
      portal = args[++i];
    } else if (args[i] === "--check" && args[i + 1]) {
      check = args[++i];
    } else if (args[i] === "--json") {
      json = true;
    } else if (args[i] === "--strict") {
      strict = true;
    }
  }

  return { portal, check, json, strict };
}

function main() {
  const { portal, check, json, strict } = parseArgs();

  const portalNames = portal ? [portal] : Object.keys(PORTALS);
  const results: AuditResult[] = [];
  let totalIssues = 0;

  for (const portalName of portalNames) {
    const config = PORTALS[portalName];
    if (!config) {
      console.error(`Unknown portal: ${portalName}`);
      process.exit(1);
    }

    const result: AuditResult = {
      portal: portalName,
      parity: [],
      alignment: [],
      unused: [],
    };

    // Check 1: Parity
    if (!check || check === "parity") {
      result.parity = checkParity(config);
    }

    // Check 2: Alignment (also needed for unused check)
    let referencedKeys = new Set<string>();
    if (!check || check === "alignment" || check === "unused") {
      const alignmentResult = checkAlignment(config);
      result.alignment = alignmentResult.issues;
      referencedKeys = alignmentResult.referencedKeys;
    }

    // Check 3: Unused
    if (!check || check === "unused") {
      result.unused = checkUnused(config, referencedKeys);
    }

    results.push(result);

    // Count actual issues (unverifiable are informational, not errors)
    totalIssues += result.parity.length;
    totalIssues += result.alignment.filter((i) => i.type === "missing").length;
    totalIssues += result.unused.length;
  }

  // Output
  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const result of results) {
      console.log(`\n${"=".repeat(70)}`);
      console.log(`  Portal: ${result.portal}`);
      console.log(`${"=".repeat(70)}`);

      // Parity
      if (!check || check === "parity") {
        console.log(`\n--- Check 1: Cross-Language Key Parity ---`);
        if (result.parity.length === 0) {
          console.log("  ✓ All languages have identical key sets");
        } else {
          console.log(`  ✗ ${result.parity.length} key(s) with parity issues:\n`);
          for (const issue of result.parity) {
            console.log(`  Key: ${issue.key}`);
            console.log(`    Present in: ${issue.presentIn.join(", ")}`);
            console.log(`    Missing from: ${issue.missingFrom.join(", ")}\n`);
          }
        }
      }

      // Alignment
      if (!check || check === "alignment") {
        console.log(`\n--- Check 2: Code-to-Translation Alignment ---`);
        const missing = result.alignment.filter((i) => i.type === "missing");
        const dynamic = result.alignment.filter(
          (i) => i.type === "unverifiable"
        );

        if (missing.length === 0) {
          console.log("  ✓ All code references resolve to existing keys");
        } else {
          console.log(
            `  ✗ ${missing.length} key(s) referenced in code but missing from JSON:\n`
          );
          for (const issue of missing) {
            console.log(`  ${issue.file}:${issue.line}`);
            console.log(`    Key: ${issue.fullKey}\n`);
          }
        }

        if (dynamic.length > 0) {
          console.log(
            `  ℹ ${dynamic.length} dynamic key(s) (unverifiable, not errors):\n`
          );
          for (const issue of dynamic) {
            console.log(`  ${issue.file}:${issue.line}`);
            console.log(`    Key: ${issue.fullKey}\n`);
          }
        }
      }

      // Unused
      if (!check || check === "unused") {
        console.log(`\n--- Check 3: Unused Key Detection ---`);
        if (result.unused.length === 0) {
          console.log("  ✓ No unused keys detected");
        } else {
          console.log(
            `  ⚠ ${result.unused.length} potentially unused key(s):\n`
          );
          // Group by top-level namespace for readability
          const grouped: Record<string, string[]> = {};
          for (const u of result.unused) {
            const ns = u.key.split(".")[0];
            if (!grouped[ns]) grouped[ns] = [];
            grouped[ns].push(u.key);
          }
          for (const [ns, keys] of Object.entries(grouped).sort()) {
            console.log(`  [${ns}]`);
            for (const k of keys) {
              console.log(`    ${k}`);
            }
            console.log();
          }
        }
      }
    }

    // Summary
    console.log(`\n${"=".repeat(70)}`);
    console.log(`  SUMMARY: ${totalIssues} issue(s) found`);
    console.log(`${"=".repeat(70)}\n`);
  }

  if (strict && totalIssues > 0) {
    process.exit(1);
  }
}

main();
