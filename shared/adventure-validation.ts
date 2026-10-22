import { z } from 'zod';
import { AdventureDefinitionSchema, type AdventureDefinition, type AdventureEffect, type AdventureCondition } from './adventure-schema.js';

export type AdventureValidationIssue = { path: string; message: string };
export type AdventureValidationResult =
  | { ok: true; adventure: AdventureDefinition }
  | { ok: false; issues: AdventureValidationIssue[] };

function uniqueIds(values: string[], path: string, issues: AdventureValidationIssue[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) issues.push({ path, message: `duplicate id "${value}"` });
    seen.add(value);
  }
}

function conditionReferences(condition: AdventureCondition, itemIds: Set<string>, variableIds: Set<string>, path: string, issues: AdventureValidationIssue[]) {
  if ('item_id' in condition && !itemIds.has(condition.item_id)) {
    issues.push({ path, message: `references unknown item "${condition.item_id}"` });
  }
  if ('variable_id' in condition && !variableIds.has(condition.variable_id)) {
    issues.push({ path, message: `references unknown variable "${condition.variable_id}"` });
  }
}

function effectReferences(effect: AdventureEffect, adventure: AdventureDefinition, itemIds: Set<string>, path: string, issues: AdventureValidationIssue[]) {
  if ('item_id' in effect && !itemIds.has(effect.item_id)) {
    issues.push({ path, message: `references unknown item "${effect.item_id}"` });
  }
  if ('variable_id' in effect) {
    const variable = adventure.variables[effect.variable_id];
    if (!variable) {
      issues.push({ path, message: `references unknown variable "${effect.variable_id}"` });
    } else if (effect.kind === 'set_variable' && (effect.value < variable.min || effect.value > variable.max)) {
      issues.push({ path, message: `sets variable "${effect.variable_id}" outside its declared bounds` });
    } else if (effect.kind === 'increment_variable' && Math.abs(effect.amount) > variable.max - variable.min) {
      issues.push({ path, message: `increment for "${effect.variable_id}" exceeds its declared range` });
    }
  }
}

/** Validate shape plus structural references and graph properties, without simulating state. */
export function validateAdventureDefinition(input: unknown): AdventureValidationResult {
  const parsed = AdventureDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    };
  }

  const adventure = parsed.data;
  const issues: AdventureValidationIssue[] = [];
  const nodeIds = new Set(adventure.nodes.map((node) => node.id));
  const itemIds = new Set(adventure.items.map((item) => item.id));
  const variableIds = new Set(Object.keys(adventure.variables));
  uniqueIds(adventure.nodes.map((node) => node.id), 'nodes', issues);
  uniqueIds(adventure.items.map((item) => item.id), 'items', issues);
  uniqueIds(adventure.characters.map((character) => character.id), 'characters', issues);

  const choices = adventure.nodes.flatMap((node) => node.kind === 'scene' ? node.choices : []);
  uniqueIds(choices.map((choice) => choice.id), 'nodes.choices', issues);
  if (!nodeIds.has(adventure.initial_node_id)) {
    issues.push({ path: 'initial_node_id', message: `references unknown node "${adventure.initial_node_id}"` });
  }

  const edges = new Map<string, string[]>();
  for (const node of adventure.nodes) edges.set(node.id, []);
  for (const [nodeIndex, node] of adventure.nodes.entries()) {
    if (node.kind !== 'scene') continue;
    const currentChoiceIds = new Set(node.choices.map((choice) => choice.id));
    uniqueIds(node.affordances.map((affordance) => affordance.id), `nodes.${nodeIndex}.affordances`, issues);
    for (const [affordanceIndex, affordance] of node.affordances.entries()) {
      const base = `nodes.${nodeIndex}.affordances.${affordanceIndex}`;
      if (!currentChoiceIds.has(affordance.resolution_choice_id)) {
        issues.push({ path: `${base}.resolution_choice_id`, message: `must reference a choice on the same node (got "${affordance.resolution_choice_id}")` });
      }
      uniqueIds(affordance.targets.map((target) => target.id), `${base}.targets`, issues);
      uniqueIds(affordance.approaches.map((approach) => approach.id), `${base}.approaches`, issues);
      uniqueIds(affordance.item_ids, `${base}.item_ids`, issues);
      for (const itemId of affordance.item_ids) {
        if (!itemIds.has(itemId)) issues.push({ path: `${base}.item_ids`, message: `references unknown item "${itemId}"` });
      }
    }
    for (const [choiceIndex, choice] of node.choices.entries()) {
      const base = `nodes.${nodeIndex}.choices.${choiceIndex}`;
      for (const condition of choice.conditions) {
        conditionReferences(condition, itemIds, variableIds, `${base}.conditions`, issues);
        if (condition.kind === 'variable') {
          const variable = adventure.variables[condition.variable_id];
          if (variable && (condition.value < variable.min || condition.value > variable.max)) {
            issues.push({ path: `${base}.conditions`, message: `condition value is outside variable "${condition.variable_id}" bounds` });
          }
        }
      }
      for (const effect of choice.effects) effectReferences(effect, adventure, itemIds, `${base}.effects`, issues);
      const targets = choice.transition.kind === 'direct'
        ? [choice.transition.target_node_id]
        : [choice.transition.success_node_id, choice.transition.setback_node_id];
      for (const target of targets) {
        if (!nodeIds.has(target)) {
          issues.push({ path: `${base}.transition`, message: `references unknown node "${target}"` });
        } else {
          edges.get(node.id)!.push(target);
        }
      }
      if (choice.transition.kind === 'check') {
        for (const effect of [...choice.transition.success_effects, ...choice.transition.setback_effects]) {
          effectReferences(effect, adventure, itemIds, `${base}.transition`, issues);
        }
      }
    }
  }

  if (nodeIds.has(adventure.initial_node_id)) {
    const colors = new Map<string, 'visiting' | 'visited'>();
    const reachable = new Set<string>();
    let hasCycle = false;
    const visit = (nodeId: string) => {
      const color = colors.get(nodeId);
      if (color === 'visiting') { hasCycle = true; return; }
      if (color === 'visited') return;
      colors.set(nodeId, 'visiting');
      reachable.add(nodeId);
      for (const target of edges.get(nodeId) ?? []) visit(target);
      colors.set(nodeId, 'visited');
    };
    visit(adventure.initial_node_id);
    if (hasCycle) issues.push({ path: 'nodes', message: 'graph must be acyclic' });
    const unreachable = adventure.nodes.filter((node) => !reachable.has(node.id));
    if (unreachable.length > 0) {
      issues.push({ path: 'nodes', message: `unreachable node(s): ${unreachable.map((node) => node.id).join(', ')}` });
    }
    if (!adventure.nodes.some((node) => node.kind === 'ending' && reachable.has(node.id))) {
      issues.push({ path: 'nodes', message: 'no ending is structurally reachable from initial_node_id' });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, adventure };
}

export function formatAdventureIssues(issues: AdventureValidationIssue[]): string {
  return issues.map(({ path, message }) => `${path || '(root)'}: ${message}`).join('\n');
}

// Keep ZodError available to callers that want precise schema diagnostics.
export type AdventureSchemaError = z.ZodError;
