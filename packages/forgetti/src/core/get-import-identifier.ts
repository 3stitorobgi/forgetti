import type * as babel from '@babel/core';
import type * as t from '@babel/types';
import { addDefault, addNamed } from '@babel/helper-module-imports';
import type { ImportRegistration } from './presets';
import type { StateContext } from './types';

export default function getImportIdentifier(
  ctx: StateContext,
  path: babel.NodePath,
  definition: ImportRegistration,
): t.Identifier {
  const target = `${definition.source}[${definition.name}]`;
  const current = ctx.hooks.get(target);
  if (current) {
    return current;
  }
  const newID = (definition.kind === 'named')
    ? addNamed(path, definition.name, definition.source)
    : addDefault(path, definition.source);
  ctx.hooks.set(target, newID);
  return newID;
}
