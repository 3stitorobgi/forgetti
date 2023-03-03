import * as t from '@babel/types';
import * as babel from '@babel/core';
import { ComponentNode, StateContext } from './types';

export function getImportSpecifierName(specifier: t.ImportSpecifier): string {
  if (t.isIdentifier(specifier.imported)) {
    return specifier.imported.name;
  }
  return specifier.imported.value;
}

export function isComponent(node: t.Node): node is ComponentNode {
  return (
    t.isArrowFunctionExpression(node)
    || t.isFunctionExpression(node)
    || t.isFunctionDeclaration(node)
  );
}

export function isComponentNameValid(
  ctx: StateContext,
  node: ComponentNode,
  checkName = false,
) {
  if (checkName) {
    if (t.isFunctionExpression(node) || t.isFunctionDeclaration(node)) {
      return (
        node.id
        && (
          ctx.filters.component.test(node.id.name)
          || (ctx.filters.hook && ctx.filters.hook.test(node.id.name))
        )
      );
    }
    return false;
  }
  return true;
}

type TypeFilter<V extends t.Node> = (node: t.Node) => node is V;

export function isPathValid<V extends t.Node>(
  path: unknown,
  key: TypeFilter<V>,
): path is babel.NodePath<V> {
  return key((path as babel.NodePath).node);
}

export type NestedExpression =
  | t.ParenthesizedExpression
  | t.TypeCastExpression
  | t.TSAsExpression
  | t.TSSatisfiesExpression
  | t.TSNonNullExpression
  | t.TSInstantiationExpression
  | t.TSTypeAssertion;

export function isNestedExpression(node: t.Node): node is NestedExpression {
  return t.isParenthesizedExpression(node)
    || t.isTypeCastExpression(node)
    || t.isTSAsExpression(node)
    || t.isTSSatisfiesExpression(node)
    || t.isTSNonNullExpression(node)
    || t.isTSTypeAssertion(node)
    || t.isTSInstantiationExpression(node);
}
