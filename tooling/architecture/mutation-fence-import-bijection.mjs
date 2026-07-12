import ts from "typescript";

export const KERNEL_SPECIFIER = "@workload-funnel/kernel";
export const MUTATION_FENCE_SYMBOL = "MutationFence";
export const CANONICAL_MUTATION_FENCE_EXPORTS = new Set([
  "DesiredEffect",
  "FenceAuthoritySnapshot",
  "FenceComparisonResult",
  MUTATION_FENCE_SYMBOL,
  "compareMutationFence",
  "fingerprintMutationFence",
  "serializeMutationFence",
  "validateMutationFence",
]);

const structuralFenceFields = new Set([
  "attemptId",
  "clusterIncarnation",
  "clusterIncarnationVersion",
  "desiredEffect",
  "effectScopeKey",
  "executionGeneration",
  "expectedDesiredVersion",
  "namespaceWriterEpoch",
  "schemaVersion",
  "supersessionKey",
]);

function importedName(specifier) {
  return (specifier.propertyName ?? specifier.name).text;
}

function declaredPropertyNames(members) {
  return new Set(
    members
      .map((member) => {
        if (
          ts.isPropertySignature(member) &&
          member.name !== undefined &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
        ) {
          return member.name.text;
        }
        return undefined;
      })
      .filter((name) => name !== undefined),
  );
}

function isStructuralFence(members) {
  const concreteMembers = members.filter(
    (member) =>
      !ts.isPropertySignature(member) ||
      member.type?.kind !== ts.SyntaxKind.UnknownKeyword,
  );
  const names = declaredPropertyNames(concreteMembers);
  return [...structuralFenceFields].every((field) => names.has(field));
}

