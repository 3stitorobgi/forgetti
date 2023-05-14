/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type * as babel from '@babel/core';
import * as t from '@babel/types';
import { isPathValid } from './checks';
import type { HookIdentity } from './presets';
import unwrapNode from './unwrap-node';
import type { StateContext } from './types';

type HookCallType =
  | HookIdentity
  | 'custom'
  | 'none';

export function getHookCallType(
  ctx: StateContext,
  path: babel.NodePath<t.CallExpression | t.OptionalCallExpression>,
): HookCallType {
  const callee = path.get('callee');
  if (isPathValid(callee, t.isV8IntrinsicIdentifier)) {
    return 'none';
  }
  const trueID = unwrapNode(callee.node, t.isIdentifier);
  if (trueID) {
    const binding = path.scope.getBindingIdentifier(trueID.name);
    if (binding) {
      const registration = ctx.registrations.hooks.get(binding);
      if (registration) {
        return registration.type;
      }
    }
    return ctx.filters.hook && ctx.filters.hook.test(trueID.name) ? 'custom' : 'none';
  }
  // Check if callee is potentially a namespace import
  const trueMember = unwrapNode(callee.node, t.isMemberExpression);
  if (
    trueMember
      && !trueMember.computed
      && t.isIdentifier(trueMember.property)
  ) {
    const obj = unwrapNode(trueMember.object, t.isIdentifier);
    if (obj) {
      const binding = path.scope.getBindingIdentifier(obj.name);
      if (binding) {
        const registrations = ctx.registrations.hooksNamespaces.get(binding);
        if (registrations) {
          let registration: typeof registrations[0];
          for (let i = 0, len = registrations.length; i < len; i += 1) {
            registration = registrations[i];
            if (registration.name === trueMember.property.name) {
              return registration.type;
            }
          }
        }
      }
    }
    return ctx.filters.hook && ctx.filters.hook.test(trueMember.property.name)
      ? 'custom'
      : 'none';
  }
  return 'none';
}