function isDeclarationName(node) {
  const parent = node.parent;
  return (
    ((ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isImportSpecifier(parent) &&
      (parent.name === node || parent.propertyName === node)) ||
    (ts.isExportSpecifier(parent) &&
      (parent.name === node || parent.propertyName === node))
  );
}

function propertyName(node) {
  if (
    node !== undefined &&
    (ts.isIdentifier(node) || ts.isStringLiteral(node))
  ) {
    return node.text;
  }
  return undefined;
}

function containsMutationFenceUse(node) {
  let found = false;
  function visit(candidate) {
    if (
      ts.isIdentifier(candidate) &&
      candidate.text === MUTATION_FENCE_SYMBOL &&
      !isDeclarationName(candidate)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

function mutationFencePropertyNames(declaration) {
  const members = ts.isInterfaceDeclaration(declaration)
    ? declaration.members
    : ts.isTypeAliasDeclaration(declaration) &&
        ts.isTypeLiteralNode(declaration.type)
      ? declaration.type.members
      : [];
  return new Set(
    members
      .filter(
        (member) =>
          ts.isPropertySignature(member) &&
          member.type !== undefined &&
          containsMutationFenceUse(member.type),
      )
      .map((member) => propertyName(member.name))
      .filter((name) => name !== undefined),
  );
}

function isNamedDeclarationReference(node) {
  if (isDeclarationName(node)) return false;
  const parent = node.parent;
  if (
    (ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isParameter(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return !(ts.isPropertyAccessExpression(parent) && parent.name === node);
}

function inspectSource(entry) {
  const failures = [];
  const sourceFile = ts.createSourceFile(
    entry.path,
    entry.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let canonicalImportCount = 0;
  let canonicalUseCount = 0;
  let canonicalPrimitiveUseCount = 0;
  let implicitUseCount = 0;
  let structuralUseCount = 0;
  const fenceCarryingDeclarations = new Map();
  const namedDeclarationReferences = new Set();
  const usedFencePropertyNames = new Set();

  for (const statement of sourceFile.statements) {
    if (
      !entry.kernelOwner &&
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      containsMutationFenceUse(statement)
    ) {
      const properties = mutationFencePropertyNames(statement);
      if (properties.size > 0) {
        fenceCarryingDeclarations.set(statement.name.text, properties);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleName = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (moduleName === KERNEL_SPECIFIER) {
        if (clause?.name !== undefined) {
          failures.push({
            code: "default_import",
            message: `${entry.path} default-imports the kernel`,
          });
        }
        if (clause?.namedBindings !== undefined) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            failures.push({
              code: "namespace_import",
              message: `${entry.path} namespace-imports the kernel`,
            });
          } else {
            for (const specifier of clause.namedBindings.elements) {
              const canonicalName = importedName(specifier);
              if (!CANONICAL_MUTATION_FENCE_EXPORTS.has(canonicalName)) {
                continue;
              }
              if (
                specifier.propertyName !== undefined ||
                specifier.name.text !== canonicalName
              ) {
                failures.push({
                  code: "aliased_import",
                  message: `${entry.path} aliases canonical kernel symbol ${canonicalName}`,
                });
              } else if (canonicalName === MUTATION_FENCE_SYMBOL) {
                canonicalImportCount += 1;
              }
            }
          }
        }
      } else if (moduleName.startsWith(`${KERNEL_SPECIFIER}/`)) {
        failures.push({
          code: "implicit_package_import",
          message: `${entry.path} imports a non-public kernel path ${moduleName}`,
        });
      } else if (
        clause?.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.some((specifier) =>
          CANONICAL_MUTATION_FENCE_EXPORTS.has(importedName(specifier)),
        )
      ) {
        failures.push({
          code: "transitive_import",
          message: `${entry.path} imports MutationFence transitively from ${moduleName}`,
        });
      }
    }

    if (
      !entry.kernelOwner &&
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined
    ) {
      const moduleName = statement.moduleSpecifier?.text;
      if (
        (ts.isNamespaceExport(statement.exportClause) &&
          typeof moduleName === "string" &&
          moduleName.startsWith(KERNEL_SPECIFIER)) ||
        (ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.some((specifier) =>
            CANONICAL_MUTATION_FENCE_EXPORTS.has(importedName(specifier)),
          ))
      ) {
        failures.push({
          code: "transitive_export",
          message: `${entry.path} re-exports MutationFence or a kernel namespace`,
        });
      }
    }
  }

  function visit(node) {
    const declarationName =
      (ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node)) &&
      node.name !== undefined
        ? node.name.text
        : undefined;
    if (
      declarationName !== undefined &&
      CANONICAL_MUTATION_FENCE_EXPORTS.has(declarationName) &&
      !entry.kernelOwner
    ) {
      failures.push({
        code: "duplicate_declaration",
        message: `${entry.path} redeclares canonical kernel symbol ${declarationName} outside packages/kernel`,
      });
    }
    if (
      !entry.kernelOwner &&
      ((ts.isInterfaceDeclaration(node) && isStructuralFence(node.members)) ||
        (ts.isTypeLiteralNode(node) && isStructuralFence(node.members)))
    ) {
      structuralUseCount += 1;
      failures.push({
        code: "structural_redeclaration",
        message: `${entry.path} structurally redeclares the canonical MutationFence`,
      });
    }
    if (
      ts.isIdentifier(node) &&
      CANONICAL_MUTATION_FENCE_EXPORTS.has(node.text) &&
      !isDeclarationName(node)
    ) {
      canonicalPrimitiveUseCount += 1;
      if (node.text === MUTATION_FENCE_SYMBOL) canonicalUseCount += 1;
    }
    if (ts.isIdentifier(node) && isNamedDeclarationReference(node)) {
      namedDeclarationReferences.add(node.text);
    }
    if (
      !entry.kernelOwner &&
      ((ts.isPropertyAccessExpression(node) &&
        node.name.text === "mutationFence") ||
        ((ts.isPropertySignature(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
          propertyName(node.name) === "mutationFence"))
    ) {
      implicitUseCount += 1;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const name = propertyName(node.name);
      if (name !== undefined) usedFencePropertyNames.add(name);
    }
    if (ts.isBindingElement(node)) {
      const name = propertyName(node.propertyName ?? node.name);
      if (name !== undefined) usedFencePropertyNames.add(name);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const consumes =
    canonicalPrimitiveUseCount > 0 ||
    implicitUseCount > 0 ||
    structuralUseCount > 0;
  if (!entry.kernelOwner && consumes && canonicalImportCount === 0) {
    failures.push({
      code: "implicit_import",
      message: `${entry.path} consumes MutationFence without its named kernel import`,
    });
  }
  if (canonicalImportCount > 0 && canonicalUseCount === 0) {
    failures.push({
      code: "unused_import",
      message: `${entry.path} imports MutationFence without using the named symbol`,
    });
  }
  return {
    canonicalImportCount,
    canonicalUseCount,
    consumes,
    fenceCarryingDeclarations,
    failures,
    implicitUseCount,
    namedDeclarationReferences,
    usedFencePropertyNames,
  };
}

export function parseMutationFenceGrants(plan) {
  const grants = new Map();
  for (const match of plan.matchAll(/^K\|([^|]+)\|([^\n]+)$/gmu)) {
    const nodeId = match[1];
    const symbols = match[2];
    if (nodeId === undefined || symbols === undefined) continue;
    if (grants.has(nodeId)) {
      throw new Error(`duplicate K row for ${nodeId}`);
    }
    grants.set(nodeId, new Set(symbols === "empty" ? [] : symbols.split("+")));
  }
  if (grants.size === 0) throw new Error("architecture plan has no K rows");
  return grants;
}

export function checkMutationFenceImportBijection(entries, grants) {
  const failures = [];
  const nodesWithSources = new Set(entries.map((entry) => entry.nodeId));
  const nodesWithDirectUse = new Set();
  const fenceDeclarationsByNode = new Map();
  const fenceDeclarationReferencesByNode = new Map();
  const fencePropertyUsesByNode = new Map();
  let ownerDeclarations = 0;
  let ownerPublicExports = 0;

  for (const entry of entries) {
    const inspected = inspectSource(entry);
    failures.push(...inspected.failures);
    const declarations = fenceDeclarationsByNode.get(entry.nodeId) ?? new Map();
    for (const [name, properties] of inspected.fenceCarryingDeclarations) {
      const declaredProperties = declarations.get(name) ?? new Set();
      for (const property of properties) declaredProperties.add(property);
      declarations.set(name, declaredProperties);
    }
    fenceDeclarationsByNode.set(entry.nodeId, declarations);
    const references =
      fenceDeclarationReferencesByNode.get(entry.nodeId) ?? new Set();
    for (const name of inspected.namedDeclarationReferences) {
      references.add(name);
    }
    fenceDeclarationReferencesByNode.set(entry.nodeId, references);
    const propertyUses = fencePropertyUsesByNode.get(entry.nodeId) ?? new Set();
    for (const name of inspected.usedFencePropertyNames) {
      propertyUses.add(name);
    }
    fencePropertyUsesByNode.set(entry.nodeId, propertyUses);
    if (entry.kernelOwner) {
      const sourceFile = ts.createSourceFile(
        entry.path,
        entry.source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      for (const statement of sourceFile.statements) {
        if (
          (ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
          statement.name.text === MUTATION_FENCE_SYMBOL
        ) {
          ownerDeclarations += 1;
          if (entry.path !== "packages/kernel/src/mutation-fence.ts") {
            failures.push({
              code: "owner_location",
              message: `${entry.path} declares MutationFence outside the canonical kernel source`,
            });
          }
        }
        if (
          entry.path === "packages/kernel/src/index.ts" &&
          ts.isExportDeclaration(statement) &&
          statement.moduleSpecifier?.text === "./mutation-fence.js" &&
          statement.exportClause !== undefined &&
          ts.isNamedExports(statement.exportClause)
        ) {
          const exported = new Set(
            statement.exportClause.elements.map(importedName),
          );
          if (
            exported.size === CANONICAL_MUTATION_FENCE_EXPORTS.size &&
            [...CANONICAL_MUTATION_FENCE_EXPORTS].every((symbol) =>
              exported.has(symbol),
            )
          ) {
            ownerPublicExports += 1;
          }
        }
      }
      continue;
    }
    if (inspected.consumes || inspected.canonicalImportCount > 0) {
      nodesWithDirectUse.add(entry.nodeId);
      if (grants.get(entry.nodeId)?.has(MUTATION_FENCE_SYMBOL) !== true) {
        failures.push({
          code: "used_but_ungranted",
          message: `${entry.path} uses MutationFence but ${entry.nodeId} has no exact K grant`,
        });
      }
    }
  }

  if (ownerDeclarations !== 1) {
    failures.push({
      code: "owner_declaration_count",
      message: `packages/kernel must own exactly one MutationFence declaration; found ${String(ownerDeclarations)}`,
    });
  }
  if (ownerPublicExports !== 1) {
    failures.push({
      code: "owner_public_export",
      message:
        "packages/kernel public index must named-export the exact canonical MutationFence API",
    });
  }
  for (const [nodeId, declarations] of fenceDeclarationsByNode) {
    const references =
      fenceDeclarationReferencesByNode.get(nodeId) ?? new Set();
    const propertyUses = fencePropertyUsesByNode.get(nodeId) ?? new Set();
    for (const [name, properties] of declarations) {
      if (
        !references.has(name) ||
        ![...properties].some((property) => propertyUses.has(property))
      ) {
        failures.push({
          code: "marker_only_declaration",
          message: `${nodeId} declares fence-carrying ${name} without consuming it in a real contract or implementation`,
        });
      }
    }
  }
  for (const [nodeId, symbols] of grants) {
    if (
      symbols.has(MUTATION_FENCE_SYMBOL) &&
      nodesWithSources.has(nodeId) &&
      !nodesWithDirectUse.has(nodeId)
    ) {
      failures.push({
        code: "granted_but_unused",
        message: `${nodeId} has a MutationFence K grant but no direct named use`,
      });
    }
  }
  return failures;
}
